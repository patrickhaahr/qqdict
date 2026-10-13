import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAppdmg } from './appdmg-adapter.mjs';
import { developerSigned, notarizationArguments, notarize, run, sign } from './macos-signing.mjs';

const appdmg = loadAppdmg();
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(project, 'release');
const arch = process.env.QQDICT_ARCH || process.arch;
const { version } = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
if (process.platform !== 'darwin') throw new Error('macOS disk images must be built on macOS.');
if (!['arm64', 'x64'].includes(arch)) throw new Error('QQDICT_ARCH must be arm64 or x64.');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version.');
const info = JSON.parse(await readFile(join(release, `build-info-${arch}.json`), 'utf8'));
if (info.arch !== arch || info.version !== version) throw new Error('Build qqdict.app for this version and architecture before creating installers.');
const requestedNotarization = notarizationArguments();
if (requestedNotarization && !info.notarized) throw new Error('Notarize qqdict.app before building a notarized installer.');
const bundle = join(release, 'qqdict.app');
const background = join(project, 'assets/dmg-background.png');
const icon = join(project, 'assets/AppIcon.icns');
await Promise.all([access(bundle), access(background), access(icon)]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
const stem = `qqdict-${version}-mac-${arch}`;
const staging = join(release, `.qqdict-installer-${arch}`);
await mkdir(staging, { recursive: true });
try {
  const stagedDmg = join(staging, `${stem}.dmg`);
  const stagedZip = join(staging, `${stem}.zip`);
  await rm(stagedDmg, { force: true });
  await rm(stagedZip, { force: true });
  console.log(`Creating the drag-to-Applications installer (${arch})…`);
  await new Promise((resolveImage, rejectImage) => {
    // appdmg writes Finder's metadata directly; it does not control Finder or
    // require AppleScript, Automation access, or an interactive login session.
    const image = appdmg({
      target: stagedDmg,
      basepath: project,
      specification: {
        title: 'qqdict', icon, background,
        'background-color': '#212121', 'icon-size': 88,
        window: { position: { x: 200, y: 180 }, size: { width: 660, height: 420 } },
        format: 'UDZO', filesystem: 'APFS',
        contents: [
          { x: 190, y: 200, type: 'file', path: bundle },
          { x: 470, y: 200, type: 'link', path: '/Applications' },
        ],
      },
    });
    image.once('finish', resolveImage);
    image.once('error', rejectImage);
  });
  if (developerSigned) sign(stagedDmg, { identifier: 'io.github.qwertyu-alex.qqdict.disk-image' });
  const diskImageNotarized = requestedNotarization ? notarize(stagedDmg) : false;
  run('/usr/bin/hdiutil', ['verify', stagedDmg]);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, stagedZip]);
  const artifacts = [];
  for (const staged of [stagedDmg, stagedZip]) {
    const filename = staged.slice(staged.lastIndexOf('/') + 1);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(staged)) hash.update(chunk);
    artifacts.push({ filename, sha256: hash.digest('hex'), bytes: (await stat(staged)).size });
    await rename(staged, join(release, filename));
  }
  await writeFile(join(release, `SHA256SUMS-${arch}.txt`), artifacts.map(item => `${item.sha256}  ${item.filename}\n`).join(''));
  await writeFile(join(release, `release-metadata-${arch}.json`), `${JSON.stringify({
    product: 'qqdict', version, arch, minimumMacOS: '13.0',
    signing: info.signing, notarized: info.notarized,
    diskImageSigning: developerSigned ? 'developer-id' : 'unsigned', diskImageNotarized,
    artifacts,
  }, null, 2)}\n`);
  console.log(`Created ${stem}.dmg and ${stem}.zip, with SHA-256 checksums.`);
  if (!info.notarized) console.log('Preview build: the app is not notarized by Apple.');
} finally {
  await rm(staging, { recursive: true, force: true });
}
