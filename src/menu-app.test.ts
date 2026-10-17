import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';
import test from 'node:test';
import { transform } from 'esbuild';
import type { AppEvent } from './contracts';
import type { FocusTarget } from './native';
import { AppUpdater } from './updates';

const menuCode = readFile('src/menu-app.ts', 'utf8').then((source) => transform(source, { loader: 'ts', format: 'cjs' }));
const nodeRequire = createRequire(`${process.cwd()}/package.json`);

async function menuFixture(options: { pasteCleanup?: Promise<void>; settingsCleanup?: Promise<void> } = {}) {
  let resolveFocus!: (target: FocusTarget) => void;
  const focus = new Promise<FocusTarget>((resolve) => { resolveFocus = resolve; });
  const events: AppEvent[] = [];
  const discarded: string[] = [];
  const pasted: FocusTarget[] = [];
  const listeners = new Map<string, (...args: any[]) => void>();
  const nativeUpdates = Object.assign(new EventEmitter(), {
    installs: 0,
    setFeedURL() {}, checkForUpdates() {},
    quitAndInstall() { this.installs++; nativeUpdates.emit('before-quit-for-update'); },
  });
  const contents = { send: (_channel: string, event: AppEvent) => events.push(event) };
  const dependencies: Record<string, unknown> = {
    electron: {
      app: { setName() {}, setPath() {}, getPath: () => '/tmp/qqdict-test', requestSingleInstanceLock: () => false, quit() {}, on() {} },
      autoUpdater: nativeUpdates,
      ipcMain: { handle: (name: string, callback: (...args: any[]) => void) => listeners.set(name, callback),
        on: (name: string, callback: (...args: any[]) => void) => listeners.set(name, callback) },
    },
    './harness': { CodexHarness: class {} },
    './transport': { DictationTransport: class { cancel() {} }, safeMessage: String },
    './native': {}, './store': {}, './island-position': {}, './storage': {},
    './updates': {},
    './product': { PRODUCT_NAME: 'qqdict-test', BUILD_IDENTITY: { journalDirectory: 'Dictation Test' } },
    './paste': { pasteTranscript: async (_bridge: unknown, _text: string, target: FocusTarget) => { pasted.push(target); await options.pasteCleanup; } },
  };
  const context = vm.createContext({
    require: (id: string) => id.startsWith('node:') ? nodeRequire(id) : dependencies[id],
    module: { exports: {} }, exports: {}, AbortController, Buffer, setTimeout, clearTimeout,
    fixture: {
      contents,
      bridge: {
        captureFocus: () => focus,
        setHotkey: () => options.settingsCleanup ?? Promise.resolve(),
        request: async (command: string, fields: { focusId: string }) => { if (command === 'discardFocus') discarded.push(fields.focusId); },
      },
      store: {
        settings: { hotkey: 'fn', microphoneId: '', launchAtLogin: false },
        history: [] as { id: string; text: string }[],
        async updateSettings(settings: object) { Object.assign(this.settings, settings); },
        async addTranscript(text: string) { const entry = { id: 'entry', text }; this.history.unshift(entry); return entry; },
        async updateTranscript() {},
        async flush() {},
      },
    },
  });
  vm.runInContext((await menuCode).code, context);
  vm.runInContext(`
    recorderReady = true;
    state.connected = true;
    state.permissions.microphone = 'granted';
    recorder = { webContents: fixture.contents, isDestroyed: () => false };
    bridge = fixture.bridge;
    store = fixture.store;
    bindIPC();
  `, context);
  let updater: AppUpdater | undefined;
  return {
    events, discarded, pasted, resolveFocus,
    begin: () => vm.runInContext('begin(false)', context) as Promise<void>,
    end: () => vm.runInContext('end()', context),
    cancel: () => vm.runInContext('cancel()', context),
    finalize: () => vm.runInContext("finalize('First words', take)", context) as Promise<void>,
    get phase() { return vm.runInContext('state.phase', context) as string; },
    get microphoneName() { return vm.runInContext('state.microphoneName', context) as string; },
    get quitting() { return vm.runInContext('quitting', context) as boolean; },
    nativeUpdates,
    enableUpdates() {
      updater = new AppUpdater({
        availability: { feedURL: 'https://example.com/feed' }, updater: nativeUpdates,
        isBusy: () => vm.runInContext('updateBusy()', context) as boolean,
        prepareInstall: async () => {}, showMessage: async () => 1, onChange() {},
      });
      context.fixture.updates = updater;
      vm.runInContext('updates = fixture.updates', context);
      updater.start();
      return updater;
    },
    changeSettings: () => listeners.get('dictation:settings')!({ sender: contents }, { hotkey: 'right-option' }),
    capture: (id: number, sender: unknown = contents, microphone: unknown = 'MacBook Pro Microphone') => listeners.get('dictation:capturing')!({ sender }, id, microphone),
    serverReady: () => vm.runInContext("handleTransport({ type: 'status', status: 'recording' })", context),
    cleanup: () => { updater?.dispose(); vm.runInContext('if (fadeTimer) clearTimeout(fadeTimer)', context); },
  };
}

