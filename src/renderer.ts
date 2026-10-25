import type { AppEvent, AppState, DictationAPI, Hotkey } from './contracts';
import { playRecordingCue } from './recording-cues';
import { PRODUCT_NAME } from './product';
import { hotkeyKey, hotkeyName, supportedHotkeys } from './hotkeys';

declare global { interface Window { dictation: DictationAPI } }

const isRecorder = new URLSearchParams(window.location.search).has('recorder');
const api = window.dictation;
let state: AppState | undefined;
const element = <T extends HTMLElement>(id: string): T => {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing interface element: ${id}`);
  return result as T;
};

const linux = api?.platform === 'linux';
const hotkeyLabel = (hotkey: Hotkey): string => hotkeyName(hotkey, api.platform);
const errorText = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);

  if (/NotAllowedError|Permission denied|denied permission/i.test(text)) return linux ? 'The microphone was blocked. Check your desktop’s privacy settings or PipeWire, then try again.' : 'Allow Microphone access in System Settings → Privacy & Security, then try again.';
  if (/NotFoundError|Requested device not found/i.test(text)) return 'The selected microphone is unavailable. Choose another audio input.';
  return text || `${PRODUCT_NAME} could not finish. Please try again.`;
};
// Chromium labels the system input "Default - …" and appends a transport or USB ID suffix.
const microphoneName = (label: string): string => label
  .replace(/^(?:Default|Communications) - /, '')
  .replace(/ \((?:Built-in|Bluetooth|Virtual|Aggregate|[0-9a-f]{4}:[0-9a-f]{4})\)$/i, '')
  .trim();

const workletSource = `
class DictationCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.targetRate = 24000;
    this.step = sampleRate / this.targetRate;
    this.half = Math.ceil(16 * Math.max(1, this.step));
    this.taps = this.half * 2 + 1;
    this.phases = 256;
    this.ring = new Float32Array(16384);
    this.total = 0;
    this.position = 0;
    this.first = 0;
    this.last = 0;
    this.chunk = new Int16Array(2400);
    this.chunkIndex = 0;
    this.levelCount = 0;
    this.filters = [];
    const cutoff = Math.min(1, this.targetRate / sampleRate) * 0.92;
    for (let phase = 0; phase < this.phases; phase++) {
      const weights = new Float64Array(this.taps);
      let sum = 0;
      const fraction = phase / this.phases;
      for (let tap = 0; tap < this.taps; tap++) {
        const distance = fraction - (tap - this.half);
        const angle = Math.PI * cutoff * distance;
        const sinc = Math.abs(angle) < 1e-8 ? 1 : Math.sin(angle) / angle;
        const window = 0.5 * (1 + Math.cos(Math.PI * distance / (this.half + 1)));
        const weight = cutoff * sinc * window;
        weights[tap] = weight;
        sum += weight;
      }
      for (let tap = 0; tap < this.taps; tap++) weights[tap] /= sum;
      this.filters.push(weights);
    }
    this.port.onmessage = (event) => {
      if (event.data.type === 'start') this.recording = true;
      if (event.data.type === 'flush') {
        this.recording = false;
        this.emitAvailable(true);
        this.sendChunk();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }
  sendChunk() {
    if (this.chunkIndex === 0) return;
    const pcm = this.chunk.slice(0, this.chunkIndex);
    this.port.postMessage({ type: 'audio', pcm: pcm.buffer }, [pcm.buffer]);
    this.chunkIndex = 0;
  }
  emitAvailable(flush) {
    const end = flush ? this.total : this.total - this.half;
    while (this.position < end && this.total > 0) {
      const center = Math.floor(this.position);
      const fraction = this.position - center;
      const weights = this.filters[Math.min(this.phases - 1, Math.floor(fraction * this.phases))];
      let value = 0;
      for (let tap = 0; tap < this.taps; tap++) {
        const index = center + tap - this.half;
        const sample = index < 0 ? this.first : index >= this.total ? this.last : this.ring[index % this.ring.length];
        value += sample * weights[tap];
      }
      value = Math.max(-1, Math.min(1, value));
      this.chunk[this.chunkIndex++] = Math.round(value * (value < 0 ? 32768 : 32767));
      if (this.chunkIndex === this.chunk.length) this.sendChunk();
      this.position += this.step;
    }
  }
  process(inputs) {
    if (!this.recording) return true;
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frames = channels[0].length;
    let sumSquares = 0;
    for (let frame = 0; frame < frames; frame++) {
      let mono = 0;
      for (let channel = 0; channel < channels.length; channel++) mono += channels[channel][frame];
      mono /= channels.length;
      if (this.total === 0) this.first = mono;
      this.last = mono;
      this.ring[this.total % this.ring.length] = mono;
      this.total++;
      sumSquares += mono * mono;
    }
    this.emitAvailable(false);
    this.levelCount += frames;
    if (this.levelCount >= sampleRate / 25) {
      this.levelCount = 0;
      this.port.postMessage({ type: 'level', value: Math.sqrt(sumSquares / Math.max(1, frames)) });
    }
    return true;
  }
}
registerProcessor('dictation-capture', DictationCapture);
`;
type PreparedAudio = { context: AudioContext; processor: AudioWorkletNode; silentOutput: GainNode };
let idleAudio: Promise<PreparedAudio> | undefined;
let recorderClosing = false;

async function createPreparedAudio(): Promise<PreparedAudio> {
  const context = new AudioContext({ latencyHint: 'interactive' });
  try {
    await context.resume();
    const moduleUrl = URL.createObjectURL(new Blob([workletSource], { type: 'text/javascript' }));
    try { await context.audioWorklet.addModule(moduleUrl); }
    finally { URL.revokeObjectURL(moduleUrl); }
    const processor = new AudioWorkletNode(context, 'dictation-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const silentOutput = context.createGain();
    silentOutput.gain.value = 0;
    processor.connect(silentOutput).connect(context.destination);
    // Build the graph and resampling filters ahead of the shortcut, with no mic.
    await context.suspend();
    return { context, processor, silentOutput };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

function warmAudio(): Promise<PreparedAudio> {
  if (!idleAudio) {
    const pending = createPreparedAudio();
    idleAudio = pending;
    // Warming is best effort; a failed idle context is retried on the next take.
    void pending.catch(() => { if (idleAudio === pending) idleAudio = undefined; });
  }
  return idleAudio;
}

async function closePreparedAudio(audio: PreparedAudio): Promise<void> {
  audio.processor.disconnect();
  audio.silentOutput.disconnect();
  if (audio.context.state !== 'closed') await audio.context.close().catch(() => undefined);
}

type Take = {
  id: number;
  cancelled: boolean;
  stopRequested: boolean;
  backendReady: boolean;
  queue: ArrayBuffer[];
  queuedBytes: number;
  audioBytes: number;
  captureStarted: boolean;
  context?: AudioContext;
  stream?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  processor?: AudioWorkletNode;
  silentOutput?: GainNode;
  flushResolve?: () => void;
  connected: Promise<void>;
  prepared: Promise<void>;
  closing?: Promise<void>;
};
let current: Take | undefined;

function sendChunk(take: Take, audio: ArrayBuffer): void {
  if (take.cancelled || current !== take) return;
  take.audioBytes += audio.byteLength;
  if (take.backendReady) api.sendAudio(audio, take.id);
  else {
    take.queue.push(audio);
    take.queuedBytes += audio.byteLength;
    if (take.queuedBytes > 2_097_152) void failTake(take, new Error('The dictation connection took too long. Try again.'));
  }
}

function stopMicrophone(take: Take): void {
  take.stream?.getTracks().forEach((track) => track.stop());
  take.stream = undefined;
  take.source?.disconnect();
  take.source = undefined;
  if (take.captureStarted) {
    take.captureStarted = false;
    if (!recorderClosing) void playRecordingCue('stop');
  }
  api.reportLevel(0);
}

async function releaseAudio(take: Take): Promise<void> {
  stopMicrophone(take);
  take.processor?.disconnect();
  take.processor = undefined;
  take.silentOutput?.disconnect();
  take.silentOutput = undefined;
  take.flushResolve?.();
  take.flushResolve = undefined;
  const context = take.context;
  take.context = undefined;
  if (context && context.state !== 'closed') await context.close().catch(() => undefined);
  if (!recorderClosing) void warmAudio();
}

async function cancelTake(take: Take): Promise<void> {
  take.cancelled = true;
  take.queue = [];
  take.queuedBytes = 0;
  await releaseAudio(take);
  if (current === take) current = undefined;
  await api.cancel(take.id).catch(() => undefined);
}

async function failTake(take: Take, error: unknown): Promise<void> {
  if (take.cancelled || current !== take) return;
  api.reportError(errorText(error), take.id);
  await cancelTake(take);
}

async function prepareAudio(take: Take): Promise<void> {
  const prepared = warmAudio();
  const audio = {
    channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    ...(state?.microphoneId ? { deviceId: { exact: state.microphoneId } } : {}),
  };
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  if (take.cancelled || current !== take || take.stopRequested) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  take.stream = stream;
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) throw new Error('The microphone did not provide an audio track. Choose another audio input.');
  audioTrack.addEventListener('ended', () => {
    if (!take.stopRequested && !take.cancelled) void failTake(take, new Error('The microphone disconnected. Choose an available audio input and try again.'));
  });
  if (idleAudio === prepared) idleAudio = undefined;
  const pipeline = await prepared;
  if (take.cancelled || take.stopRequested || current !== take) {
    await closePreparedAudio(pipeline);
    if (!recorderClosing) void warmAudio();
    return;
  }
  const { context, processor, silentOutput } = pipeline;
  take.context = context;
  take.processor = processor;
  take.silentOutput = silentOutput;
  if (audioTrack.readyState === 'ended') throw new Error('The microphone disconnected before recording started. Choose an available audio input and try again.');
  processor.port.onmessage = (event: MessageEvent<{ type: string; pcm?: ArrayBuffer; value?: number }>) => {
    if (take.cancelled || current !== take) return;
    if (event.data.type === 'audio' && event.data.pcm) sendChunk(take, event.data.pcm);
    else if (event.data.type === 'level' && !take.stopRequested) api.reportLevel(event.data.value ?? 0);
    else if (event.data.type === 'flushed') { take.flushResolve?.(); take.flushResolve = undefined; }
  };
  take.source = context.createMediaStreamSource(stream);
  take.source.connect(processor);
  // Finish the cue before accepting samples, so it is not transcribed.
  await playRecordingCue('start');
  if (take.cancelled || take.stopRequested || current !== take) return;
  // Capture and buffer locally while the network handshake is still in flight.
  processor.port.postMessage({ type: 'start' });
  take.captureStarted = true;
  await context.resume();
  if (!take.cancelled && !take.stopRequested && current === take) api.reportCapturing(take.id, microphoneName(audioTrack.label));
}

function startTake(id: number): void {
  if (current?.id === id || (current && !current.cancelled && !current.stopRequested)) return;
  const take: Take = {
    id, cancelled: false, stopRequested: false, backendReady: false,
    queue: [], queuedBytes: 0, audioBytes: 0, captureStarted: false,
    connected: Promise.resolve(), prepared: Promise.resolve(),
  };
  current = take;
  take.connected = api.start(id).then(() => {
    if (take.cancelled || current !== take) return;
    take.backendReady = true;
    for (const audio of take.queue) api.sendAudio(audio, take.id);
    take.queue = [];
    take.queuedBytes = 0;
  });
  take.prepared = prepareAudio(take);
  void take.connected.catch((error) => failTake(take, error));
  void take.prepared.catch((error) => failTake(take, error));
}

async function stopTake(take: Take): Promise<void> {
  if (take.closing || take.cancelled) return take.closing;
  take.stopRequested = true;
  // Closing the mic does not wait for the backend. Flush the worklet's final PCM
  // first, then deliver all queued chunks before the transport closes the take.
  stopMicrophone(take);
  take.closing = (async () => {
    await take.prepared;
    if (take.cancelled || current !== take) return;
    if (take.processor && take.context?.state === 'running') {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { take.flushResolve = undefined; reject(new Error('The microphone did not finish its audio stream. Try again.')); }, 2000);
        take.flushResolve = () => { clearTimeout(timeout); resolve(); };
        take.processor!.port.postMessage({ type: 'flush' });
      });
    }
    await releaseAudio(take);
    if (take.cancelled || current !== take) return;
    if (take.audioBytes === 0) { await cancelTake(take); return; }
    await take.connected;
    if (take.cancelled || current !== take) return;
    await api.stop(take.id);
    if (current === take) current = undefined;
  })();
  try { await take.closing; }
  catch (error) { await failTake(take, error); }
}

async function runRecorder(): Promise<void> {
  document.body.classList.add('recorder');
  document.title = `${PRODUCT_NAME} microphone`;
  api.onEvent((event: AppEvent) => {
    if (event.type === 'state') { state = event.state; return; }
    if (event.type === 'command') {
      if (event.command === 'start') startTake(event.takeId);
      else if (current?.id === event.takeId) {
        if (event.command === 'stop') void stopTake(current);
        else void cancelTake(current);
      }
    }
    if ((event.type === 'error' || event.type === 'final') && current && (event.takeId === undefined || event.takeId === current.id)) {
      // Final transcripts can arrive when the server ends a long utterance.
      const take = current;
      if (!take.stopRequested) void cancelTake(take);
    }
  });
  state = await api.getState();
  void warmAudio();
  await api.ready();
  window.addEventListener('beforeunload', () => {
    recorderClosing = true;
    if (current) { current.cancelled = true; void releaseAudio(current); }
    void idleAudio?.then(closePreparedAudio).catch(() => undefined);
    idleAudio = undefined;
  });
}

function runSettings(): void {
  const app = document.querySelector<HTMLElement>('.app')!;
  const recordButton = element<HTMLButtonElement>('record-button');
  const hotkeySelect = element<HTMLSelectElement>('hotkey-select');
  hotkeySelect.replaceChildren(...supportedHotkeys(api.platform).map((hotkey) => new Option(hotkeyLabel(hotkey), hotkey)));
  const microphoneSelect = element<HTMLSelectElement>('microphone-select');
  const loginSwitch = element<HTMLInputElement>('launch-at-login');
  const transcript = element('transcript');
  const copyButton = element<HTMLButtonElement>('copy-button');
  const errorPanel = element('error-panel');
  const tabs = [element<HTMLButtonElement>('setup-tab'), element<HTMLButtonElement>('settings-tab'), element<HTMLButtonElement>('history-tab')];
  const bars = Array.from({ length: 5 }, () => {
    const bar = document.createElement('span');
    element('test-waveform').appendChild(bar);
    return bar;
  });
  let displayedText = '';
  let lastHistoryId: string | undefined;
  let historyFingerprint = '';
  let enumerating = false;
  let deviceFingerprint = '';
  let microphoneGranted = false;
  let selectedMicrophone = '';
  let manualHeld = false;
  let manualStart: Promise<void> | undefined;
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let setupInitialized = false;
  let refreshing = false;
  const pendingPermissions = new Set<keyof AppState['permissions']>();

  function showError(error: unknown): void {
    element('error-message').textContent = errorText(error);
    errorPanel.hidden = false;
  }
  const action = (promise: Promise<unknown>) => { void promise.catch(showError); };
  function updateTranscript(text: string): void {
    displayedText = text;
    transcript.textContent = text || 'No transcripts yet.';
    copyButton.disabled = !text.trim() || state?.phase === 'starting' || state?.phase === 'recording' || state?.phase === 'transcribing';
  }
  function selectTab(tab: HTMLButtonElement): void {
    if (manualHeld) finishManual();
    tabs.forEach((item) => {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      element(item.getAttribute('aria-controls')!).hidden = !selected;
    });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
      selectTab(tabs[next]!);
      tabs[next]!.focus();
    });
  });
  function feedback(button: HTMLButtonElement): void {
    const label = button.querySelector('span');
    if (button === copyButton) { clearTimeout(copyTimer); }
    if (label) label.textContent = 'Copied';
    button.setAttribute('aria-label', 'Transcript copied');
    const reset = setTimeout(() => {
      if (label) label.textContent = 'Copy';
      button.setAttribute('aria-label', button === copyButton ? 'Copy latest transcript' : 'Copy transcript');
    }, 1400);
    if (button === copyButton) copyTimer = reset;
  }
  function renderHistory(next: AppState): void {
    const entries = next.history.slice(0, 10);
    element('history-count').textContent = entries.length ? `${entries.length} of 10` : '';
    const fingerprint = JSON.stringify(entries);
    if (fingerprint === historyFingerprint) return;
    historyFingerprint = fingerprint;
    const list = element('history-list');
    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-history'; empty.textContent = 'No transcripts yet.';
      list.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const article = document.createElement('article'); article.className = 'history-item';
      const meta = document.createElement('div'); meta.className = 'history-meta';
      const time = document.createElement('time'); time.dateTime = entry.timestamp;
      const date = new Date(entry.timestamp);
      const today = new Date().toDateString() === date.toDateString();
      time.textContent = Number.isNaN(date.getTime()) ? entry.timestamp : date.toLocaleString(undefined, { ...(today ? {} : { month: 'short', day: 'numeric' }), hour: 'numeric', minute: '2-digit' });
      const button = document.createElement('button'); button.type = 'button'; button.className = 'copy';
      button.setAttribute('aria-label', `Copy transcript from ${time.textContent}`);
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg><span>Copy</span>';
      button.addEventListener('click', () => action(api.copyTranscript(entry.id).then(() => feedback(button))));
      meta.append(time, button);
      const text = document.createElement('p'); text.textContent = entry.text;
      article.append(meta, text);
      if (entry.error || entry.logError) {
        const note = document.createElement('span'); note.className = 'history-note';
        note.textContent = entry.logError ? 'Couldn’t save to journal' : 'Not pasted';
        note.title = entry.logError || entry.error || '';
        article.appendChild(note);
      }
      list.appendChild(article);
    }
  }
  async function refreshMicrophones(): Promise<void> {
    if (enumerating) return;
    enumerating = true;
    try {
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
      const fingerprint = inputs.map((input) => `${input.deviceId}:${input.label}`).join('|');
      if (fingerprint !== deviceFingerprint) {
        deviceFingerprint = fingerprint;
        microphoneSelect.replaceChildren(new Option('Default', ''));
        inputs.filter((input) => input.deviceId !== 'default' && input.deviceId !== 'communications').forEach((input, index) => {
          microphoneSelect.appendChild(new Option(input.label || `Microphone ${index + 1}`, input.deviceId));
        });
      }
      if (state?.microphoneId && !Array.from(microphoneSelect.options).some((option) => option.value === state!.microphoneId)) microphoneSelect.appendChild(new Option('Unavailable microphone', state.microphoneId));
      microphoneSelect.value = state?.microphoneId || '';
      microphoneSelect.title = microphoneSelect.selectedOptions[0]?.textContent || 'Default microphone';
    } catch { /* A denied mic remains selectable as the system default. */ }
    finally { enumerating = false; }
  }
  function renderSetup(next: AppState): void {
    const checkingConnection = refreshing || /^checking codex sign-in/i.test(next.label.trim());

    const steps: [keyof AppState['permissions'], string, string, string][] = linux ? [
      ['microphone', 'microphone', 'Microphone', 'Captures your voice.'],
      ['accessibility', 'accessibility', 'Paste', 'Pastes with wtype or ydotool and wl-clipboard.'],
      ['inputMonitoring', 'input', 'Keyboard access', 'Detects your shortcut from /dev/input.'],
    ] : [
      ['microphone', 'microphone', 'Microphone', 'Captures your voice.'],
      ['accessibility', 'accessibility', 'Accessibility', 'Pastes into the focused app.'],
      ['inputMonitoring', 'input', 'Input Monitoring', 'Detects your shortcut across apps.'],
    ];

    // Linux has no permission prompts; these steps explain the fix and check again.
    const linuxFixes: Partial<Record<keyof AppState['permissions'], string>> = {
      accessibility: 'Install wtype and wl-clipboard (or run ydotoold), then check again.',
      inputMonitoring: 'Add your user to the input group, sign in again, then check again.',
    };
    const completed = Number(next.connected) + steps.filter(([kind]) => next.permissions[kind] === 'granted').length;
    const ready = completed === 4;
    element('setup-title').textContent = ready ? 'You’re ready' : `Set up ${PRODUCT_NAME}`;
    element('setup-description').textContent = ready ? `Hold ${hotkeyLabel(next.hotkey)} in any app to dictate.` : linux ? 'Connect your Codex account and check desktop access.' : 'Connect your Codex account and allow access on this Mac.';
    element('setup-count').textContent = checkingConnection ? 'Checking access…' : `${completed} of 4 ready`;
    element<HTMLProgressElement>('setup-progress').value = completed;
    element('setup-continue').hidden = !ready;
    element('setup-tab').dataset.incomplete = String(!ready);
    element('setup-tab').title = ready ? 'Setup complete' : 'Finish setup to dictate in any app';

    const accountStep = element('account-step');
    accountStep.classList.toggle('complete', next.connected);
    accountStep.querySelector('.step-mark')!.textContent = next.connected ? '✓' : '1';
    element('connection-label').textContent = next.connected ? 'Connected to your Codex account.' : checkingConnection ? 'Checking your Codex sign-in…' : 'Sign in to Codex, then reconnect.';
    element('connection-label').title = next.label;
    element('connection-state').hidden = !next.connected && !checkingConnection;
    element('connection-state').textContent = checkingConnection ? 'Checking…' : 'Connected';
    element('reconnect-button').hidden = next.connected || checkingConnection;
    element<HTMLButtonElement>('reconnect-button').disabled = refreshing;
    let nextStep = next.connected || checkingConnection ? undefined : accountStep;
    for (const [kind, prefix, label, description] of steps) {
      const permission = next.permissions[kind];
      const granted = permission === 'granted';
      const unavailable = permission === 'unavailable';
      const row = element(`${prefix}-step`);
      const button = element<HTMLButtonElement>(`${prefix}-permission`);
      const pending = pendingPermissions.has(kind);
      row.querySelector('h3')!.textContent = label;
      row.classList.toggle('complete', granted);
      row.querySelector('.step-mark')!.textContent = granted ? '✓' : String(steps.findIndex(([item]) => item === kind) + 2);
      element(`${prefix}-state`).hidden = !granted;
      button.hidden = granted;
      button.disabled = pending;
      button.setAttribute('aria-busy', String(pending));
      const recheck = unavailable || linux;
      button.textContent = pending ? (linux ? 'Checking…' : 'Opening…') : recheck ? 'Check again' : permission === 'denied' ? 'Open Settings' : 'Allow';
      button.setAttribute('aria-label', pending ? `Checking ${label}` : recheck ? `Check ${label} again` : permission === 'denied' ? `Open Settings for ${label}` : `Allow ${PRODUCT_NAME} to use ${label}`);
      element(`${prefix}-setup-detail`).textContent = unavailable ? (linux && kind === 'inputMonitoring' ? 'No keyboard found. Connect one, then check again.' : `Reopen ${PRODUCT_NAME} or check again.`)
        : permission === 'denied' ? (linux ? linuxFixes[kind] ?? description : `Enable ${PRODUCT_NAME} in Privacy & Security → ${label}.`) : description;
      if (!nextStep && !granted) nextStep = row;
    }
    [accountStep, ...steps.map(([, prefix]) => element(`${prefix}-step`))].forEach((row) => row.classList.toggle('is-next', row === nextStep));
    if (!setupInitialized && !checkingConnection) {
      setupInitialized = true;
      if (!ready) selectTab(element<HTMLButtonElement>('setup-tab'));
    }
  }
  function render(next: AppState): void {
    state = next;
    app.className = `app ${next.phase}`;
    const ready = next.connected && Object.values(next.permissions).every((permission) => permission === 'granted');
    const capturing = next.phase === 'starting' || next.phase === 'recording';
    const busy = capturing || next.phase === 'transcribing';
    element('status-label').textContent = next.phase === 'recording' ? 'Listening' : next.phase === 'starting' ? 'Starting' : next.phase === 'transcribing' ? 'Transcribing' : next.phase === 'error' ? 'Needs attention' : ready ? 'Ready' : 'Finish setup';
    renderSetup(next);
    hotkeySelect.value = next.hotkey;
    element('shortcut-key').textContent = hotkeyKey(next.hotkey, api.platform);
    recordButton.title = `Hold ${hotkeyLabel(next.hotkey)} anywhere, or hold this button to test`;
    loginSwitch.checked = next.launchAtLogin;
    element('log-location').textContent = next.logDirectory.replace(/^\/(Users|home)\/[^/]+/, '~');
    element('open-logs').title = `${next.logDirectory}/YYYY-MM.md`;
    recordButton.disabled = !next.connected || next.permissions.microphone !== 'granted' || next.phase === 'transcribing';
    recordButton.setAttribute('aria-pressed', String(capturing));
    recordButton.setAttribute('aria-label', capturing ? 'Release to finish recording' : next.phase === 'transcribing' ? 'Transcribing' : 'Hold to record a test transcript');
    hotkeySelect.disabled = busy;
    microphoneSelect.disabled = busy;
    loginSwitch.disabled = busy;
    element('record-button-label').textContent = next.phase === 'recording' ? 'Listening' : next.phase === 'starting' ? 'Starting' : next.phase === 'transcribing' ? 'Transcribing…' : 'Hold';
    element('transcript-status').textContent = busy ? 'Current' : next.history[0]?.logError ? 'Not saved' : 'Latest';
    element('recording-time').hidden = !busy;
    element('recording-time').textContent = `${Math.floor(next.elapsedSeconds / 60)}:${String(Math.floor(next.elapsedSeconds % 60)).padStart(2, '0')}`;
    const level = next.phase === 'recording' ? Math.min(1, Math.sqrt(next.level) * 1.7) : 0;
    bars.forEach((bar, index) => { const envelope = .4 + .6 * Math.sin((index / 4) * Math.PI); bar.style.height = `${4 + level * envelope * (10 + 7 * Math.abs(Math.sin(index + next.elapsedSeconds * 4)))}px`; });
    const latest = next.history[0];
    if (latest && (latest.id !== lastHistoryId || !busy)) { lastHistoryId = latest.id; updateTranscript(latest.text); }
    if (next.phase === 'error' && next.detail) showError(next.detail);
    if (next.phase === 'starting') { updateTranscript(''); errorPanel.hidden = true; }
    copyButton.disabled = busy || !displayedText.trim();
    renderHistory(next);
    if ((next.permissions.microphone === 'granted' && !microphoneGranted) || next.microphoneId !== selectedMicrophone) void refreshMicrophones();
    microphoneGranted = next.permissions.microphone === 'granted';
    selectedMicrophone = next.microphoneId;
  }
  function beginManual(): void {
    if (manualHeld || recordButton.disabled || (state?.phase !== 'idle' && state?.phase !== 'error')) return;
    manualHeld = true;
    manualStart = api.begin();
    void manualStart.catch((error) => { manualHeld = false; showError(error); });
  }
  function finishManual(): void {
    if (!manualHeld) return;
    manualHeld = false;
    // Wait for the begin request even if a pointer is released immediately.
    action((manualStart || Promise.resolve()).then(() => api.end()));
    manualStart = undefined;
  }
  recordButton.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    recordButton.setPointerCapture(event.pointerId);
    recordButton.focus();
    beginManual();
  });
  recordButton.addEventListener('pointerup', finishManual);
  recordButton.addEventListener('pointercancel', finishManual);
  recordButton.addEventListener('lostpointercapture', finishManual);
  recordButton.addEventListener('keydown', (event) => {
    if (event.code !== 'Space' && event.key !== 'Enter') return;
    event.preventDefault();
    if (!event.repeat) beginManual();
  });
  recordButton.addEventListener('keyup', (event) => {
    if (event.code !== 'Space' && event.key !== 'Enter') return;
    event.preventDefault(); finishManual();
  });
  recordButton.addEventListener('blur', finishManual);
  const refresh = () => {
    if (refreshing) return;
    refreshing = true;
    const button = element<HTMLButtonElement>('refresh-button');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Checking…';
    if (state) renderSetup(state);
    action(api.refresh().then(render).finally(() => {
      refreshing = false;
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
      button.textContent = 'Check again';
      if (state) renderSetup(state);
    }));
  };
  element('refresh-button').addEventListener('click', refresh);
  element('reconnect-button').addEventListener('click', refresh);
  element('setup-continue').addEventListener('click', () => {
    selectTab(element<HTMLButtonElement>('settings-tab'));
    recordButton.focus();
  });
  element('dismiss-error').addEventListener('click', () => { errorPanel.hidden = true; });
  element('open-logs').addEventListener('click', () => action(api.openLogs()));
  hotkeySelect.addEventListener('change', () => action(api.setSettings({ hotkey: hotkeySelect.value as Hotkey }).then(render)));
  microphoneSelect.addEventListener('change', () => action(api.setSettings({ microphoneId: microphoneSelect.value }).then(render)));
  loginSwitch.addEventListener('change', () => action(api.setSettings({ launchAtLogin: loginSwitch.checked }).then(render)));
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-permission]')) {
    button.addEventListener('click', () => {
      const kind = button.dataset.permission as keyof AppState['permissions'];
      if (pendingPermissions.has(kind)) return;
      pendingPermissions.add(kind);
      if (state) renderSetup(state);
      const request = state?.permissions[kind] === 'unavailable' || linux ? api.refresh().then(render) : state?.permissions[kind] === 'denied' ? api.openSettings(kind) : api.requestPermission(kind).then(render);
      action(request.finally(() => {
        pendingPermissions.delete(kind);
        if (state) renderSetup(state);
      }));
    });
  }
  copyButton.addEventListener('click', () => {
    if (!displayedText.trim()) return;
    const entry = state?.history.find((item) => item.text === displayedText);
    const promise = entry ? api.copyTranscript(entry.id) : navigator.clipboard.writeText(displayedText);
    action(promise.then(() => feedback(copyButton)));
  });
  navigator.mediaDevices.addEventListener('devicechange', () => { void refreshMicrophones(); });
  window.addEventListener('blur', finishManual);
  window.addEventListener('beforeunload', finishManual);
  window.addEventListener('focus', () => action(api.getState().then(render)));
  api.onEvent((event) => {
    if (event.type === 'state') render(event.state);
    else if (event.type === 'navigate') selectTab(element<HTMLButtonElement>(`${event.tab}-tab`));
    else if (event.type === 'partial' || event.type === 'final') { if (event.text !== undefined) updateTranscript(event.text); }
    else if (event.type === 'error') showError(event.text || event.detail || 'The dictation connection failed.');
  });
  action(api.getState().then(render));
  void refreshMicrophones();
}

if (api) {
  if (isRecorder) void runRecorder().catch((error) => console.error(errorText(error)));
  else runSettings();
} else {
  element('error-message').textContent = `Open the ${PRODUCT_NAME} app to connect to your Codex account.`;
  element('error-panel').hidden = false;
}

export {};
