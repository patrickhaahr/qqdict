import type { Hotkey } from './contracts';

// Linux keyboards rarely expose fn to the OS, and Right Alt is AltGr on many
// layouts, so Linux defaults to Right Ctrl.
const MAC_HOTKEYS = ['fn', 'right-option', 'ctrl-option'] as const satisfies readonly Hotkey[];
const LINUX_HOTKEYS = ['right-ctrl', 'right-option', 'ctrl-option'] as const satisfies readonly Hotkey[];

/** Shortcuts that the platform helper can detect. */
export function supportedHotkeys(platform: string): readonly Hotkey[] {
  return platform === 'linux' ? LINUX_HOTKEYS : MAC_HOTKEYS;
}

/** Default hold gesture for the current platform. */
export function defaultHotkey(platform: string): Hotkey {
  return platform === 'linux' ? LINUX_HOTKEYS[0] : MAC_HOTKEYS[0];
}

/** Full name, as used in settings and sentences. */
export function hotkeyName(hotkey: Hotkey, platform: string): string {
  switch (hotkey) {
    case 'fn': return 'fn';
    case 'right-option': return platform === 'linux' ? 'Right Alt' : 'Right Option';
    case 'ctrl-option': return platform === 'linux' ? 'Ctrl + Alt' : 'Control + Option';
    case 'right-ctrl': return platform === 'linux' ? 'Right Ctrl' : 'Right Control';
  }
}

/** Compact key-cap label. */
export function hotkeyKey(hotkey: Hotkey, platform: string): string {
  if (platform === 'linux') return hotkey === 'ctrl-option' ? 'Ctrl Alt' : hotkeyName(hotkey, platform);
  switch (hotkey) {
    case 'fn': return 'fn';
    case 'right-option': return 'Right ⌥';
    case 'ctrl-option': return '⌃ ⌥';
    case 'right-ctrl': return 'Right ⌃';
  }
}
