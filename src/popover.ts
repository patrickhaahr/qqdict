import type { AppState, Hotkey, TranscriptEntry } from './contracts';

const api = window.dictation;
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const copyIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="9" rx="1.5"/><path d="M3.5 11H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v.5"/></svg>';
const checkIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>';
const hotkeyLabel = (hotkey: Hotkey): string => hotkey === 'fn' ? 'fn' : hotkey === 'right-option' ? 'Right ⌥' : '⌃ + ⌥';
let historyFingerprint: string | undefined;
let operationError = '';
let lastPhase: AppState['phase'] | undefined;
let latestState: AppState | undefined;

function announce(message: string): void {
  element('announcement').textContent = message;
}

function renderError(): void {
  const error = latestState?.phase === 'error' ? latestState.detail || operationError : operationError;
  element('popover-error').textContent = error;
  element('popover-error').hidden = !error;
}

function showError(error: unknown): void {
  operationError = error instanceof Error ? error.message : String(error);
  renderError();
}

function timeLabel(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)} · ${time}`;
}

function transcriptRow(entry: TranscriptEntry): HTMLElement {
  const row = document.createElement('article');
  row.className = 'transcript-row';
  const meta = document.createElement('div');
  meta.className = 'transcript-meta';
  const time = document.createElement('time');
  time.className = 'transcript-time';
  time.dateTime = entry.timestamp;
  time.textContent = timeLabel(entry.timestamp);
  time.title = new Date(entry.timestamp).toLocaleString();
  const button = document.createElement('button');
  button.className = 'icon-button copy-button';
  button.type = 'button';
  button.innerHTML = copyIcon;
  const label = `Copy transcript from ${time.title}`;
  button.setAttribute('aria-label', label);
  button.title = 'Copy transcript';
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', () => {
    button.disabled = true;
    void api.copyTranscript(entry.id).then(() => {
      operationError = '';
      renderError();
      clearTimeout(feedbackTimer);
      button.innerHTML = checkIcon;
      button.dataset.copied = 'true';
      button.title = 'Copied';
      button.setAttribute('aria-label', 'Transcript copied');
      announce('Transcript copied');
      feedbackTimer = setTimeout(() => {
        button.innerHTML = copyIcon;
        delete button.dataset.copied;
        button.title = 'Copy transcript';
        button.setAttribute('aria-label', label);
      }, 1400);
    }).catch((error: unknown) => {
      showError(error);
      announce('Couldn’t copy transcript');
    }).finally(() => { button.disabled = false; });
  });
  meta.append(time, button);
  const text = document.createElement('p');
  text.className = 'transcript-text';
  text.textContent = entry.text;
  row.append(meta, text);
  if (entry.error || entry.logError) {
    const warning = document.createElement('p');
    warning.className = 'transcript-warning';
    warning.textContent = entry.error && entry.logError
      ? 'Couldn’t paste or save the journal. Copy above.'
      : entry.logError ? 'Journal not saved. Copy above.' : 'Couldn’t paste. Copy above.';
    warning.title = [entry.error, entry.logError].filter(Boolean).join('\n');
    row.append(warning);
  }
  return row;
}

function render(state: AppState): void {
  latestState = state;
  const ready = state.connected && Object.values(state.permissions).every((permission) => permission === 'granted');
  document.body.dataset.phase = state.phase;
  element('state-label').textContent = state.phase === 'recording' ? 'Listening'
    : state.phase === 'starting' ? 'Starting'
      : state.phase === 'transcribing' ? 'Transcribing'
        : state.phase === 'error' ? 'Needs attention'
          : ready ? 'Ready' : 'Setup needed';
  element('settings-button').setAttribute('aria-label', ready ? 'Open settings' : 'Finish qqdict setup');
  element('settings-button').title = ready ? 'Settings' : 'Finish setup';
  const shortcut = hotkeyLabel(state.hotkey);
  element('hotkey-label').textContent = shortcut;
  element('shortcut-hint').setAttribute('aria-label', `Hold ${shortcut} to dictate`);
  if (state.phase !== lastPhase) operationError = '';
  lastPhase = state.phase;
  renderError();
  const entries = state.history.slice(0, 10);
  const fingerprint = JSON.stringify(entries);
  if (fingerprint === historyFingerprint) return;
  historyFingerprint = fingerprint;
  if (entries.length) {
    element('history').replaceChildren(...entries.map(transcriptRow));
  } else {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No transcripts yet';
    element('history').replaceChildren(empty);
  }
}

element('settings-button').addEventListener('click', () => { void api.showSettings().catch(showError); });
element('journal-button').addEventListener('click', () => { void api.openLogs().catch(showError); });
element('quit-button').addEventListener('click', () => { void api.quit().catch(showError); });
api.onEvent((event) => { if (event.type === 'state') render(event.state); });
void api.getState().then(render).catch(showError);
window.addEventListener('focus', () => { void api.getState().then(render).catch(showError); });
