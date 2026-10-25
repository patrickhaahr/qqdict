import type { Hotkey } from './contracts';

// Linux input-event-codes.h values for the keys qqdict listens to.
export const KEY = {
  LEFTCTRL: 29, LEFTSHIFT: 42, RIGHTSHIFT: 54, LEFTALT: 56,
  RIGHTCTRL: 97, RIGHTALT: 100, LEFTMETA: 125, RIGHTMETA: 126,
} as const;

export const MODIFIER_KEYS: ReadonlySet<number> = new Set(Object.values(KEY));
const EV_SYN = 0, EV_KEY = 1, SYN_DROPPED = 3;

// Codes from 0x100 are buttons (mouse, gamepad), not keyboard keys.
const FIRST_BUTTON = 0x100;

export type Keyboard = { name: string; event: string };

export type InputChange = { kind: 'key'; code: number; value: number } | { kind: 'dropped' };

/**
 * Picks keyboards from /proc/bus/input/devices: `kbd` handlers with EV_KEY and
 * at least one modifier key. Word size is the kernel's `long`.
 */
export function parseKeyboards(text: string, wordBits = 64): Keyboard[] {
  const keyboards: Keyboard[] = [];

  for (const block of text.split(/\n\s*\n/)) {
    const name = /^N: Name="(.*)"$/m.exec(block)?.[1] ?? 'Keyboard';
    const handlers = /^H: Handlers=(.*)$/m.exec(block)?.[1]?.trim().split(/\s+/) ?? [];
    const event = handlers.find((handler) => /^event\d+$/.test(handler));
    const ev = /^B: EV=([0-9a-f]+)$/m.exec(block)?.[1];
    const keys = /^B: KEY=([0-9a-f ]+)$/m.exec(block)?.[1]?.trim().split(/\s+/);

    if (!event || !handlers.includes('kbd') || !ev || !keys) continue;

    if (!hasBit([ev], EV_KEY, wordBits)) continue;

    if (![KEY.LEFTCTRL, KEY.RIGHTCTRL, KEY.LEFTALT, KEY.RIGHTALT].some((code) => hasBit(keys, code, wordBits))) continue;
    keyboards.push({ name, event });
  }

  return keyboards;
}

function hasBit(words: string[], bit: number, wordBits: number): boolean {
  const index = words.length - 1 - Math.floor(bit / wordBits);

  if (index < 0) return false;

  return ((BigInt(`0x${words[index]}`) >> BigInt(bit % wordBits)) & 1n) === 1n;
}

/** Decodes `struct input_event` records; `timeval` is two longs before type, code and value. */
export function decodeInputEvents(buffer: Buffer, wordBytes = 8): InputChange[] {
  const size = wordBytes * 2 + 8;
  const changes: InputChange[] = [];

  for (let offset = 0; offset + size <= buffer.length; offset += size) {
    const type = buffer.readUInt16LE(offset + wordBytes * 2);
    const code = buffer.readUInt16LE(offset + wordBytes * 2 + 2);
    const value = buffer.readInt32LE(offset + wordBytes * 2 + 4);

    if (type === EV_KEY && code < FIRST_BUTTON) changes.push({ kind: 'key', code, value });
    else if (type === EV_SYN && code === SYN_DROPPED) changes.push({ kind: 'dropped' });
  }

  return changes;
}

export function hotkeyPressed(hotkey: Hotkey, pressed: ReadonlySet<number>): boolean {
  switch (hotkey) {
    case 'right-ctrl': return pressed.has(KEY.RIGHTCTRL);
    case 'right-option': return pressed.has(KEY.RIGHTALT);
    case 'ctrl-option': return (pressed.has(KEY.LEFTCTRL) || pressed.has(KEY.RIGHTCTRL)) && (pressed.has(KEY.LEFTALT) || pressed.has(KEY.RIGHTALT));
    case 'fn': return false;
  }
}

/**
 * Hold-to-talk reducer. Pressing an ordinary key while the shortcut is held
 * means the user typed a chord such as Ctrl+C, so the take is cancelled.
 */
export class HoldHotkeyState {
  hotkey: Hotkey = 'right-ctrl';
  private heldState = false;
  private interrupted = false;

  get held(): boolean { return this.heldState; }

  update(pressed: ReadonlySet<number>, change?: InputChange): 'down' | 'up' | 'cancel' | null {
    const active = hotkeyPressed(this.hotkey, pressed);

    if (active !== this.heldState) {
      this.heldState = active;
      this.interrupted = false;

      return active ? 'down' : 'up';
    }

    if (this.heldState && !this.interrupted && change?.kind === 'key' && change.value === 1 && !MODIFIER_KEYS.has(change.code)) {
      this.interrupted = true;

      return 'cancel';
    }

    return null;
  }

  release(): 'up' | null {
    if (!this.heldState) return null;
    this.heldState = false;
    this.interrupted = false;

    return 'up';
  }
}
