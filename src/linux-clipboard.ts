import { spawn } from 'node:child_process';
import { run } from './linux-desktop';

export type ClipboardBackend = {
  types(): Promise<string[]>;
  /** Resolves null when the representation exceeds `maximumBytes`. */
  read(type: string, maximumBytes: number): Promise<Buffer | null>;
  write(type: string, data: Buffer): Promise<void>;
  clear(): Promise<void>;
};

/** A staged transcript either has a restore token or a concrete failure. */
export type ClipboardStage =
  | { ok: true; changeCount: number; restoreAvailable: true }
  | { ok: false; error: 'clipboard_snapshot_unavailable' | 'clipboard_write_failed' | 'clipboard_changed'; restoreAvailable?: false; restored?: false };

/** Whether the previous clipboard was restored or deliberately left alone. */
export type ClipboardRestore =
  | { ok: true; restored: true }
  | { ok: true; restored: false; reason: 'clipboard_changed' | 'snapshot_unavailable' }
  | { ok: false; restored: false };

const TEXT_TYPE = 'text/plain;charset=utf-8';
const TEXT_TYPES = [TEXT_TYPE, 'text/plain', 'UTF8_STRING', 'STRING', 'TEXT'];

/**
 * wl-copy can offer one representation, so the snapshot keeps the richest one:
 * an image, otherwise text, otherwise whatever the source offered first.
 */
export function preferredType(types: string[]): string | undefined {
  return types.find((type) => type === 'image/png') ?? types.find((type) => type.startsWith('image/'))
    ?? TEXT_TYPES.find((type) => types.includes(type)) ?? types[0];
}

// wl-copy forks a server that keeps any inherited pipes open, so wait for the
// foreground process to exit instead of for its output to close.
function wlCopy(args: string[], data?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('wl-copy', args, { stdio: [data ? 'pipe' : 'ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('wl-copy timed out.')); }, 1500);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);

      if (code === 0) resolve(); else reject(new Error(`wl-copy exited with ${code}.`));
    });
    child.stdin?.end(data);
  });
}

export const wlClipboard: ClipboardBackend = {
  async types() {
    try { return (await run('wl-paste', ['--list-types'])).toString('utf8').split('\n').filter(Boolean); }
    catch { return []; /* wl-paste fails when nothing is copied. */ }
  },
  async read(type, maximumBytes) {
    try { return await run('wl-paste', ['--no-newline', '--type', type], undefined, maximumBytes); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return null;
      throw error;
    }
  },
  write: (type, data) => wlCopy(['--type', TEXT_TYPES.includes(type) ? TEXT_TYPE : type], data),
  clear: () => wlCopy(['--clear']),
};

type Snapshot = { type: string; data: Buffer } | null;

/**
 * Linux has no clipboard change counter, so ownership means "the clipboard
 * still holds the staged transcript". The version is local to this session.
 */
export class ClipboardSession {
  private saved: Snapshot | undefined;
  private stagedText: string | undefined;
  private stagedVersion: number | undefined;
  private version = 0;

  constructor(private backend: ClipboardBackend = wlClipboard, private maximumBytes = 16 * 1024 * 1024) {}

  get changeCount(): number { return this.version; }

  async stage(text: string): Promise<ClipboardStage> {
    const types = await this.backend.types();
    let snapshot: Snapshot = null;
    const type = preferredType(types);

    if (type) {
      const data = await this.backend.read(type, this.maximumBytes).catch(() => null);

      // Never replace a clipboard we cannot put back.
      if (!data) return { ok: false, error: 'clipboard_snapshot_unavailable', restoreAvailable: false };
      snapshot = { type, data };
    }

    try { await this.backend.write(TEXT_TYPE, Buffer.from(text, 'utf8')); }
    catch { return { ok: false, error: 'clipboard_write_failed', restored: false }; }

    if (!await this.holds(text)) return { ok: false, error: 'clipboard_changed' };
    this.saved = snapshot;
    this.stagedText = text;
    this.stagedVersion = ++this.version;

    return { ok: true, changeCount: this.stagedVersion, restoreAvailable: true };
  }

  async hasStagedVersion(changeCount: number): Promise<boolean> {
    return this.stagedVersion === changeCount && this.stagedText !== undefined && await this.holds(this.stagedText);
  }

  async restore(changeCount: number): Promise<ClipboardRestore> {
    const snapshot = this.saved, expectedVersion = this.stagedVersion, text = this.stagedText;
    this.saved = undefined;
    this.stagedVersion = undefined;
    this.stagedText = undefined;

    if (expectedVersion !== changeCount || text === undefined || !await this.holds(text)) {
      return { ok: true, restored: false, reason: 'clipboard_changed' };
    }

    if (snapshot === undefined) return { ok: true, restored: false, reason: 'snapshot_unavailable' };

    try {
      if (snapshot) await this.backend.write(snapshot.type, snapshot.data);
      else await this.backend.clear();

      return { ok: true, restored: true };
    } catch {
      return { ok: false, restored: false };
    }
  }

  private async holds(text: string): Promise<boolean> {
    // Poll briefly: wl-copy hands the selection to a background process.
    for (let attempt = 0; attempt < 5; attempt++) {
      const types = await this.backend.types();

      if (types.includes(TEXT_TYPE)) {
        const current = await this.backend.read(TEXT_TYPE, Buffer.byteLength(text) + 1).catch(() => null);

        if (current?.toString('utf8') === text) return true;
      }

      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 40));
    }

    return false;
  }
}