test('starts and stops capture while the original focus check is still pending', async (t) => {
  const fixture = await menuFixture();
  t.after(fixture.cleanup);
  await fixture.begin();
  assert.equal(fixture.events.filter(event => event.type === 'command' && event.command === 'start').length, 1);
  fixture.end();
  assert.equal(fixture.events.filter(event => event.type === 'command' && event.command === 'stop').length, 1);
  const finishing = fixture.finalize();
  await setImmediate();
  assert.equal(fixture.pasted.length, 0, 'pasting still waits for the original field');
  fixture.resolveFocus({ focusId: 'original-field', targetPid: 123 });
  await finishing;
  assert.equal(fixture.pasted[0]?.focusId, 'original-field');
});

test('discards a late focus snapshot after cancellation', async (t) => {
  const fixture = await menuFixture();
  t.after(fixture.cleanup);
  await fixture.begin();
  fixture.cancel();
  fixture.resolveFocus({ focusId: 'cancelled-field', targetPid: 123 });
  await setImmediate();
  assert.deepEqual(fixture.discarded, ['cancelled-field']);
  assert.deepEqual(fixture.pasted, []);
});

test('Listening follows local capture, with stale and post-release notifications ignored', async (t) => {
  const fixture = await menuFixture();
  t.after(fixture.cleanup);
  await fixture.begin();
  fixture.serverReady();
  assert.equal(fixture.phase, 'starting');
  fixture.capture(1, {}, 'Foreign Microphone');
  fixture.capture(2, undefined, 'Stale Microphone');
  assert.equal(fixture.phase, 'starting');
  assert.equal(fixture.microphoneName, '');
  fixture.capture(1);
  assert.equal(fixture.phase, 'recording');
  assert.equal(fixture.microphoneName, 'MacBook Pro Microphone');
  fixture.end();
  fixture.capture(1, undefined, 'Late Microphone');
  assert.equal(fixture.phase, 'transcribing');
  assert.equal(fixture.microphoneName, 'MacBook Pro Microphone');
});

test('the next take forgets the previous microphone and ignores a non-string name', async (t) => {
  const fixture = await menuFixture();
  t.after(fixture.cleanup);
  await fixture.begin();
  fixture.capture(1);
  fixture.cancel();
  await fixture.begin();
  assert.equal(fixture.microphoneName, '');
  fixture.capture(2, undefined, { name: 'Not a string' });
  assert.equal(fixture.phase, 'recording');
  assert.equal(fixture.microphoneName, '');
});

test('an update waits for cancelled paste cleanup and prevents a new take while restart is pending', async (t) => {
  let finishClipboardRestore!: () => void;
  const pasteCleanup = new Promise<void>((resolve) => { finishClipboardRestore = resolve; });
  const fixture = await menuFixture({ pasteCleanup });
  t.after(fixture.cleanup);
  await fixture.begin();
  fixture.resolveFocus({ focusId: 'original-field', targetPid: 123 });
  const finishing = fixture.finalize();
  await setImmediate();
  assert.equal(fixture.pasted.length, 1);
  const updater = fixture.enableUpdates();
  fixture.nativeUpdates.emit('update-downloaded', {}, '', 'qqdict v0.5.6');
  updater.requestInstall();
  fixture.cancel();
  await fixture.begin();
  await setImmediate();
  assert.equal(fixture.nativeUpdates.installs, 0);
  assert.equal(fixture.events.filter(event => event.type === 'command' && event.command === 'start').length, 1);
  finishClipboardRestore();
  await finishing;
  await setImmediate();
  assert.equal(fixture.nativeUpdates.installs, 1);
  assert.equal(fixture.quitting, true, 'updater allows Settings to close before app.before-quit');
});

test('an update waits for a settings change already being applied to macOS', async (t) => {
  let finishSettings!: () => void;
  const settingsCleanup = new Promise<void>((resolve) => { finishSettings = resolve; });
  const fixture = await menuFixture({ settingsCleanup });
  t.after(fixture.cleanup);
  const updater = fixture.enableUpdates();
  const changing = fixture.changeSettings();
  await setImmediate();
  fixture.nativeUpdates.emit('update-downloaded', {}, '', 'qqdict v0.5.6');
  updater.requestInstall();
  await setImmediate();
  assert.equal(fixture.nativeUpdates.installs, 0);
  finishSettings();
  await changing;
  await setImmediate();
  assert.equal(fixture.nativeUpdates.installs, 1);
});
