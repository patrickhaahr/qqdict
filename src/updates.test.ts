import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import type { MessageBoxOptions } from 'electron';
import { AppUpdater, UPDATE_CHECK_INTERVAL_MS, UPDATE_STARTUP_DELAY_MS, updateAvailability } from './updates';

class NativeUpdater extends EventEmitter {
  feeds: string[] = [];
  checks = 0;
  installs = 0;
  checkError = false;
  setFeedURL({ url }: { url: string }) { this.feeds.push(url); }
  checkForUpdates() { this.checks++; if (this.checkError) throw new Error('Network unavailable'); }
  quitAndInstall() { this.installs++; }
  downloaded() { this.emit('update-downloaded', {}, 'Release notes', 'qqdict v0.5.6'); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture(options: {
  disabled?: boolean; busy?: boolean; response?: Promise<number>; prepareInstall?: () => Promise<void>;
} = {}) {
  const native = new NativeUpdater();
  const messages: MessageBoxOptions[] = [];
  let busy = options.busy ?? false;
  let saves = 0;
  const updater = new AppUpdater({
    availability: options.disabled ? { reason: 'Nightly does not receive stable updates.' } : { feedURL: 'https://example.com/feed' },
    updater: native, isBusy: () => busy,
    prepareInstall: async () => { saves++; await options.prepareInstall?.(); },
    showMessage: (message) => { messages.push(message); return options.response ?? Promise.resolve(1); },
    onChange() {},
  });
  updater.start();
  return { native, updater, messages, setBusy(value: boolean) { busy = value; }, get saves() { return saves; } };
}

test('stable feed selects the running architecture and rejects other builds', () => {
  const bundleId = 'io.github.qwertyu-alex.qqdict';
  const version = '0.5.5';
  const build = {
    isPackaged: true, channel: 'production', platform: 'darwin', arch: 'arm64', version, bundleId,
    inApplicationsFolder: true, configuration: { enabled: true, arch: 'arm64', version, bundleId },
  };
  for (const arch of ['arm64', 'x64']) {
    assert.equal(updateAvailability({ ...build, arch, configuration: { ...build.configuration, arch } }).feedURL,
      `https://update.electronjs.org/qwertyu-alex/qqdict/darwin-${arch}/0.5.5`);
  }
  for (const overrides of [
    { channel: 'nightly' }, { isPackaged: false }, { platform: 'linux' }, { arch: 'ia32' },
    { inApplicationsFolder: false }, { configuration: undefined }, { configuration: { enabled: false } },
    { configuration: { ...build.configuration, version: '0.5.4' } },
    { configuration: { ...build.configuration, arch: 'x64' } },
    { configuration: { ...build.configuration, bundleId: `${bundleId}.nightly` } },
    { version: '0.5.6-beta.1', configuration: { ...build.configuration, version: '0.5.6-beta.1' } },
  ]) assert.equal(updateAvailability({ ...build, ...overrides }).feedURL, undefined, JSON.stringify(overrides));
});

test('checks after launch and hourly, and stops scheduling on quit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { updater, native } = fixture();
  assert.equal(native.checks, 0);
  t.mock.timers.tick(UPDATE_STARTUP_DELAY_MS);
  assert.equal(native.checks, 1);
  native.emit('update-not-available');
  t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS);
  assert.equal(native.checks, 2);
  updater.dispose();
  t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS * 2);
  assert.equal(native.checks, 2);
  assert.equal(native.listenerCount('update-downloaded'), 0);
  assert.doesNotThrow(() => native.emit('error', new Error('Late native shutdown error')));
});

test('disabled builds never contact the service, even on a manual check', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { updater, native, messages } = fixture({ disabled: true });
  t.after(() => updater.dispose());
  t.mock.timers.tick(UPDATE_CHECK_INTERVAL_MS * 2);
  updater.check(true);
  assert.equal(native.checks, 0);
  assert.equal(native.feeds.length, 0);
  assert.equal(messages[0]?.message, 'Automatic updates are unavailable');
});

test('coalesces manual, scheduled, and wake checks throughout a download', (t) => {
  const { updater, native, messages } = fixture();
  t.after(() => updater.dispose());
  updater.check();
  updater.check(true);
  updater.check();
  assert.equal(native.checks, 1);
  native.emit('update-available');
  updater.check(true);
  assert.equal(native.checks, 1);
  assert.equal(updater.menuItem.enabled, false);
  assert.equal(updater.status.phase, 'downloading');
  assert.equal(messages.length, 0);
});

test('manual checks report no update while background checks stay quiet', (t) => {
  const { updater, native, messages } = fixture();
  t.after(() => updater.dispose());
  updater.check();
  native.emit('update-not-available');
  assert.equal(messages.length, 0);
  updater.check(true);
  native.emit('update-not-available');
  assert.equal(messages[0]?.message, 'qqdict is up to date');
});

