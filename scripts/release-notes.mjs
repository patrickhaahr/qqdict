import { appendFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const release = resolve(process.argv[2] || 'release');
const files = (await readdir(release)).filter(name => /^release-metadata-(arm64|x64)\.json$/.test(name));
if (files.length !== 2) throw new Error('Both Apple Silicon and Intel release metadata are required.');
const builds = await Promise.all(files.map(name => readFile(join(release, name), 'utf8').then(JSON.parse)));
const { version } = builds[0];
if (builds.some(build => build.version !== version)) throw new Error('Release versions do not match.');
const stable = builds.every(build => build.signing === 'developer-id' && build.notarized
  && build.diskImageSigning === 'developer-id' && build.diskImageNotarized);
const signedPreview = builds.every(build => build.signing === 'developer-id'
  && build.diskImageSigning === 'developer-id');
const tag = process.env.GITHUB_REF_NAME || `v${version}`;
if (tag !== `v${version}`) throw new Error('The release tag must match package.json.');
const lines = [
  '# qqdict', '',
  'Hold a key. Speak. Release to paste.', '',
  'A small macOS dictation app with recent transcripts, a movable recording island, and a local Markdown journal.', '',
  '## Download', '',
];
for (const arch of ['arm64', 'x64']) {
  const name = `qqdict-${version}-mac-${arch}.dmg`;
  lines.push(`- [${arch === 'arm64' ? 'Apple Silicon (M1 or newer)' : 'Intel Mac'}](https://github.com/qwertyu-alex/qqdict/releases/download/${tag}/${name})`);
}
lines.push('', 'Requires macOS 13 or later. Open the DMG, drag qqdict to Applications, then launch it and complete the Setup tab.', '');
if (stable) lines.push('Signed with Developer ID and notarized by Apple. The app and DMG installer include stapled notarization tickets.', '');
else if (signedPreview) lines.push(
  '**Signed preview:** the apps and DMG installers are signed with Developer ID but are not yet notarized by Apple. macOS may block the first launch. If you trust the download, try opening qqdict once, choose Done if it is blocked, then go to System Settings → Privacy & Security → Open Anyway and confirm.', '',
);
else lines.push(
  '**Preview release:** this build is not notarized by Apple. macOS may block the first launch; after reviewing the source, use System Settings → Privacy & Security → Open Anyway. A Developer ID certificate and Apple notarization are required for the standard first-launch experience.', '',
);
lines.push(
  'Uses your existing local Codex sign-in. No API key is required. The current transcription connection uses an internal OpenAI endpoint and may change; qqdict is an independent project.', '',
  'Microphone, Accessibility, and Input Monitoring access are requested during Setup. Audio is sent to OpenAI for transcription; transcripts are stored on your Mac in `~/Dictation`.', '',
  'The attached ZIP files are an alternative to the DMG installers. SHA-256 checksum files and release metadata are included for both architectures.', '',
  '[Usage, privacy, and source build instructions](https://github.com/qwertyu-alex/qqdict#readme)', '',
);
console.log(lines.join('\n'));
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `prerelease=${!stable}\n`);
