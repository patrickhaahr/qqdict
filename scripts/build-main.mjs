import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { buildIdentity } from './build-channel.mjs';

const { channel } = buildIdentity();
await build({
  entryPoints: ['src/main.ts', 'src/preload.ts', 'src/probe.ts', 'src/linux-bridge.ts'],
  bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  external: ['electron', 'ws'], outdir: 'dist',
  define: { 'process.env.QQDICT_CHANNEL': JSON.stringify(channel) },
});
await writeFile('dist/build-identity.json', `${JSON.stringify(buildIdentity(), null, 2)}\n`);
