import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DictationStore } from './store';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dictation-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { dataDirectory: path.join(root, 'app-data'), logDirectory: path.join(root, 'Dictation'), timeZone: 'Europe/Copenhagen' };
  const store = new DictationStore(options);
  await store.load();
  return { root, options, store };
}

test('monthly log rollover follows Copenhagen time and preserves original transcript text', async t => {
  const { options, store } = await fixture(t);
  await store.addTranscript('The October phrase.', { now: new Date('2026-10-31T22:59:59Z') });
  const original = '  First November line.\nSecond line with **literal markdown**.  ';
  const entry = await store.addTranscript(original, { now: new Date('2026-10-31T23:00:00Z') });
  assert.equal(entry.text, original);
  assert.equal(entry.timestamp, '2026-10-31T23:00:00.000Z');
  assert.equal(await readFile(path.join(options.logDirectory, '2026-10.md'), 'utf8'), '\n## 2026-10-31 23:59:59 +01:00 (Europe/Copenhagen)\n\nThe October phrase.\n');
  assert.equal(await readFile(path.join(options.logDirectory, '2026-11.md'), 'utf8'), `\n## 2026-11-01 00:00:00 +01:00 (Europe/Copenhagen)\n\n${original}\n`);
});

test('log stamps include the correct summer offset', async t => {
  const { options, store } = await fixture(t);
  await store.addTranscript('Summer.', { now: new Date('2026-07-01T22:30:00Z') });
  assert.match(await readFile(path.join(options.logDirectory, '2026-07.md'), 'utf8'), /2026-07-02 00:30:00 \+02:00/);
});

