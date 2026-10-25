import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { autostartFile, desktopEntry, readAutostart, writeAutostart } from './autostart';
import { LinuxBridge } from './linux-bridge';
import { ClipboardSession, preferredType, type ClipboardBackend } from './linux-clipboard';
import { isTerminal, parseHyprlandWindow, parseNiriWindow, parseSwayTree } from './linux-desktop';
import { decodeInputEvents, HoldHotkeyState, KEY, parseKeyboards } from './linux-input';

const KEY_A = 30, KEY_C = 46;

// Formats a /proc/bus/input/devices bitmap: hex longs, most significant first.
function bitmap(codes: number[], wordBits = 64): string {
  const words: bigint[] = [];
  for (const code of codes) {
    const index = Math.floor(code / wordBits);
    while (words.length <= index) words.push(0n);
    words[index] |= 1n << BigInt(code % wordBits);
  }
  return words.reverse().map((word) => word.toString(16)).join(' ');
}

function device(name: string, handlers: string, ev: string, keys: number[], wordBits = 64): string {
  return [`I: Bus=0003 Vendor=0001 Product=0001 Version=0100`, `N: Name="${name}"`, `H: Handlers=${handlers} `, `B: EV=${ev}`, `B: KEY=${bitmap(keys, wordBits)}`].join('\n');
}

function inputEvent(type: number, code: number, value: number): Buffer {
  const event = Buffer.alloc(24);
  event.writeUInt16LE(type, 16);
  event.writeUInt16LE(code, 18);
  event.writeInt32LE(value, 20);
  return event;
}
const key = (code: number, value: number) => Buffer.concat([inputEvent(1, code, value), inputEvent(0, 0, 0)]);

test('keyboards are the kbd devices with a Ctrl or Alt key', () => {
  const devices = [
    device('Mouse', 'mouse0 event0', '17', [272, 273]),
    device('Power Button', 'kbd event1', '3', [116]),
    device('Keyboard', 'sysrq kbd leds event2', '120013', [KEY.LEFTCTRL, KEY_A, KEY.RIGHTCTRL, KEY.RIGHTALT]),
    device('No handler', 'kbd', '120013', [KEY.LEFTCTRL]),
  ].join('\n\n');
  assert.deepEqual(parseKeyboards(devices), [{ name: 'Keyboard', event: 'event2' }]);
  assert.deepEqual(parseKeyboards(device('Small', 'kbd event3', '3', [KEY.RIGHTALT], 32), 32), [{ name: 'Small', event: 'event3' }]);
});

test('input records decode keys and dropped events and skip buttons', () => {
  const records = Buffer.concat([key(KEY.RIGHTCTRL, 1), inputEvent(1, 272, 1), inputEvent(0, 3, 0), inputEvent(2, 0, 5)]);
  assert.deepEqual(decodeInputEvents(records), [{ kind: 'key', code: KEY.RIGHTCTRL, value: 1 }, { kind: 'dropped' }]);
  assert.deepEqual(decodeInputEvents(records.subarray(0, 20)), []);
});

test('the hold shortcut cancels once when an ordinary key is pressed', () => {
  const state = new HoldHotkeyState();
  const pressed = new Set<number>();
  const press = (code: number) => { pressed.add(code); return state.update(pressed, { kind: 'key', code, value: 1 }); };
  const lift = (code: number) => { pressed.delete(code); return state.update(pressed, { kind: 'key', code, value: 0 }); };
  assert.equal(press(KEY.RIGHTCTRL), 'down');
  assert.equal(press(KEY.LEFTSHIFT), null);
  assert.equal(press(KEY_C), 'cancel');
  assert.equal(press(KEY_A), null);
  assert.equal(lift(KEY.RIGHTCTRL), 'up');
  state.hotkey = 'ctrl-option';
  assert.equal(press(KEY.LEFTCTRL), null);
  assert.equal(press(KEY.RIGHTALT), 'down');
  assert.equal(state.release(), 'up');
  assert.equal(state.release(), null);
});

test('window-manager replies parse to the focused window', () => {
  assert.deepEqual(parseNiriWindow({ id: 8, pid: 42, app_id: 'foot' }), { id: '8', pid: 42, appId: 'foot' });
  assert.equal(parseNiriWindow(null), null);
  assert.deepEqual(parseHyprlandWindow({ address: '0x1', pid: 7, class: 'kitty' }), { id: '0x1', pid: 7, appId: 'kitty' });
  assert.equal(parseHyprlandWindow({ address: '' }), null);
  const tree = { id: 1, type: 'root', nodes: [{ id: 2, type: 'workspace', nodes: [{ id: 3, type: 'con', focused: false }], floating_nodes: [{ id: 4, type: 'floating_con', focused: true, pid: 9, window_properties: { class: 'Firefox' } }] }] };
  assert.deepEqual(parseSwayTree(tree), { id: '4', pid: 9, appId: 'Firefox' });
});

test('terminals are recognised by app id', () => {
  for (const appId of ['foot', 'kitty', 'Alacritty', 'com.mitchellh.ghostty', 'org.wezfurlong.wezterm', 'org.gnome.Console']) assert.ok(isTerminal(appId), appId);
  for (const appId of ['firefox', 'code', 'org.gnome.Nautilus', 'steam', undefined]) assert.ok(!isTerminal(appId), String(appId));
});

