import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Hotkey } from './contracts';

export type NativeStatus = { inputMonitoring: boolean; accessibility: boolean; eventTapActive: boolean; suppressesFn?: boolean };
export type FocusTarget = { targetPid?: number; targetApp?: string; focusId?: string; secure?: boolean; focusError?: string };

const actionErrors: Record<string, string> = {
  clipboard_changed: 'Your clipboard changed. Copy the transcript from History to paste it.',
  clipboard_write_failed: 'Couldn’t copy the transcript. Your previous clipboard was preserved where possible.',
  clipboard_snapshot_unavailable: 'Couldn’t safely preserve your clipboard. Copy the transcript from History.',
  accessibility_required: 'Allow qqdict in Accessibility to paste automatically.',
  focus_changed: 'The focused app or field changed. Your transcript is available in History.',
  focus_expired: 'The original field is no longer available. Copy the transcript from History.',
  focus_required: 'Click a text field before dictating. Your transcript is available in History.',
  no_focused_app: 'Click a text field before dictating.',
  no_focused_field: 'This field does not support automatic paste. Copy the transcript from History.',
  secure_field: 'Protected fields do not support automatic paste. Copy the transcript from History.',
  modifier_held: 'Release the shortcut before pasting. Your transcript is available in History.',
  paste_unavailable: 'Install wtype and wl-clipboard (or run ydotoold) to paste automatically. Your transcript is available in History.',
  clipboard_unavailable: 'Install wl-clipboard to paste automatically. Your transcript is available in History.',
};

export function bridgeErrorMessage(code: string | undefined): string | undefined {
  return code === undefined ? undefined : actionErrors[code];
}

type BridgeOptions = { args?: string[]; env?: NodeJS.ProcessEnv; system?: string };

/** Newline-delimited JSON client for the platform helper (Swift on macOS, Node on Linux). */
export class NativeBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  permissions: NativeStatus = { inputMonitoring: false, accessibility: false, eventTapActive: false };
  private readonly system: string;
  constructor(private binary: string, private options: BridgeOptions = {}) { super(); this.system = options.system ?? 'macOS'; }

  start(): void {
    if (this.child) return;
    const child = spawn(this.binary, this.options.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'], env: this.options.env });
    this.child = child;
    child.stderr.on('data', () => {});
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (this.child !== child) return;
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      if (!event || typeof event !== 'object') return;
      if (event.type === 'response' && typeof event.id === 'number') {
        const pending = this.pending.get(event.id);
        if (!pending) return;
        this.pending.delete(event.id);
        clearTimeout(pending.timer);

        if (event.ok === false) pending.reject(new Error(actionErrors[event.error] ?? event.message ?? `The ${this.system} action was not available.`));
        else pending.resolve(event);
      } else if (event.type === 'permissions') {
        this.permissions = event;
        this.emit('permissions', event);
      } else if (event.type === 'hotkey') this.emit('hotkey', event);
      else if (event.type === 'cancel') this.emit('cancel');
    });
    const failed = () => {
      if (this.child !== child) return;
      this.child = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`The ${this.system} hotkey helper stopped. Restart qqdict.`));
      }
      this.pending.clear();
      this.permissions = { inputMonitoring: false, accessibility: false, eventTapActive: false };
      this.emit('permissions', this.permissions);
    };
    child.once('error', failed);
    child.once('exit', failed);
  }

  request<T = Record<string, any>>(command: string, fields: Record<string, unknown> = {}): Promise<T> {
    if (!this.child || this.child.killed) return Promise.reject(new Error(`The ${this.system} helper is unavailable.`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.system} did not respond to the requested action.`)); }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, command, ...fields }) + '\n');
    });
  }

  async setHotkey(hotkey: Hotkey): Promise<void> { await this.request('setHotkey', { hotkey }); }
  async captureFocus(): Promise<FocusTarget> { return this.request('captureFocus'); }
  dispose(): void {
    const child = this.child;
    this.child = null;
    child?.kill();

    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(`${this.system} helper closed.`)); }
    this.pending.clear();
  }
}
