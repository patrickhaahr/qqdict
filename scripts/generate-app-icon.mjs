import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argumentsList = process.argv.slice(2);
if (argumentsList.includes('--help')) {
  console.log('Usage: npm run build:icon -- [--input master.png] [--output AppIcon.icns]');
  console.log('Defaults: assets/app-icon.png → assets/AppIcon.icns. Requires a square PNG of at least 1024 × 1024 on macOS.');
  process.exit(0);
}
if (process.platform !== 'darwin') throw new Error('App icon generation requires macOS sips and iconutil.');

let input = join(project, 'assets/app-icon.png');
let output = join(project, 'assets/AppIcon.icns');
for (let index = 0; index < argumentsList.length; index++) {
  const flag = argumentsList[index];
  const value = argumentsList[++index];
  if (!['--input', '--output'].includes(flag) || !value || value.startsWith('--')) {
    throw new Error('Use --input master.png and/or --output AppIcon.icns.');
  }
  if (flag === '--input') input = resolve(value);
  else output = resolve(value);
}
if (input === output || extname(output).toLowerCase() !== '.icns') {
  throw new Error('Choose a separate .icns output; the source PNG is never modified.');
}

const png = await readFile(input);
if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) < 1024 || png.readUInt32BE(16) !== png.readUInt32BE(20)) {
  throw new Error('The master icon must be a square PNG of at least 1024 × 1024 pixels.');
}

const work = join(project, 'work');
await mkdir(work, { recursive: true });
await mkdir(dirname(output), { recursive: true });
const staging = await mkdtemp(join(work, 'app-icon-'));
const iconset = join(staging, 'AppIcon.iconset');
const stagedOutput = join(staging, 'AppIcon.icns');
const destinationStaging = join(dirname(output), `.qqdict-icon-${randomUUID()}.icns`);
try {
  await mkdir(iconset);
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = points * scale;
      const name = `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`;
      execFileSync('/usr/bin/sips', ['-z', String(pixels), String(pixels), input, '--out', join(iconset, name)], { stdio: 'pipe' });
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', stagedOutput], { stdio: 'pipe' });
  const icns = await readFile(stagedOutput);
  if (icns.length < 8 || icns.toString('ascii', 0, 4) !== 'icns' || icns.readUInt32BE(4) !== icns.length) {
    throw new Error('iconutil did not produce a valid ICNS file.');
  }
  // Keep the final rename on the output filesystem, even for a custom path.
  await copyFile(stagedOutput, destinationStaging, constants.COPYFILE_EXCL);
  await rename(destinationStaging, output);
  console.log(`Generated ${output} from ${input} (16–1024 pixels, standard and Retina representations).`);
} finally {
  await rm(destinationStaging, { force: true });
  await rm(staging, { recursive: true, force: true });
}