function memoryClipboard(initial?: { type: string; data: string }) {
  let content: { type: string; data: Buffer } | null = initial ? { type: initial.type, data: Buffer.from(initial.data) } : null;
  const backend: ClipboardBackend = {
    types: async () => content ? (content.type === 'text/plain;charset=utf-8' ? [content.type, 'text/plain'] : [content.type]) : [],
    read: async (type, maximumBytes) => {
      if (!content || content.type !== type) throw new Error('missing type');
      return content.data.length > maximumBytes ? null : content.data;
    },
    write: async (type, data) => { content = { type, data }; },
    clear: async () => { content = null; },
  };
  return { backend, current: () => content, copy: (text: string) => { content = { type: 'text/plain;charset=utf-8', data: Buffer.from(text) }; } };
}

test('the clipboard snapshot prefers images, then text', () => {
  assert.equal(preferredType(['text/plain', 'image/jpeg', 'image/png']), 'image/png');
  assert.equal(preferredType(['text/html', 'UTF8_STRING']), 'UTF8_STRING');
  assert.equal(preferredType(['application/x-custom']), 'application/x-custom');
  assert.equal(preferredType([]), undefined);
});

test('a staged transcript is restored to the previous image', async () => {
  const clipboard = memoryClipboard({ type: 'image/png', data: 'png-bytes' });
  const session = new ClipboardSession(clipboard.backend);
  const staged = await session.stage('hello world');
  assert.equal(staged.ok, true);
  assert.equal(await session.hasStagedVersion(staged.changeCount as number), true);
  assert.deepEqual(await session.restore(staged.changeCount as number), { ok: true, restored: true });
  assert.equal(clipboard.current()?.type, 'image/png');
  assert.equal(clipboard.current()?.data.toString(), 'png-bytes');
});

test('an empty clipboard is cleared again and a user copy is never overwritten', async () => {
  const empty = memoryClipboard();
  const session = new ClipboardSession(empty.backend);
  const staged = await session.stage('one');
  assert.deepEqual(await session.restore(staged.changeCount as number), { ok: true, restored: true });
  assert.equal(empty.current(), null);

  const copied = memoryClipboard({ type: 'text/plain;charset=utf-8', data: 'before' });
  const second = new ClipboardSession(copied.backend);
  const take = await second.stage('two');
  copied.copy('the user copied this');
  assert.equal(await second.hasStagedVersion(take.changeCount as number), false);
  assert.deepEqual(await second.restore(take.changeCount as number), { ok: true, restored: false, reason: 'clipboard_changed' });
  assert.equal(copied.current()?.data.toString(), 'the user copied this');
});

test('a clipboard too large to snapshot is left alone', async () => {
  const clipboard = memoryClipboard({ type: 'image/png', data: 'x'.repeat(64) });
  const result = await new ClipboardSession(clipboard.backend, 16).stage('hello');
  assert.equal(result.error, 'clipboard_snapshot_unavailable');
  assert.equal(clipboard.current()?.type, 'image/png');
});

test('autostart entries quote the launcher and respect disabled entries', async () => {
  const desktopName = process.env.QQDICT_CHANNEL === 'production' ? 'qqdict' : 'qqdict-nightly';
  assert.equal(autostartFile({ XDG_CONFIG_HOME: '/tmp/config' }), `/tmp/config/autostart/${desktopName}.desktop`);
  assert.match(desktopEntry('/nix/store/abc-qqdict/bin/qqdict'), /^Exec=\/nix\/store\/abc-qqdict\/bin\/qqdict --autostart$/m);
  assert.match(desktopEntry('/home/me/My Apps/qqdict'), /^Exec="\/home\/me\/My Apps\/qqdict" --autostart$/m);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'qqdict-autostart-'));
  try {
    const file = path.join(directory, 'autostart', 'qqdict.desktop');
    assert.equal(await readAutostart(file), false);
    await writeAutostart('/usr/bin/qqdict', file);
    assert.equal(await readAutostart(file), true);
    await writeFile(file, `${await readFile(file, 'utf8')}Hidden=true\n`);
    assert.equal(await readAutostart(file), false);
    await writeAutostart(undefined, file);
    assert.equal(await readAutostart(file), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the helper turns device key events into hotkey and cancel events', { skip: process.platform !== 'linux' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qqdict-input-'));
  const events: Record<string, unknown>[] = [];
  const bridge = new LinuxBridge((event) => { events.push(event); }, {
    devicesFile: path.join(directory, 'devices'), inputDirectory: directory, env: {},
  });
  const until = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await delay(20);
    assert.ok(predicate(), JSON.stringify(events));
  };
  try {
    await writeFile(path.join(directory, 'devices'), device('Keyboard', 'kbd event5', '120013', [KEY.LEFTCTRL, KEY_A, KEY.RIGHTCTRL]));
    execFileSync('mkfifo', [path.join(directory, 'event5')]);
    await bridge.start();
    const permissions = events.find((event) => event.type === 'permissions');
    assert.equal(permissions?.inputMonitoring, true);
    assert.equal(permissions?.eventTapActive, true);
    assert.equal(permissions?.windowManager, null);

    const writer = await open(path.join(directory, 'event5'), 'w');
    await writer.write(key(KEY.RIGHTCTRL, 1));
    await until(() => events.some((event) => event.type === 'hotkey' && event.phase === 'down'));
    await writer.write(key(KEY_C, 1));
    await until(() => events.some((event) => event.type === 'cancel'));
    await writer.write(key(KEY.RIGHTCTRL, 0));
    await until(() => events.some((event) => event.type === 'hotkey' && event.phase === 'up'));

    await writer.write(key(KEY.RIGHTCTRL, 1));
    await until(() => events.filter((event) => event.type === 'hotkey' && event.phase === 'down').length === 2);
    // A keyboard that disappears mid-take must end the recording.
    await writer.close();
    await until(() => events.filter((event) => event.type === 'hotkey' && event.phase === 'up').length === 2);
    assert.equal(events.filter((event) => event.type === 'hotkey').at(-1)?.reason, 'device_removed');
  } finally {
    bridge.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
