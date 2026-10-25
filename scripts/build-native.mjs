import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only macOS has a compiled helper. The Linux helper is TypeScript, bundled by
// `pnpm run build` into dist/linux-bridge.js.
if (process.platform !== 'darwin') process.exit(0);

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('zsh', ['native/build.sh'], { cwd: project, stdio: 'inherit' });

process.exit(result.status ?? 1);
