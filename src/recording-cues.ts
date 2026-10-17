// A separate output context lets the stop cue finish after the microphone closes.
export async function playRecordingCue(cue: 'start' | 'stop'): Promise<void> {
  let context: AudioContext | undefined;
  try {
    context = new AudioContext({ latencyHint: 'interactive' });
    await context.resume();
    const tone = context.createOscillator();
    const volume = context.createGain();
    const now = context.currentTime;
    const duration = 0.1;
    tone.type = 'sine';
    tone.frequency.setValueAtTime(cue === 'start' ? 660 : 880, now);
    tone.frequency.exponentialRampToValueAtTime(cue === 'start' ? 880 : 660, now + duration);
    // A soft attack and release avoid clicks at either end.
    volume.gain.setValueAtTime(0, now);
    volume.gain.linearRampToValueAtTime(0.12, now + 0.01);
    volume.gain.linearRampToValueAtTime(0, now + duration);
    tone.connect(volume).connect(context.destination);
    await new Promise<void>((resolve) => {
      tone.onended = () => resolve();
      tone.start(now);
      tone.stop(now + duration);
    });
  } catch { /* Output failures must not prevent dictation. */ }
  finally {
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }
}
