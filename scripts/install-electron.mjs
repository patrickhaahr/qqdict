import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Distributions such as NixOS supply their own Electron: set
// ELECTRON_SKIP_BINARY_DOWNLOAD=1 and point ELECTRON_OVERRIDE_DIST_PATH at it.
// The downloaded Linux binary cannot run on NixOS.
if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) process.exit(0);
const require = createRequire(import.meta.url);
const result = spawnSync(process.execPath, [require.resolve('electron/install.js')], { stdio: 'inherit' });
process.exit(result.status ?? 1);
