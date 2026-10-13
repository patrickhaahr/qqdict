import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { MacBridge, FocusTarget } from './native';
import { pasteTranscript } from './paste';

const target: FocusTarget = { targetPid: 123, focusId: 'the-original-field' };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fakeBridge(request: (command: string, fields: Record<string, unknown>) => Promise<unknown>): MacBridge {
  return { request } as unknown as MacBridge;
}

test('a cancelled take never stages or posts text', async () => {
  const controller = new AbortController();
  controller.abort();
  const commands: string[] = [];
  const bridge = fakeBridge(async command => { commands.push(command); return {}; });
  await assert.rejects(pasteTranscript(bridge, 'cancelled words', target, controller.signal), { name: 'AbortError' });
  assert.deepEqual(commands, []);
});

test('protected or unavailable focus never changes the clipboard', async () => {
  const commands: string[] = [];
  const bridge = fakeBridge(async command => { commands.push(command); return {}; });
  await assert.rejects(pasteTranscript(bridge, 'words', { ...target, secure: true }), /protected field/);
  await assert.rejects(pasteTranscript(bridge, 'words', { targetPid: 123 }), /focused text field/);
  assert.deepEqual(commands, []);
});

test('cancellation during modifier-release delay restores the clipboard without posting Cmd+V', async () => {
  const controller = new AbortController();
  const staged = deferred();
  const commands: Array<{ command: string; fields: Record<string, unknown> }> = [];
  const bridge = fakeBridge(async (command, fields) => {
    commands.push({ command, fields });
    if (command === 'stageClipboard') { staged.resolve(); return { changeCount: 27, restoreAvailable: true }; }
    return { restored: true };
  });
  const operation = pasteTranscript(bridge, 'cancelled words', target, controller.signal);
  const rejection = assert.rejects(operation, { name: 'AbortError' });
  await staged.promise;
  await delay(10);
  controller.abort();
  await rejection;
  assert.deepEqual(commands, [
    { command: 'stageClipboard', fields: { text: 'cancelled words' } },
    { command: 'restoreClipboard', fields: { changeCount: 27 } },
  ]);
});

test('a new take cannot replace an old clipboard snapshot while cancellation cleanup is pending', async () => {
  const firstController = new AbortController();
  const secondController = new AbortController();
  const firstStaged = deferred();
  const firstRestoreEntered = deferred();
  const allowFirstRestore = deferred();
  const commands: string[] = [];
  const first = fakeBridge(async command => {
    commands.push(`first:${command}`);
    if (command === 'stageClipboard') { firstStaged.resolve(); return { changeCount: 10, restoreAvailable: true }; }
    if (command === 'restoreClipboard') {
      firstRestoreEntered.resolve();
      await allowFirstRestore.promise;
      return { restored: true };
    }
    throw new Error('Cancelled take must never post Cmd+V.');
  });
  const second = fakeBridge(async command => {
    commands.push(`second:${command}`);
    if (command === 'stageClipboard') {
      secondController.abort();
      return { changeCount: 11, restoreAvailable: true };
    }
    return { restored: true };
  });
  const firstResult = assert.rejects(pasteTranscript(first, 'first', target, firstController.signal), { name: 'AbortError' });
  await firstStaged.promise;
  const secondResult = assert.rejects(pasteTranscript(second, 'second', target, secondController.signal), { name: 'AbortError' });
  firstController.abort();
  await firstRestoreEntered.promise;
  assert.deepEqual(commands, ['first:stageClipboard', 'first:restoreClipboard']);
  allowFirstRestore.resolve();
  await Promise.all([firstResult, secondResult]);
  assert.deepEqual(commands, ['first:stageClipboard', 'first:restoreClipboard', 'second:stageClipboard', 'second:restoreClipboard']);
});

test('a focus-check failure restores the clipboard and remains a paste failure', async () => {
  const commands: string[] = [];
  const bridge = fakeBridge(async command => {
    commands.push(command);
    if (command === 'stageClipboard') return { changeCount: 42, restoreAvailable: true };
    if (command === 'paste') throw new Error('focus_changed');
    return { restored: true };
  });
  await assert.rejects(pasteTranscript(bridge, 'words', target), /focus_changed/);
  assert.deepEqual(commands, ['stageClipboard', 'paste', 'restoreClipboard']);
});

test('paste supplies the exact staged clipboard version for native validation', async () => {
  const requests: Array<{ command: string; fields: Record<string, unknown> }> = [];
  const bridge = fakeBridge(async (command, fields) => {
    requests.push({ command, fields });
    if (command === 'stageClipboard') return { changeCount: 312, restoreAvailable: true };
    if (command === 'paste') return { posted: true };
    return { restored: true };
  });
  await pasteTranscript(bridge, 'dictated words', target);
  assert.deepEqual(requests, [
    { command: 'stageClipboard', fields: { text: 'dictated words' } },
    { command: 'paste', fields: { ...target, changeCount: 312 } },
    { command: 'restoreClipboard', fields: { changeCount: 312 } },
  ]);
});

test('a user copy before paste is preserved when native version validation rejects it', async () => {
  const staged = deferred();
  let clipboard = 'original rich clipboard';
  let version = 51;
  let posted = false;
  const commands: string[] = [];
  const bridge = fakeBridge(async (command, fields) => {
    commands.push(command);
    if (command === 'stageClipboard') {
      clipboard = fields.text as string;
      staged.resolve();
      return { changeCount: version, restoreAvailable: true };
    }
    if (command === 'paste') {
      assert.equal(fields.changeCount, 51);
      if (fields.changeCount !== version) throw new Error('clipboard_changed');
      posted = true;
      return { posted };
    }
    assert.equal(fields.changeCount, 51);
    if (fields.changeCount !== version) return { restored: false, reason: 'clipboard_changed' };
    clipboard = 'original rich clipboard';
    return { restored: true };
  });
  const rejection = assert.rejects(pasteTranscript(bridge, 'dictated words', target), /clipboard_changed/);
  await staged.promise;
  // A different clipboard owner appears during the existing 70 ms release delay.
  clipboard = 'the user’s new copy';
  version++;
  await rejection;
  assert.equal(posted, false);
  assert.equal(clipboard, 'the user’s new copy');
  assert.deepEqual(commands, ['stageClipboard', 'paste', 'restoreClipboard']);
});

test('failed staging never posts a key or asks to restore a nonexistent session', async () => {
  const commands: string[] = [];
  const bridge = fakeBridge(async command => {
    commands.push(command);
    throw new Error('clipboard_write_failed');
  });
  await assert.rejects(pasteTranscript(bridge, 'dictated words', target), /clipboard_write_failed/);
  assert.deepEqual(commands, ['stageClipboard']);
});

test('successful paste remains successful if clipboard restoration fails or detects a new user copy', async () => {
  for (const restorationFails of [false, true]) {
    const commands: string[] = [];
    const bridge = fakeBridge(async command => {
      commands.push(command);
      if (command === 'stageClipboard') return { changeCount: 80, restoreAvailable: true };
      if (command === 'paste') return { posted: true };
      if (restorationFails) throw new Error('The helper became unavailable after posting.');
      return { restored: false, reason: 'clipboard_changed' };
    });
    await pasteTranscript(bridge, 'inserted words', target);
    assert.deepEqual(commands, ['stageClipboard', 'paste', 'restoreClipboard']);
  }
});
