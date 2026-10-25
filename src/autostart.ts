import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUILD_IDENTITY, PRODUCT_NAME } from './product';

/** Marks a launch from the XDG autostart entry, like macOS's wasOpenedAtLogin. */
export const AUTOSTART_FLAG = '--autostart';

export function autostartFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', `${BUILD_IDENTITY.slug}.desktop`);
}

// Desktop Entry Exec quoting: quote reserved characters, then escape for the
// quoted form.
function execArgument(argument: string): string {
  if (!/[\s"'\\><~|&;$*?#()`=%]/.test(argument)) return argument;
  return `"${argument.replace(/(["`$\\])/g, '\\$1')}"`;
}

export function desktopEntry(launcher: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${PRODUCT_NAME}`,
    'Comment=Push-to-talk dictation',
    `Exec=${execArgument(launcher)} ${AUTOSTART_FLAG}`,
    `Icon=${PRODUCT_NAME}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export async function readAutostart(file = autostartFile()): Promise<boolean> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return false; }
  // Desktop settings may disable an entry instead of deleting it.
  return !/^Hidden\s*=\s*true\s*$/m.test(text) && !/^X-GNOME-Autostart-enabled\s*=\s*false\s*$/m.test(text);
}

/** Writes the entry for `launcher`, or removes it when undefined. */
export async function writeAutostart(launcher: string | undefined, file = autostartFile()): Promise<void> {
  if (!launcher) { await rm(file, { force: true }); return; }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, desktopEntry(launcher), 'utf8');
}