test('concurrent appends keep every log entry and persist only the last ten in newest-first order', async t => {
  const { options, store } = await fixture(t);
  const entries = await Promise.all(Array.from({ length: 15 }, (_, i) => store.addTranscript(`Phrase ${i}`, { now: new Date('2026-10-13T12:00:00Z') })));
  assert.equal(new Set(entries.map(entry => entry.id)).size, 15);
  assert.deepEqual(store.history.map(entry => entry.text), Array.from({ length: 10 }, (_, i) => `Phrase ${14 - i}`));
  const log = await readFile(path.join(options.logDirectory, '2026-10.md'), 'utf8');
  assert.equal((log.match(/^## /gm) ?? []).length, 15);
  assert.deepEqual(log.split('\n').filter(line => line.startsWith('Phrase ')), Array.from({ length: 15 }, (_, i) => `Phrase ${i}`));
  const reloaded = new DictationStore(options);
  await reloaded.load();
  assert.deepEqual(reloaded.history, store.history);
  assert.deepEqual(await readdir(options.dataDirectory), ['history.json']);
});

test('settings validate partial updates, persist, and cannot be mutated through getters', async t => {
  const { options, store } = await fixture(t);
  assert.deepEqual(store.settings, { hotkey: 'fn', microphoneId: '', launchAtLogin: false });
  await store.updateSettings({ microphoneId: 'external-mic', launchAtLogin: true });
  await store.updateSettings({ hotkey: 'right-option' });
  await assert.rejects(store.updateSettings({ hotkey: 'unknown' as never }), /Choose fn/);
  await assert.rejects(store.updateSettings({ launchAtLogin: 'yes' as never }), /true or false/);
  await assert.rejects(store.updateSettings({ microphoneId: 12 as never }), /string/);
  const exposed = store.settings;
  exposed.hotkey = 'ctrl-option';
  const reloaded = new DictationStore(options);
  await reloaded.load();
  assert.deepEqual(reloaded.settings, { hotkey: 'right-option', microphoneId: 'external-mic', launchAtLogin: true });
});

test('island placement persists independently from settings and cannot be mutated externally', async t => {
  const { options, store } = await fixture(t);
  assert.deepEqual(store.islandPlacement, { anchor: 'bottom-center' });
  const placement = { anchor: 'left-center' as const, displayId: 42 };
  await store.updateIslandPlacement(placement);
  placement.displayId = 17;
  store.islandPlacement.anchor = 'top-right';
  await store.updateSettings({ hotkey: 'right-option' });
  await assert.rejects(store.updateIslandPlacement({ anchor: 'middle' as never }), /valid island position/);
  await assert.rejects(store.updateIslandPlacement({ anchor: 'top-left', displayId: NaN }), /valid island position/);
  await assert.rejects(store.updateIslandPlacement({ anchor: 'top-left', displayId: '42' as never }), /valid island position/);
  const reloaded = new DictationStore(options);
  await reloaded.load();
  assert.deepEqual(reloaded.islandPlacement, { anchor: 'left-center', displayId: 42 });
  assert.equal(reloaded.settings.hotkey, 'right-option');
});

test('older caches acquire the default island position without corrupt recovery or lost history', async t => {
  const { options } = await fixture(t);
  await mkdir(options.dataDirectory, { recursive: true });
  const entry = { id: 'legacy', text: 'Keep my transcript.', timestamp: '2026-10-13T12:00:00Z', pasted: true };
  await writeFile(path.join(options.dataDirectory, 'history.json'), JSON.stringify({
    version: 1, settings: { hotkey: 'ctrl-option', microphoneId: 'mic', launchAtLogin: true }, history: [entry],
  }));
  const store = new DictationStore(options);
  await store.load();
  assert.deepEqual(store.islandPlacement, { anchor: 'bottom-center' });
  assert.deepEqual(store.history, [entry]);
  await store.updateIslandPlacement({ anchor: 'top-center', displayId: -2 });
  assert.deepEqual(await readdir(options.dataDirectory), ['history.json']);
  const reloaded = new DictationStore(options);
  await reloaded.load();
  assert.deepEqual(reloaded.history, [entry]);
  assert.equal(reloaded.settings.hotkey, 'ctrl-option');
});

test('invalid saved placement falls back safely and preserves the original cache', async t => {
  const { options } = await fixture(t);
  await mkdir(options.dataDirectory, { recursive: true });
  const original = JSON.stringify({ version: 1,
    settings: { hotkey: 'fn', microphoneId: '', launchAtLogin: false }, history: [],
    islandPlacement: { anchor: 'off-screen', displayId: 42 },
  });
  await writeFile(path.join(options.dataDirectory, 'history.json'), original);
  const store = new DictationStore(options);
  await store.load();
  assert.deepEqual(store.islandPlacement, { anchor: 'bottom-center' });
  const backup = (await readdir(options.dataDirectory)).find(file => file.startsWith('history.corrupt-'));
  assert.ok(backup);
  assert.equal(await readFile(path.join(options.dataDirectory, backup), 'utf8'), original);
});

test('paste and error updates persist without appending the transcript twice', async t => {
  const { options, store } = await fixture(t);
  const entry = await store.addTranscript('Recoverable dictation.', { error: 'Paste failed.', now: new Date('2026-10-13T12:00:00Z') });
  const updated = await store.updateTranscript(entry.id, { pasted: true, error: undefined });
  assert.equal(updated?.pasted, true);
  assert.equal(updated?.error, undefined);
  assert.equal(await store.updateTranscript('missing', { pasted: true }), undefined);
  const exposed = store.history;
  exposed[0].text = 'Mutated';
  const reloaded = new DictationStore(options);
  await reloaded.load();
  assert.equal(reloaded.history[0].text, entry.text);
  assert.equal(reloaded.history[0].pasted, true);
  assert.equal((await readFile(path.join(options.logDirectory, '2026-10.md'), 'utf8')).split(entry.text).length, 2);
});

test('malformed cache is preserved exactly before recovery saves replace it', async t => {
  const { options } = await fixture(t);
  await mkdir(options.dataDirectory, { recursive: true });
  const malformed = '{"settings": broken user file\n';
  await writeFile(path.join(options.dataDirectory, 'history.json'), malformed);
  const store = new DictationStore(options);
  await store.load();
  assert.equal(await readFile(path.join(options.dataDirectory, 'history.json'), 'utf8'), malformed);
  await store.addTranscript('Recovered.');
  const files = await readdir(options.dataDirectory);
  const backup = files.find(file => file.startsWith('history.corrupt-'));
  assert.ok(backup);
  assert.equal(await readFile(path.join(options.dataDirectory, backup), 'utf8'), malformed);
  assert.equal(JSON.parse(await readFile(path.join(options.dataDirectory, 'history.json'), 'utf8')).history[0].text, 'Recovered.');
});

test('partly damaged cache recovers valid settings and transcripts while preserving the original', async t => {
  const { options } = await fixture(t);
  await mkdir(options.dataDirectory, { recursive: true });
  const good = { id: 'one', text: 'Saved text.', timestamp: '2026-10-13T12:00:00Z', pasted: false };
  const original = JSON.stringify({ version: 1, settings: { hotkey: 'invalid', microphoneId: 'good-mic', launchAtLogin: true }, history: [good, { broken: true }, good] });
  await writeFile(path.join(options.dataDirectory, 'history.json'), original);
  const store = new DictationStore(options);
  await store.load();
  assert.deepEqual(store.settings, { hotkey: 'fn', microphoneId: 'good-mic', launchAtLogin: true });
  assert.deepEqual(store.history, [good]);
  const backup = (await readdir(options.dataDirectory)).find(file => file.startsWith('history.corrupt-'));
  assert.ok(backup);
  assert.equal(await readFile(path.join(options.dataDirectory, backup), 'utf8'), original);
});

test('log failure still recovers the transcript in persistent history', async t => {
  const { root, options } = await fixture(t);
  const blocked = path.join(root, 'not-a-directory');
  await writeFile(blocked, 'existing file');
  const store = new DictationStore({ ...options, logDirectory: blocked });
  await store.load();
  const entry = await store.addTranscript('Keep this text.');
  assert.ok(entry.logError);
  const reloaded = new DictationStore(options);
  await reloaded.load();
  assert.equal(reloaded.history[0].text, 'Keep this text.');
  assert.equal(reloaded.history[0].logError, entry.logError);
  assert.equal(await readFile(blocked, 'utf8'), 'existing file');
});

test('cache failure leaves a logged transcript in memory and later saves can recover', async t => {
  const { options, store } = await fixture(t);
  await mkdir(options.dataDirectory, { recursive: true });
  await mkdir(path.join(options.dataDirectory, 'history.json'));
  await assert.rejects(store.addTranscript('Keep even when cache fails.', { now: new Date('2026-10-13T12:00:00Z') }));
  assert.equal(store.history[0].text, 'Keep even when cache fails.');
  assert.match(await readFile(path.join(options.logDirectory, '2026-10.md'), 'utf8'), /Keep even when cache fails\./);
  await rm(path.join(options.dataDirectory, 'history.json'), { recursive: true });
  await store.updateSettings({ launchAtLogin: true });
  const reloaded = new DictationStore(options);
  await reloaded.load();
  assert.equal(reloaded.history[0].text, 'Keep even when cache fails.');
});

test('empty transcripts and invalid dates never create logs or history', async t => {
  const { options, store } = await fixture(t);
  await assert.rejects(store.addTranscript(' \n '), /empty transcript/);
  await assert.rejects(store.addTranscript('Text.', { now: new Date('invalid') }), /date is invalid/);
  assert.deepEqual(store.history, []);
  await assert.rejects(readdir(options.logDirectory), { code: 'ENOENT' });
});
