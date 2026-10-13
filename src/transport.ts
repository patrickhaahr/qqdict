import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { CodexHarness } from './harness';
import { TranscriptBuffer } from './transcripts';
import { PRODUCT_NAME, PRODUCT_VERSION } from './product';

export type DictationEvent = {
  type: 'status' | 'partial' | 'final' | 'error';
  text?: string;
  status?: string;
  detail?: string;
};

export const DICTATION_URL = 'wss://chatgpt.com/backend-api/dictation/stream?dictation_surface=global';
const SAMPLE_RATE = 24_000;
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 300;
const ENDPOINT_SILENCE_BYTES = SAMPLE_RATE * 2;

export function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted token]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted key]').slice(0, 500);
}

export class DictationTransport {
  private socket: WebSocket | null = null;
  private transcript = new TranscriptBuffer();
  private audioBytes = 0;
  private started = false;
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private finishResolve: ((text: string) => void) | null = null;
  private finishReject: ((error: Error) => void) | null = null;
  private finishPromise: Promise<string> | null = null;
  private generation = 0;
  private opening = false;
  private startReject: ((error: Error) => void) | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private harness: CodexHarness, private emit: (event: DictationEvent) => void) {}

  async status(): Promise<{ connected: boolean; label: string; detail?: string }> {
    try {
      const auth = await this.harness.getAuth();
      return { connected: true, label: auth.label, detail: 'Connected through your existing Codex sign-in.' };
    } catch (error) {
      return { connected: false, label: 'Codex sign-in unavailable', detail: safeMessage(error) };
    }
  }

  async start(): Promise<void> {
    if (this.socket || this.opening) throw new Error('A recording is already open.');
    const generation = ++this.generation;
    this.opening = true;
    this.transcript = new TranscriptBuffer();
    this.audioBytes = 0;
    this.started = false;
    this.stopping = false;
    this.emit({ type: 'status', status: 'connecting' });
    let auth;
    try { auth = await this.harness.getAuth(); }
    catch (error) { if (generation === this.generation) this.opening = false; throw error; }
    if (generation !== this.generation) throw new Error('Recording cancelled.');
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.token}`,
      originator: PRODUCT_NAME,
      'User-Agent': `${PRODUCT_NAME}/${PRODUCT_VERSION}`,
    };
    if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId;
    if (auth.routingOverride) headers['X-OpenAI-Account-Routing-Override'] = auth.routingOverride;
    if (auth.fedramp) headers['X-OpenAI-Fedramp'] = 'true';
    const url = new URL(DICTATION_URL);
    url.host = new URL(auth.backendOrigin).host;
    const ws = new WebSocket(url, ['chatgpt-dictation', 'codex-desktop'], {
      headers, followRedirects: false, maxPayload: 8_388_608, handshakeTimeout: 15_000,
    });
    this.socket = ws;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      this.startReject = reject;
      const active = () => this.socket === ws && generation === this.generation;
      const failStart = (error: Error) => {
        if (!active()) return;
        if (!settled) { settled = true; reject(error); }
        this.startReject = null;
        this.fail(error);
      };
      const startupTimer = setTimeout(() => failStart(new Error('The dictation service did not start within 20 seconds.')), 20_000);
      this.startupTimer = startupTimer;
      ws.on('open', () => { if (!active()) return; ws.send(JSON.stringify({
        type: 'session.start',
        dictation_session_id: randomUUID(),
        attempt_id: randomUUID(),
        config: {
          input_audio_format: 'pcm16', sample_rate_hz: SAMPLE_RATE, num_channels: 1,
          max_buffer_size_bytes: 4_194_304, max_utterance_duration_ms: 30_000,
          session_ttl_ms: 300_000, provider_mode: 'streaming_sse', transcript_delivery_mode: 'segment',
          vad: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
        },
      })); });
      ws.on('unexpected-response', (_request, response) => {
        response.resume();
        clearTimeout(startupTimer);
        const status = response.statusCode ?? 0;
        const hint = status === 401 ? 'Your existing Codex sign-in was not accepted.'
          : status === 403 ? 'This account or independent client is not allowed to use this dictation route.'
          : status === 429 ? 'The subscription dictation service has reached a usage limit.'
          : 'The internal dictation route did not accept the connection.';
        failStart(new Error(`HTTP ${status}. ${hint}`));
      });
      ws.on('error', (error) => {
        clearTimeout(startupTimer);
        failStart(new Error(safeMessage(error)));
      });
      ws.on('message', (data, isBinary) => {
        if (!active() || isBinary) return;
        let event: Record<string, any>;
        try { event = JSON.parse(data.toString()); } catch { return; }
        if (!event || typeof event !== 'object') return;
        if (event.type === 'session.started') {
          clearTimeout(startupTimer);
          this.started = true;
          this.opening = false;
          this.startReject = null;
          this.emit({ type: 'status', status: 'recording' });
          if (!settled) { settled = true; resolve(); }
        } else if (event.type === 'transcript.segment' || event.type === 'transcript.final') {
          const text = this.transcript.accept(event);
          this.emit({ type: 'partial', text });
        } else if (event.type === 'session.updated' && event.session?.status === 'closed') {
          this.complete();
        } else if (event.type === 'transcript.failed' || event.type === 'session.error' || event.type === 'error') {
          const description = event.error?.message ?? event.message ?? event.error?.code ?? 'The dictation service rejected this session.';
          if (event.type === 'session.error' && event.fatal === false) {
            this.emit({ type: 'status', status: this.stopping ? 'transcribing' : 'recording', detail: safeMessage(description) });
            return;
          }
          clearTimeout(startupTimer);
          failStart(new Error(safeMessage(description)));
        }
      });
      ws.on('close', (code) => {
        clearTimeout(startupTimer);
        if (!active()) return;
        failStart(new Error(`The dictation connection closed before completion (code ${code}).`));
      });
    });
  }

  append(audio: ArrayBuffer | Uint8Array): void {
    if (!this.started || this.stopping || this.socket?.readyState !== WebSocket.OPEN) return;
    let chunk = Buffer.from(audio instanceof ArrayBuffer ? new Uint8Array(audio) : audio);
    if (!chunk.length) return;
    if (chunk.length % 2 || chunk.length > 262_144) {
      this.fail(new Error('The microphone sent an invalid audio frame.'));
      return;
    }
    // Timer callbacks can be delayed. Keep the exact limit without losing a take.
    chunk = chunk.subarray(0, MAX_AUDIO_BYTES - this.audioBytes);
    if (!chunk.length) return;
    this.audioBytes += chunk.length;
    this.socket.send(JSON.stringify({ type: 'audio.append', audio: chunk.toString('base64') }));
  }

  stop(): Promise<string> {
    if (this.finishPromise) return this.finishPromise;
    if (!this.started || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('No active dictation session.'));
    // Give server VAD an audio endpoint even when the key is released directly
    // after the final word. This records no extra microphone audio and adds no
    // wait; append() preserves the same exact five-minute byte limit.
    if (this.audioBytes > 0) {
      const silenceBytes = Math.min(ENDPOINT_SILENCE_BYTES, MAX_AUDIO_BYTES - this.audioBytes);
      if (silenceBytes > 0) this.append(Buffer.alloc(silenceBytes));
    }
    this.stopping = true;
    this.emit({ type: 'status', status: 'transcribing' });
    this.finishPromise = new Promise<string>((resolve, reject) => {
      this.finishResolve = resolve;
      this.finishReject = reject;
    });
    this.timer = setTimeout(() => this.fail(new Error('No final transcript arrived within 30 seconds.')), 30_000);
    this.socket.send(JSON.stringify({ type: 'session.close' }));
    return this.finishPromise;
  }

  private complete(): void {
    const text = this.transcript.text;
    const resolve = this.finishResolve;
    this.reset();
    this.emit({ type: 'final', text });
    this.emit({ type: 'status', status: 'idle' });
    resolve?.(text);
  }

  private fail(error: Error): void {
    if (!this.socket && !this.finishPromise) return;
    const reject = this.finishReject;
    this.reset();
    this.emit({ type: 'error', text: safeMessage(error) });
    reject?.(error);
  }

  cancel(): void {
    const reject = this.finishReject;
    this.reset();
    reject?.(new Error('Recording cancelled.'));
    this.emit({ type: 'status', status: 'idle' });
  }

  private reset(): void {
    this.generation++;
    this.opening = false;
    this.startReject?.(new Error('Recording cancelled.'));
    this.startReject = null;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.socket;
    this.socket = null;
    this.started = false;
    this.stopping = false;
    this.finishResolve = null;
    this.finishReject = null;
    this.finishPromise = null;
    if (ws) {
      // Keep the error listener while terminating an incomplete connection.
      if (ws.readyState === WebSocket.OPEN) ws.close();
      else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    }
  }
}
