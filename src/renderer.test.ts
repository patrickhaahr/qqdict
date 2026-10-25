import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';
import test from 'node:test';
import { transform } from 'esbuild';
import type { AppEvent } from './contracts';
import * as hotkeys from './hotkeys';

const rendererCode = readFile('src/renderer.ts', 'utf8').then((source) => transform(source, { loader: 'ts', format: 'iife' }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function recorderFixture(options: { delayMicrophone?: boolean; delayModule?: boolean; delayCue?: boolean } = {}) {
  const backend = deferred<void>();
  const microphone = deferred<unknown>();
  const module = deferred<void>();
  const cue = deferred<void>();
  const contexts: FakeContext[] = [];
  const processors: FakeProcessor[] = [];
  const capturing: number[] = [];
  const microphones: string[] = [];
  const sent: { audio: ArrayBuffer; id: number }[] = [];
  const errors: string[] = [];
  const cancelled: number[] = [];
  const stopped: number[] = [];
  const track = { label: 'Default - MacBook Pro Microphone (Built-in)', readyState: 'live', stop() { this.readyState = 'ended'; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let microphoneCalls = 0;
  let onEvent!: (event: AppEvent) => void;
  let unload!: () => void;

  class FakeNode {
    connect<T>(node: T): T { return node; }
    disconnect() {}
  }
  class FakeContext {
    state = 'running';
    destination = {};
    audioWorklet = { addModule: () => options.delayModule ? module.promise : Promise.resolve() };
    constructor() { contexts.push(this); }
    async resume() { this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
    async close() { this.state = 'closed'; }
    createGain() { return Object.assign(new FakeNode(), { gain: { value: 1 } }); }
    createMediaStreamSource() { return new FakeNode(); }
  }
  class FakeProcessor extends FakeNode {
    messages: string[] = [];
    port = {
      onmessage: undefined as ((event: { data: object }) => void) | undefined,
      postMessage: ({ type }: { type: string }) => {
        this.messages.push(type);
        if (type === 'flush') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'flushed' } }));
      },
    };
    constructor() { super(); processors.push(this); }
    audio(bytes: number[]) { this.port.onmessage?.({ data: { type: 'audio', pcm: Uint8Array.from(bytes).buffer } }); }
  }

  vm.runInNewContext((await rendererCode).code, {
    require: (id: string) => {
      if (id === './recording-cues') return { playRecordingCue: () => options.delayCue ? cue.promise : Promise.resolve() };
      if (id === './product') return { PRODUCT_NAME: 'qqdict-test' };

      if (id === './hotkeys') return hotkeys;
      throw new Error(`Unexpected renderer dependency: ${id}`);
    },
    window: {
      location: { search: '?recorder=1' },
      addEventListener: (_name: string, callback: () => void) => { unload = callback; },
      dictation: {
        getState: async () => ({ microphoneId: '' }), ready: async () => {},
        onEvent: (callback: typeof onEvent) => { onEvent = callback; },
        start: () => backend.promise,
        reportCapturing: (id: number, microphone: string) => { capturing.push(id); microphones.push(microphone); },
        reportLevel() {},
        reportError: (message: string) => errors.push(message),
        sendAudio: (audio: ArrayBuffer, id: number) => sent.push({ audio, id }),
        stop: async (id: number) => { stopped.push(id); },
        cancel: async (id: number) => { cancelled.push(id); },
      },
    },
    document: { body: { classList: { add() {} } } },
    navigator: { mediaDevices: { getUserMedia: () => { microphoneCalls++; return options.delayMicrophone ? microphone.promise : Promise.resolve(stream); } } },
    AudioContext: FakeContext, AudioWorkletNode: FakeProcessor,
    URL, URLSearchParams, Blob, Error, setTimeout, clearTimeout, console,
  });
  await setImmediate();
  return {
    backend, microphone, module, cue, stream, track, contexts, processors, capturing, microphones, sent, errors, cancelled, stopped,
    get microphoneCalls() { return microphoneCalls; },
    command(command: 'start' | 'stop' | 'cancel', takeId = 1) { onEvent({ type: 'command', command, takeId }); },
    unload() { unload(); },
  };
}

test('warms without a microphone and retains audio captured before the server is ready', async (t) => {
  const fixture = await recorderFixture();
  t.after(() => fixture.unload());
  assert.equal(fixture.microphoneCalls, 0);
  assert.equal(fixture.contexts[0]!.state, 'suspended');
  assert.equal(fixture.processors.length, 1);

  fixture.command('start');
  await setImmediate();
  assert.equal(fixture.contexts.length, 1, 'uses the already prepared audio graph');
  assert.deepEqual(fixture.capturing, [1]);
  assert.deepEqual(fixture.microphones, ['MacBook Pro Microphone'], 'names the input that actually opened');
  fixture.processors[0]!.audio([1, 2]);
  fixture.processors[0]!.audio([3, 4]);
  assert.equal(fixture.sent.length, 0);

  fixture.command('stop');
  assert.equal(fixture.track.readyState, 'ended', 'release closes the microphone before the handshake');
  await setImmediate();
  assert.equal(fixture.stopped.length, 0);
  assert.equal(fixture.contexts[1]!.state, 'suspended', 'prepares a fresh graph for the next take');
  fixture.backend.resolve();
  await setImmediate();
  assert.deepEqual(fixture.sent.map(({ audio, id }) => [id, ...new Uint8Array(audio)]), [[1, 1, 2], [1, 3, 4]]);
  assert.deepEqual(fixture.stopped, [1]);
  assert.deepEqual(fixture.errors, []);
});

test('release during microphone startup closes a late stream without starting capture', async (t) => {
  const fixture = await recorderFixture({ delayMicrophone: true });
  t.after(() => fixture.unload());
  fixture.command('start');
  fixture.command('stop');
  fixture.microphone.resolve(fixture.stream);
  await setImmediate();
  assert.equal(fixture.track.readyState, 'ended');
  assert.deepEqual(fixture.capturing, []);
  assert.deepEqual(fixture.cancelled, [1]);
  assert.deepEqual(fixture.sent, []);
});

test('cancel during audio preparation disposes the graph and never sends stale audio', async (t) => {
  const fixture = await recorderFixture({ delayModule: true });
  t.after(() => fixture.unload());
  fixture.command('start');
  await setImmediate();
  fixture.command('cancel');
  assert.equal(fixture.track.readyState, 'ended');
  fixture.module.resolve();
  fixture.backend.resolve();
  await setImmediate();
  assert.equal(fixture.contexts[0]!.state, 'closed');
  assert.deepEqual(fixture.capturing, []);
  assert.deepEqual(fixture.sent, []);
  assert.deepEqual(fixture.errors, []);
});

test('release during the start cue skips flushing a graph that never started', async (t) => {
  const fixture = await recorderFixture({ delayCue: true });
  t.after(() => fixture.unload());
  fixture.command('start');
  await setImmediate();
  assert.equal(fixture.contexts[0]!.state, 'suspended');
  fixture.command('stop');
  assert.equal(fixture.track.readyState, 'ended');
  fixture.cue.resolve();
  await setImmediate();
  assert.deepEqual(fixture.processors[0]!.messages, []);
  assert.deepEqual(fixture.capturing, []);
  assert.deepEqual(fixture.cancelled, [1]);
  assert.deepEqual(fixture.errors, []);
});

test('failed warming is retried when recording starts', async (t) => {
  const fixture = await recorderFixture({ delayModule: true });
  t.after(() => fixture.unload());
  fixture.module.reject(new Error('Audio device unavailable'));
  await setImmediate();
  assert.equal(fixture.contexts[0]!.state, 'closed');
  assert.deepEqual(fixture.errors, [], 'idle warming does not surface a recording error');
  fixture.command('start');
  await setImmediate();
  assert.ok(fixture.contexts.length > 1);
  assert.equal(fixture.track.readyState, 'ended');
  assert.deepEqual(fixture.errors, ['Audio device unavailable']);
});
