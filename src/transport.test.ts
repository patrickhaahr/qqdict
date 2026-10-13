import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import type { CodexHarness } from './harness';
import { DictationTransport } from './transport';

type SentEvent = { type: string; audio?: string };
const maximumAudioBytes = 24_000 * 2 * 300;

function activeTransport(audioBytes: number) {
  const sent: SentEvent[] = [];
  const transport = new DictationTransport({} as CodexHarness, () => {});
  const internal = transport as unknown as {
    audioBytes: number;
    complete(): void;
  };
  Object.assign(transport, {
    started: true,
    audioBytes,
    socket: {
      readyState: WebSocket.OPEN,
      send: (message: string) => { sent.push(JSON.parse(message) as SentEvent); },
      close: () => {},
    },
  });
  return { transport, internal, sent };
}

test('stop appends one second of generated silence before session.close exactly once', async () => {
  const { transport, internal, sent } = activeTransport(24_000);
  const first = transport.stop();
  assert.equal(transport.stop(), first);
  assert.deepEqual(sent.map(event => event.type), ['audio.append', 'session.close']);
  const silence = Buffer.from(sent[0]!.audio!, 'base64');
  assert.equal(silence.length, 48_000);
  assert.equal(silence.every(byte => byte === 0), true);
  assert.equal(internal.audioBytes, 72_000);
  internal.complete();
  assert.equal(await first, '');
});

test('stop does not add generated audio to an empty session', async () => {
  const { transport, internal, sent } = activeTransport(0);
  const result = transport.stop();
  assert.deepEqual(sent, [{ type: 'session.close' }]);
  assert.equal(internal.audioBytes, 0);
  internal.complete();
  assert.equal(await result, '');
});

test('endpoint silence consumes only the remaining five-minute budget', async () => {
  for (const remainingBytes of [4_800, 2, 0]) {
    const { transport, internal, sent } = activeTransport(maximumAudioBytes - remainingBytes);
    const result = transport.stop();
    assert.equal(internal.audioBytes, maximumAudioBytes);
    assert.equal(sent.at(-1)?.type, 'session.close');
    const appended = sent.filter(event => event.type === 'audio.append');
    assert.equal(appended.length, remainingBytes ? 1 : 0);
    if (remainingBytes) assert.equal(Buffer.from(appended[0]!.audio!, 'base64').length, remainingBytes);
    internal.complete();
    await result;
  }
});
