import { randomUUID } from 'node:crypto';
import { createReadStream, type ReadStream } from 'node:fs';
import { access, constants, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import type { Hotkey } from './contracts';
import { supportedHotkeys } from './hotkeys';
import { ClipboardSession, type ClipboardRestore, type ClipboardStage } from './linux-clipboard';
import type { FocusTarget, NativeStatus } from './native';
import { detectPasteTool, detectWindowManager, isTerminal, onPath, type DesktopWindow, type PasteTool, type WindowManager } from './linux-desktop';
import { decodeInputEvents, HoldHotkeyState, MODIFIER_KEYS, parseKeyboards } from './linux-input';

// Linux counterpart of native/DictationBridge.swift, speaking the same
// newline-delimited JSON protocol. It reads key events from /dev/input only to
// track the hold shortcut and held modifiers: it keeps the set of currently
// pressed keys and never records or emits typed keys. Clipboard snapshots stay
// in this process and are never logged.

// Only these fields are read from stdin; each is checked before use.
type Command = { id?: unknown; command?: unknown; text?: unknown; changeCount?: unknown; focusId?: unknown; targetPid?: unknown; hotkey?: unknown; pane?: unknown };

type Device = { stream: ReadStream; pressed: Set<number> };

type BridgeOptions = { devicesFile?: string; inputDirectory?: string; env?: NodeJS.ProcessEnv };

type FocusSnapshot = { window: DesktopWindow | null; capturedAt: number };

type Permissions = NativeStatus & { hotkey: Hotkey; hotkeyHeld: boolean; pasteTool: PasteTool['name'] | null; windowManager: string | null; pid: number };

type CapturedFocus = FocusTarget & { ok: true; fieldAvailable: boolean; verified?: boolean };

type PasteResult = { ok: false; error: string } | { ok: true; posted: true; targetPid?: number };

type Response =
  | { ok: true; changeCount?: number; hotkey?: Hotkey; granted?: boolean }
  | { ok: false; error: string; message?: string }
  | (Permissions & { ok: true })
  | CapturedFocus | PasteResult | ClipboardStage | ClipboardRestore;

/** Events and command replies emitted by the Linux helper. */
export type LinuxEvent =
  | { type: 'hotkey'; phase: 'down' | 'up'; hotkey: Hotkey; timestamp: number; reason?: string }
  | { type: 'cancel'; reason: string }
  | ({ type: 'permissions' } & Permissions)
  | ({ type: 'response'; id: unknown } & Response)
  | { type: 'error'; error: string };

const WORD_BYTES = ['x64', 'arm64', 'ppc64', 'riscv64', 's390x', 'loong64', 'mips64el'].includes(process.arch) ? 8 : 4;
const FOCUS_LIFETIME = 10 * 60 * 1000;
const HOTKEYS = supportedHotkeys('linux');

export class LinuxBridge {
  private readonly devices = new Map<string, Device>();
  private readonly hotkey = new HoldHotkeyState();
  private readonly clipboard = new ClipboardSession();
  private readonly focusSnapshots = new Map<string, FocusSnapshot>();
  private readonly windowManager: WindowManager | null;
  private pasteTool: PasteTool | null = null;
  private clipboardAvailable = false;
  private readable = false;
  private keyboardsFound = false;
  private previousPermissionState: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private queue: Promise<void> = Promise.resolve();

  private readonly devicesFile: string;
  private readonly inputDirectory: string;

  constructor(private send: (event: LinuxEvent) => void, { devicesFile = '/proc/bus/input/devices', inputDirectory = '/dev/input', env = process.env }: BridgeOptions = {}) {
    this.devicesFile = devicesFile;
    this.inputDirectory = inputDirectory;
    this.windowManager = detectWindowManager(env);
  }

  async start(): Promise<void> {
    await Promise.all([this.scanDevices(), this.probeTools()]);
    this.emitPermissions(true);
    // Hot-plugged keyboards appear on the next scan.
    this.timer = setInterval(() => { void this.scanDevices().then(() => this.emitPermissions()); }, 2000);
  }

  stop(): void {
    clearInterval(this.timer);

    for (const device of this.devices.values()) device.stream.destroy();
    this.devices.clear();
    this.focusSnapshots.clear();
  }

  handle(command: Command): void {
    // Commands run one at a time, like the macOS helper's main queue.
    this.queue = this.queue.then(() => this.run(command)).catch(() => {});
  }

  private async scanDevices(): Promise<void> {
    let keyboards: ReturnType<typeof parseKeyboards> = [];

    try { keyboards = parseKeyboards(await readFile(this.devicesFile, 'utf8'), WORD_BYTES * 8); } catch { /* No procfs input list. */ }

    this.keyboardsFound = keyboards.length > 0;
    let readable = false;

    for (const keyboard of keyboards) {
      const file = path.join(this.inputDirectory, keyboard.event);

      try { await access(file, constants.R_OK); } catch { continue; }

      readable = true;

      if (!this.devices.has(file)) this.open(file);
    }

    this.readable = readable;
  }

  private open(file: string): void {
    // Blocking reads occupy libuv pool threads; the launcher raises UV_THREADPOOL_SIZE.
    const stream = createReadStream(file, { highWaterMark: (WORD_BYTES * 2 + 8) * 64 });
    const device: Device = { stream, pressed: new Set() };
    this.devices.set(file, device);
    let pending = Buffer.alloc(0);
    stream.on('data', (chunk: Buffer) => {
      const data = Buffer.concat([pending, chunk]);
      const size = WORD_BYTES * 2 + 8;
      const usable = data.length - (data.length % size);
      pending = data.subarray(usable);

      for (const change of decodeInputEvents(data.subarray(0, usable), WORD_BYTES)) {
        if (change.kind === 'dropped') device.pressed.clear();
        else if (change.value === 1) device.pressed.add(change.code);
        else if (change.value === 0) device.pressed.delete(change.code);
        else continue; // Auto-repeat.
        this.updateHotkey(change);
      }
    });

    const closed = () => {
      if (this.devices.get(file) !== device) return;
      this.devices.delete(file);
      // An unplugged keyboard must never leave a recording running.
      this.updateHotkey(undefined, 'device_removed');
      this.emitPermissions();
    };

    stream.once('error', closed);
    stream.once('close', closed);
  }

  private pressed(): Set<number> {
    const pressed = new Set<number>();

    for (const device of this.devices.values()) for (const code of device.pressed) pressed.add(code);

    return pressed;
  }

  private updateHotkey(change?: Parameters<HoldHotkeyState['update']>[1], reason?: string): void {
    const phase = this.hotkey.update(this.pressed(), change);

    if (phase === 'cancel') this.send({ type: 'cancel', reason: 'chord' });
    else if (phase) this.emitHotkey(phase, reason);
  }

  private emitHotkey(phase: 'down' | 'up', reason?: string): void {
    this.send({ type: 'hotkey', phase, hotkey: this.hotkey.hotkey, timestamp: Date.now() / 1000, reason });
  }

  private async probeTools(): Promise<void> {
    const [pasteTool, copy, paste] = await Promise.all([detectPasteTool(), onPath('wl-copy'), onPath('wl-paste')]);
    this.pasteTool = pasteTool;
    this.clipboardAvailable = copy && paste && !!process.env.WAYLAND_DISPLAY;
  }

  private permissions(): Permissions {
    return {
      // "Input Monitoring": a keyboard device is readable (the `input` group).
      inputMonitoring: this.readable || !this.keyboardsFound,
      // "Accessibility": qqdict can stage the clipboard and send the paste key.
      accessibility: !!this.pasteTool && this.clipboardAvailable,
      eventTapActive: this.devices.size > 0,
      hotkey: this.hotkey.hotkey,
      hotkeyHeld: this.hotkey.held,
      pasteTool: this.pasteTool?.name ?? null,
      windowManager: this.windowManager?.name ?? null,
      pid: process.pid,
    };
  }

  private emitPermissions(force = false): void {
    const current = this.permissions();
    const state = `${current.inputMonitoring}|${current.accessibility}|${current.eventTapActive}`;

    if (!force && state === this.previousPermissionState) return;
    this.previousPermissionState = state;
    this.send({ type: 'permissions', ...current });
  }

  private async captureFocus(): Promise<CapturedFocus> {
    const result: CapturedFocus = { ok: true, targetApp: 'Application', secure: false, fieldAvailable: false };

    if (!this.pasteTool) return { ...result, focusError: 'paste_unavailable' };

    if (!this.clipboardAvailable) return { ...result, focusError: 'clipboard_unavailable' };
    let window: DesktopWindow | null = null;

    if (this.windowManager) {
      window = await this.windowManager.focused().catch(() => null);

      if (!window) return { ...result, focusError: 'no_focused_app' };

      // qqdict's own windows have no field to paste into.
      if (window.pid === process.ppid) return { ...result, targetPid: window.pid, focusError: 'no_focused_field' };
    }

    const now = Date.now();

    for (const [id, snapshot] of this.focusSnapshots) if (now - snapshot.capturedAt >= FOCUS_LIFETIME) this.focusSnapshots.delete(id);

    if (this.focusSnapshots.size > 20) this.focusSnapshots.clear();
    const focusId = randomUUID();
    this.focusSnapshots.set(focusId, { window, capturedAt: now });

    // Wayland exposes no field metadata, so the window is the finest target.
    return { ...result, targetPid: window?.pid, targetApp: window?.appId ?? 'Application', fieldAvailable: true, focusId, verified: !!window };
  }

  private async focusMatches(window: DesktopWindow): Promise<boolean> {
    const manager = this.windowManager;

    if (!manager) return false;

    const current = await manager.focused().catch(() => null);

    if (current?.id === window.id) return true;

    // A compositor may focus qqdict's island when it appears. Only then, hand
    // focus back to the window the user was dictating into.
    if (current?.pid !== process.ppid) return false;
    await manager.focus(window.id).catch(() => {});
    await delay(80);

    return (await manager.focused().catch(() => null))?.id === window.id;
  }

  private async paste(command: Command): Promise<PasteResult> {
    const clipboardVersion = command.changeCount;

    if (typeof clipboardVersion !== 'number' || !Number.isInteger(clipboardVersion) || clipboardVersion < 0) return { ok: false, error: 'invalid_clipboard_version' };

    if (!this.pasteTool) return { ok: false, error: 'paste_unavailable' };

    if (typeof command.focusId !== 'string') return { ok: false, error: 'focus_required' };
    const snapshot = this.focusSnapshots.get(command.focusId);
    this.focusSnapshots.delete(command.focusId);

    if (!snapshot || (snapshot.window?.pid !== undefined && command.targetPid !== snapshot.window.pid)) return { ok: false, error: 'focus_required' };

    if (Date.now() - snapshot.capturedAt >= FOCUS_LIFETIME) return { ok: false, error: 'focus_expired' };

    if (snapshot.window && !await this.focusMatches(snapshot.window)) return { ok: false, error: 'focus_changed' };

    if ([...this.pressed()].some((code) => MODIFIER_KEYS.has(code))) return { ok: false, error: 'modifier_held' };

    // Keep this last. Do not paste if a user Copy replaced the transcript.
    if (!await this.clipboard.hasStagedVersion(clipboardVersion)) return { ok: false, error: 'clipboard_changed' };

    try { await this.pasteTool.paste(isTerminal(snapshot.window?.appId)); }
    catch { return { ok: false, error: 'event_creation_failed' }; }

    // Give the recipient a short opportunity to read the clipboard.
    await delay(180);

    return { ok: true, posted: true, targetPid: snapshot.window?.pid };
  }

  private async run(command: Command): Promise<void> {
    const respond = (result: Response) => this.send({ ...result, type: 'response', id: command.id ?? null });

    switch (command.command) {
      case 'status':
        await Promise.all([this.scanDevices(), this.probeTools()]);
        respond({ ok: true, ...this.permissions() });
        this.emitPermissions();

        return;
      case 'captureFocus':
        respond(await this.captureFocus());

        return;
      case 'clipboardVersion':
        respond({ ok: true, changeCount: this.clipboard.changeCount });

        return;
      case 'stageClipboard': {
        const text = command.text;

        if (typeof text !== 'string' || Buffer.byteLength(text) > 1_048_576) {
          respond({ ok: false, error: 'invalid_clipboard_text' });

          return;
        }

        if (!this.clipboardAvailable) {
          respond({ ok: false, error: 'clipboard_unavailable' });

          return;
        }

        respond(await this.clipboard.stage(text));

        return;
      }

      case 'restoreClipboard':
        if (typeof command.changeCount !== 'number') {
          respond({ ok: false, error: 'invalid_clipboard_version' });

          return;
        }

        respond(await this.clipboard.restore(command.changeCount));

        return;
      case 'setHotkey': {
        const hotkey = HOTKEYS.find(hotkey => hotkey === command.hotkey);

        if (!hotkey) {
          respond({ ok: false, error: 'invalid_hotkey' });

          return;
        }

        const phase = this.hotkey.release();

        if (phase) this.emitHotkey(phase, 'hotkey_changed');
        this.hotkey.hotkey = hotkey;
        respond({ ok: true, hotkey });
        this.emitPermissions(true);

        return;
      }

      case 'paste':
        respond(await this.paste(command));

        return;
      case 'requestInputMonitoring':
      case 'requestAccessibility':
        // Linux has no permission prompt; re-check device and tool access.
        await Promise.all([this.scanDevices(), this.probeTools()]);
        respond({ ok: true, granted: command.command === 'requestInputMonitoring' ? this.readable : !!this.pasteTool && this.clipboardAvailable });
        this.emitPermissions(true);

        return;
      case 'openSettings':
        respond(['inputMonitoring', 'accessibility', 'microphone', 'keyboard'].some(pane => pane === command.pane)
          ? { ok: false, error: 'settings_unavailable', message: 'Linux has no settings pane for this permission.' }
          : { ok: false, error: 'invalid_settings_pane' });

        return;
      case 'discardFocus':
        if (typeof command.focusId === 'string') this.focusSnapshots.delete(command.focusId);
        respond({ ok: true });

        return;
      case 'stop':
        respond({ ok: true });
        this.stop();
        exitNow();
      default:
        respond({ ok: false, error: 'unknown_command' });
    }
  }
}

// process.exit() joins libuv's pool, where device reads block until the next
// key event. SIGKILL ends the process without that join, whatever handlers a
// loader installed. Pipe writes to stdout are synchronous on Linux, so
// responses are already sent.
function exitNow(): never {
  process.kill(process.pid, 'SIGKILL');

  return process.exit(0);
}

function main(): void {
  const send = (event: LinuxEvent) => { process.stdout.write(`${JSON.stringify(event)}\n`); };

  // Overrides let the protocol test feed synthetic devices.
  const bridge = new LinuxBridge(send, { devicesFile: process.env.QQDICT_INPUT_DEVICES, inputDirectory: process.env.QQDICT_INPUT_DIRECTORY });
  void bridge.start();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line) return;

    if (line.length > 65_536) {
      send({ type: 'error', error: 'command_too_large' });

      return;
    }

    let command: unknown;

    try { command = JSON.parse(line); } catch {
      send({ type: 'error', error: 'invalid_json_command' });

      return;
    }

    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      send({ type: 'error', error: 'invalid_json_command' });

      return;
    }

    // SAFETY: The envelope is a non-null object; Command keeps its fields
    // unknown and the command handler checks every field before using it.
    bridge.handle(command as Command);
  });
  // Exit with Electron, even while device reads are still blocked.
  lines.on('close', () => { bridge.stop(); exitNow(); });
}

if (require.main === module) main();