test('offline checks fail quietly in the background and can be retried manually', (t) => {
  const { updater, native, messages } = fixture();
  t.after(() => updater.dispose());
  native.checkError = true;
  updater.check();
  assert.equal(updater.status.phase, 'error');
  assert.equal(messages.length, 0);
  updater.check(true);
  assert.equal(messages[0]?.message, 'Couldn’t check for updates');
  native.checkError = false;
  updater.check(true);
  native.emit('update-not-available');
  assert.equal(updater.status.phase, 'idle');
});

test('asynchronous download failures re-enable checking without an automatic dialog', (t) => {
  const { updater, native, messages } = fixture();
  t.after(() => updater.dispose());
  updater.check();
  native.emit('update-available');
  native.emit('error', new Error('Download failed'));
  assert.equal(updater.status.phase, 'error');
  assert.equal(updater.menuItem.enabled, true);
  assert.equal(messages.length, 0);
  updater.check();
  assert.equal(native.checks, 2);
});

test('defers the ready prompt while busy and Later leaves the update staged', async (t) => {
  const { updater, native, messages, setBusy } = fixture({ busy: true });
  t.after(() => updater.dispose());
  native.downloaded();
  updater.activityChanged();
  assert.equal(messages.length, 0);
  assert.equal(updater.menuItem.label, 'Restart to update…');
  setBusy(false);
  updater.activityChanged();
  await setImmediate();
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.defaultId, 1);
  assert.equal(messages[0]?.cancelId, 1);
  assert.equal(native.installs, 0);
  assert.equal(updater.restartPending, false);
  updater.activityChanged();
  updater.check();
  assert.equal(messages.length, 1, 'Later is respected for the rest of this session');
  assert.equal(native.checks, 0, 'a staged update is never downloaded twice');
});

test('a new take started during the dialog defers restart until saving and cleanup finish', async (t) => {
  const response = deferred<number>();
  const saved = deferred<void>();
  const { updater, native, messages, setBusy } = fixture({ response: response.promise, prepareInstall: () => saved.promise });
  t.after(() => updater.dispose());
  native.downloaded();
  assert.equal(messages.length, 1);
  setBusy(true);
  response.resolve(0);
  await setImmediate();
  assert.equal(updater.status.phase, 'waiting');
  assert.equal(updater.restartPending, true);
  assert.equal(native.installs, 0);
  setBusy(false);
  updater.activityChanged();
  assert.equal(updater.status.phase, 'installing');
  assert.equal(native.installs, 0, 'pending disk writes complete before restarting');
  updater.requestInstall();
  saved.resolve();
  await setImmediate();
  assert.equal(native.installs, 1);
});

test('a failed history save keeps the app open and allows the user to retry', async (t) => {
  let saveFails = true;
  const f = fixture({ busy: true, prepareInstall: async () => { if (saveFails) throw new Error('Disk full'); } });
  t.after(() => f.updater.dispose());
  f.native.downloaded();
  f.updater.requestInstall();
  f.setBusy(false);
  f.updater.activityChanged();
  await setImmediate();
  assert.equal(f.updater.status.phase, 'ready');
  assert.equal(f.updater.restartPending, false);
  assert.equal(f.native.installs, 0);
  assert.equal(f.messages[0]?.message, 'Couldn’t restart to update');
  saveFails = false;
  f.updater.check(true);
  await setImmediate();
  assert.equal(f.native.installs, 1);
  assert.equal(f.saves, 2);
});

test('locking during the final save postpones installation until unlock', async (t) => {
  const saved = deferred<void>();
  const f = fixture({ busy: true, prepareInstall: () => saved.promise });
  t.after(() => f.updater.dispose());
  f.native.downloaded();
  f.setBusy(false);
  f.updater.requestInstall();
  f.setBusy(true);
  saved.resolve();
  await setImmediate();
  assert.equal(f.native.installs, 0);
  assert.equal(f.updater.status.phase, 'waiting');
  f.setBusy(false);
  f.updater.activityChanged();
  await setImmediate();
  assert.equal(f.native.installs, 1);
});

test('quitting with a dialog open cancels its later restart response', async () => {
  const response = deferred<number>();
  const { updater, native } = fixture({ response: response.promise });
  native.downloaded();
  updater.dispose();
  response.resolve(0);
  await setImmediate();
  assert.equal(native.installs, 0);
});

test('a native installation failure leaves a retry action and reports the error', async (t) => {
  const f = fixture({ busy: true });
  t.after(() => f.updater.dispose());
  f.native.downloaded();
  f.setBusy(false);
  f.updater.requestInstall();
  await setImmediate();
  f.native.emit('error', new Error('Installer failed'));
  assert.equal(f.updater.status.phase, 'ready');
  assert.equal(f.updater.restartPending, false);
  assert.equal(f.messages[0]?.message, 'Couldn’t install the update');
});
