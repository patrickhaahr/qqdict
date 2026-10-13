import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexHarness } from './harness';
import { DictationTransport, safeMessage } from './transport';

// A bounded, real-network check. No API key, credential output, or fake transcripts.
async function main(): Promise<void> {
  const harness = new CodexHarness();
  const transport = new DictationTransport(harness, (event) => {
    if (event.type === 'error') console.log(JSON.stringify({ stage: 'service', error: event.text }));
  });
  try {
    const status = await transport.status();
    console.log(JSON.stringify({ stage: 'codex-auth', ...status }));
    if (!status.connected) { process.exitCode = 1; return; }
    await transport.start();
    console.log(JSON.stringify({ stage: 'dictation-session', accepted: true }));
    const audioIndex = process.argv.indexOf('--audio');
    if (audioIndex >= 0) {
      const file = process.argv[audioIndex + 1];
      if (!file?.endsWith('.pcm')) throw new Error('Provide a mono 24 kHz signed PCM16 little-endian .pcm test file.');
      const pcm = await readFile(file);
      if (!pcm.length || pcm.length > 24_000 * 2 * 30 || pcm.length % 2) throw new Error('The test audio must contain 1–30 seconds of valid PCM16.');
      // Send at microphone speed so the server receives realistic frame timing.
      for (let i = 0; i < pcm.length; i += 4_800) {
        transport.append(pcm.subarray(i, i + 4_800));
        await delay(100);
      }
    }
    const text = await transport.stop();
    if (audioIndex >= 0 && !text.trim()) throw new Error('The service accepted the session but returned no transcript for the test recording.');
    console.log(JSON.stringify({ stage: 'completed', transcript: text }));
  } catch (error) {
    console.log(JSON.stringify({ stage: 'failed', error: safeMessage(error) }));
    process.exitCode = 1;
  } finally {
    transport.cancel();
    harness.dispose();
  }
}

void main();
