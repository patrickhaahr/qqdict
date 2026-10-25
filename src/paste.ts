import { setTimeout as delay } from 'node:timers/promises';
import { bridgeErrorMessage, type NativeBridge, type FocusTarget } from './native';

let clipboardQueue: Promise<void> = Promise.resolve();

export function pasteTranscript(bridge: NativeBridge, text: string, target: FocusTarget, signal?: AbortSignal): Promise<void> {
  // A cancelled take still owns its clipboard snapshot until cleanup finishes.
  const operation = clipboardQueue.then(() => pasteOnce(bridge, text, target, signal));
  clipboardQueue = operation.catch(() => {});
  return operation;
}

async function pasteOnce(bridge: NativeBridge, text: string, target: FocusTarget, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (target.secure) throw new Error('The target is a protected field. Copy the transcript from the menu bar if needed.');
  // The helper validates the captured window itself; Linux may lack a window PID.
  if (!target.focusId) throw new Error(bridgeErrorMessage(target.focusError) ?? 'Automatic paste needs Accessibility access and a focused text field. Your transcript is saved.');
  const insertion = text.trim();
  if (!insertion) return;
  const staged = await bridge.request<{ changeCount: number; restoreAvailable: boolean }>('stageClipboard', {
    text: insertion + ' ', targetPid: target.targetPid, focusId: target.focusId,
  });
  try {
    await delay(70, undefined, { signal });
    signal?.throwIfAborted();
    // The helper checks this version immediately before posting the paste key. A user
    // Copy during transcription must never be pasted as the dictated text.
    await bridge.request('paste', { targetPid: target.targetPid, focusId: target.focusId, changeCount: staged.changeCount });
    await delay(700);
  } finally {
    // Mutation-count guard preserves anything the user copies in the meantime.
    await bridge.request('restoreClipboard', { changeCount: staged.changeCount }).catch(() => {});
  }
}
