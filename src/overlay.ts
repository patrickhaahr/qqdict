import type { AppState } from './contracts';

const pill = document.getElementById('dictation-pill')!;
const label = document.getElementById('pill-label')!;
const time = document.getElementById('pill-time')!;
const copy = document.getElementById('pill-copy') as HTMLButtonElement;
const wave = document.getElementById('wave')!;
const bars = Array.from({ length: 5 }, () => {
  const bar = document.createElement('span');
  wave.appendChild(bar);
  return bar;
});
const copyLabel = 'Copy last transcript';
let currentState: AppState | null = null;
let context = '';
let copyVersion = 0;
let copying = false;
let feedback: 'copied' | 'failed' | null = null;
let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
let hovered = false;
let drag: { pointerId: number; screenX: number; screenY: number; moved: boolean } | null = null;
let moveFrame: number | null = null;
let suppressPointerClick = false;

function clearFeedback(): void {
  clearTimeout(feedbackTimer);
  copyVersion++;
  copying = false;
  feedback = null;
}

function statusText(state: AppState): string {
  if (state.phase === 'starting') return 'Getting ready';
  if (state.phase === 'recording') return 'Listening';
  if (state.phase === 'transcribing') return 'Transcribing';
  if (state.phase === 'error') return 'Couldn’t finish';
  if (state.detail === 'Cancelled') return 'Cancelled';
  if (state.detail === 'No speech detected.') return 'No speech detected';
  if (state.detail.startsWith('Pasted')) return 'Pasted';
  if (state.detail.startsWith('Saved to history')) return 'Transcript saved';
  if (state.detail.startsWith('Transcript ready')) return 'Transcript ready';
  return 'Ready';
}

function render(state: AppState): void {
  const nextContext = `${state.phase}|${state.history[0]?.id ?? ''}|${state.detail}`;
  if (nextContext !== context) clearFeedback();
  context = nextContext;
  currentState = state;
  pill.className = `pill ${state.phase}`;
  const text = feedback === 'copied' ? 'Copied' : feedback === 'failed' ? 'Couldn’t copy' : statusText(state);
  label.textContent = text;
  const description = feedback === 'failed' ? 'Try copying again.' : state.detail;
  pill.title = description;
  label.setAttribute('aria-label', description && description !== text ? `${text}. ${description}` : text);
  const seconds = Math.max(0, Math.floor(state.elapsedSeconds));
  time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  time.setAttribute('aria-label', `Recording duration: ${seconds} seconds`);
  copy.disabled = copying || !state.history[0] || state.phase === 'starting' || state.phase === 'recording' || state.phase === 'transcribing';
  copy.dataset.copied = String(feedback === 'copied');
  copy.title = feedback === 'copied' ? 'Copied' : feedback === 'failed' ? 'Copy failed — try again' : copyLabel;
  copy.setAttribute('aria-label', feedback === 'copied' ? 'Transcript copied' : copy.title);
  const level = state.phase === 'recording' ? Math.min(1, Math.sqrt(Math.max(0, state.level)) * 2) : 0;
  bars.forEach((bar, index) => {
    const envelope = .4 + .6 * Math.sin(index / 4 * Math.PI);
    const motion = .6 + .4 * Math.abs(Math.sin(index * .73 + performance.now() / 150));
    bar.style.height = `${4 + level * envelope * motion * 12}px`;
  });
}

function finishDrag(): void {
  const finished = drag;
  if (!finished) return;
  drag = null;
  if (moveFrame !== null) cancelAnimationFrame(moveFrame);
  moveFrame = null;
  // Flush the last trusted cursor position before asking the main process to snap.
  if (finished.moved) window.dictation.moveOverlayDrag();
  window.dictation.endOverlayDrag();
  pill.dataset.dragging = 'false';
  if (pill.hasPointerCapture(finished.pointerId)) pill.releasePointerCapture(finished.pointerId);
  window.dictation.holdOverlay(hovered);
}

pill.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !event.isPrimary) return;
  // A fresh press on Copy remains an ordinary button interaction, even just after a drag.
  suppressPointerClick = false;
  if (event.target instanceof Element && event.target.closest('button')) return;
  if (drag) return;
  event.preventDefault();
  drag = { pointerId: event.pointerId, screenX: event.screenX, screenY: event.screenY, moved: false };
  pill.setPointerCapture(event.pointerId);
  window.dictation.holdOverlay(true);
  // Capture the cursor origin at press time; no move IPC is sent for a simple click.
  window.dictation.beginOverlayDrag();
});

pill.addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.moved && Math.hypot(event.screenX - drag.screenX, event.screenY - drag.screenY) < 4) return;
  drag.moved = true;
  suppressPointerClick = true;
  pill.dataset.dragging = 'true';
  event.preventDefault();
  if (moveFrame !== null) return;
  moveFrame = requestAnimationFrame(() => {
    moveFrame = null;
    if (drag?.moved) window.dictation.moveOverlayDrag();
  });
});

pill.addEventListener('pointerup', (event) => { if (event.pointerId === drag?.pointerId) finishDrag(); });
pill.addEventListener('pointercancel', (event) => { if (event.pointerId === drag?.pointerId) finishDrag(); });
pill.addEventListener('lostpointercapture', (event) => { if (event.pointerId === drag?.pointerId) finishDrag(); });
pill.addEventListener('click', (event) => {
  if (!suppressPointerClick || event.detail === 0) return;
  suppressPointerClick = false;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

copy.addEventListener('click', async () => {
  const state = currentState;
  const latest = state?.history[0];
  if (!state || !latest || copy.disabled) return;
  clearFeedback();
  copying = true;
  const version = ++copyVersion;
  const clickedContext = context;
  render(state);
  let succeeded = false;
  try {
    await window.dictation.copyTranscript(latest.id);
    succeeded = true;
  } catch { /* Keep recovery in the island without stealing the writing app’s focus. */ }
  if (version !== copyVersion || clickedContext !== context || currentState?.history[0]?.id !== latest.id) return;
  copying = false;
  feedback = succeeded ? 'copied' : 'failed';
  render(currentState);
  feedbackTimer = setTimeout(() => {
    clearFeedback();
    if (currentState) render(currentState);
  }, 1500);
});

pill.addEventListener('mouseenter', () => { hovered = true; window.dictation.holdOverlay(true); });
pill.addEventListener('mouseleave', () => { hovered = false; window.dictation.holdOverlay(drag !== null); });
window.addEventListener('beforeunload', () => { finishDrag(); window.dictation.holdOverlay(false); });
window.dictation.onEvent((event) => { if (event.type === 'state') render(event.state); });
void window.dictation.getState().then(render).catch(() => {
  label.textContent = 'Connection unavailable';
  copy.disabled = true;
});
