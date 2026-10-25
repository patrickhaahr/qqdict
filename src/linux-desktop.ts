import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';

export type DesktopWindow = { id: string; pid?: number; appId?: string };
export type WindowManager = { name: string; focused(): Promise<DesktopWindow | null>; focus(id: string): Promise<void> };
export type PasteTool = { name: 'wtype' | 'ydotool'; paste(terminal: boolean): Promise<void> };

const TIMEOUT = 1500;

export function run(command: string, args: string[], input?: Buffer, maxBuffer = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: 'buffer', timeout: TIMEOUT, maxBuffer }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
    if (input) child.stdin?.end(input); else child.stdin?.end();
  });
}

const json = async (command: string, args: string[]): Promise<unknown> => JSON.parse((await run(command, args)).toString('utf8'));

export function parseNiriWindow(value: unknown): DesktopWindow | null {
  if (!value || typeof value !== 'object') return null;
  const window = value as { id?: unknown; pid?: unknown; app_id?: unknown };
  if (typeof window.id !== 'number') return null;
  return { id: String(window.id), pid: typeof window.pid === 'number' ? window.pid : undefined, appId: typeof window.app_id === 'string' ? window.app_id : undefined };
}

export function parseHyprlandWindow(value: unknown): DesktopWindow | null {
  if (!value || typeof value !== 'object') return null;
  const window = value as { address?: unknown; pid?: unknown; class?: unknown };
  if (typeof window.address !== 'string' || !window.address) return null;
  return { id: window.address, pid: typeof window.pid === 'number' && window.pid > 0 ? window.pid : undefined, appId: typeof window.class === 'string' ? window.class : undefined };
}

export function parseSwayTree(value: unknown): DesktopWindow | null {
  type Node = { id?: unknown; pid?: unknown; app_id?: unknown; focused?: unknown; type?: unknown; nodes?: Node[]; floating_nodes?: Node[]; window_properties?: { class?: unknown } };
  const stack: Node[] = value && typeof value === 'object' ? [value as Node] : [];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.focused === true && (node.type === 'con' || node.type === 'floating_con') && typeof node.id === 'number') {
      const appId = typeof node.app_id === 'string' ? node.app_id : typeof node.window_properties?.class === 'string' ? node.window_properties.class : undefined;
      return { id: String(node.id), pid: typeof node.pid === 'number' ? node.pid : undefined, appId };
    }
    stack.push(...(node.nodes ?? []), ...(node.floating_nodes ?? []));
  }
  return null;
}

/** Window-manager IPC, used to confirm the paste target still has focus. */
export function detectWindowManager(env: NodeJS.ProcessEnv = process.env): WindowManager | null {
  if (env.NIRI_SOCKET) return {
    name: 'niri',
    focused: async () => parseNiriWindow(await json('niri', ['msg', '--json', 'focused-window'])),
    focus: async (id) => { await run('niri', ['msg', 'action', 'focus-window', '--id', id]); },
  };
  if (env.HYPRLAND_INSTANCE_SIGNATURE) return {
    name: 'Hyprland',
    focused: async () => parseHyprlandWindow(await json('hyprctl', ['-j', 'activewindow'])),
    focus: async (id) => { await run('hyprctl', ['dispatch', 'focuswindow', `address:${id}`]); },
  };
  if (env.SWAYSOCK) return {
    name: 'sway',
    focused: async () => parseSwayTree(await json('swaymsg', ['-r', '-t', 'get_tree'])),
    focus: async (id) => { await run('swaymsg', [`[con_id=${id}]`, 'focus']); },
  };
  return null;
}

// Terminals bind Ctrl+V to a literal-next character, so they need Ctrl+Shift+V.
const TERMINALS = /(^|[.-])(alacritty|blackbox|contour|foot|footclient|ghostty|kitty|konsole|kgx|console|ptyxis|rio|st|terminal|terminator|termite|tilix|urxvt|wezterm|xterm)$/i;

export function isTerminal(appId: string | undefined): boolean {
  return !!appId && TERMINALS.test(appId);
}

export async function onPath(command: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try { await access(path.join(directory, command), constants.X_OK); return true; } catch { /* Keep looking. */ }
  }
  return false;
}

function ydotoolSocket(env: NodeJS.ProcessEnv): string {
  return env.YDOTOOL_SOCKET ?? (env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, '.ydotool_socket') : '/tmp/.ydotool_socket');
}

/**
 * wtype uses the Wayland virtual-keyboard protocol (wlroots compositors, niri).
 * ydotool covers GNOME and KDE through its uinput daemon. `wtype -s 1` connects
 * and uploads a keymap without sending a key.
 */
export async function detectPasteTool(env: NodeJS.ProcessEnv = process.env): Promise<PasteTool | null> {
  if (env.WAYLAND_DISPLAY && await onPath('wtype', env)) {
    try {
      await run('wtype', ['-s', '1']);
      return {
        name: 'wtype',
        paste: async (terminal) => {
          await run('wtype', terminal ? ['-M', 'ctrl', '-M', 'shift', '-k', 'v', '-m', 'shift', '-m', 'ctrl'] : ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl']);
        },
      };
    } catch { /* The compositor lacks virtual-keyboard support. */ }
  }
  if (await onPath('ydotool', env)) {
    try {
      await access(ydotoolSocket(env), constants.W_OK);
      // Raw evdev codes: Left Ctrl 29, Left Shift 42, V 47.
      return {
        name: 'ydotool',
        paste: async (terminal) => {
          await run('ydotool', ['key', ...(terminal ? ['29:1', '42:1', '47:1', '47:0', '42:0', '29:0'] : ['29:1', '47:1', '47:0', '29:0'])]);
        },
      };
    } catch { /* ydotoold is not running for this user. */ }
  }
  return null;
}
