import type { AppState } from './contracts';

const pill = document.getElementById('dictation-pill')!;
const label = document.getElementById('pill-label')!;
const wave = document.getElementById('wave')!;
const bars = Array.from({ length: 5 }, () => {
  const bar = document.createElement('span');
  wave.appendChild(bar);
  return bar;
});

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
  pill.className = `pill ${state.phase}`;
  label.textContent = statusText(state);
  label.setAttribute('aria-label', state.detail || statusText(state));
  const level = state.phase === 'recording' ? Math.min(1, Math.sqrt(Math.max(0, state.level)) * 2) : 0;
  bars.forEach((bar, index) => {
    const envelope = .4 + .6 * Math.sin(index / 4 * Math.PI);
    const motion = .6 + .4 * Math.abs(Math.sin(index * .73 + performance.now() / 150));
    bar.style.height = `${4 + level * envelope * motion * 12}px`;
  });
}

window.dictation.onEvent((event) => { if (event.type === 'state') render(event.state); });
void window.dictation.getState().then(render).catch(() => {
  label.textContent = 'Connection unavailable';
});
