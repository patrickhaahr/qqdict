import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);

async function releaseNotes(t, version, notarized) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qqdict-notes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const arch of ['arm64', 'x64']) await writeFile(path.join(directory, `release-metadata-${arch}.json`), JSON.stringify({
    version, arch, signing: 'developer-id', diskImageSigning: 'developer-id', notarized, diskImageNotarized: notarized,
  }));
  const output = path.join(directory, 'outputs.txt');
  const { stdout } = await execute(process.execPath, ['scripts/release-notes.mjs', directory], {
    env: { ...process.env, GITHUB_REF_NAME: `v${version}`, GITHUB_OUTPUT: output },
  });
  return { notes: stdout, outputs: await readFile(output, 'utf8') };
}

test('a notarized stable version can be published to the stable update feed', async (t) => {
  const result = await releaseNotes(t, '0.5.6', true);
  assert.equal(result.outputs, 'prerelease=false\n');
  assert.match(result.notes, /Signed with Developer ID and notarized by Apple/);
});

test('a notarized beta remains a prerelease while retaining its correct signing description', async (t) => {
  const result = await releaseNotes(t, '0.5.6-beta.1', true);
  assert.equal(result.outputs, 'prerelease=true\n');
  assert.match(result.notes, /Signed with Developer ID and notarized by Apple/);
  assert.doesNotMatch(result.notes, /not yet notarized/);
});

test('a signed version without notarization cannot enter the stable update feed', async (t) => {
  const result = await releaseNotes(t, '0.5.6', false);
  assert.equal(result.outputs, 'prerelease=true\n');
  assert.match(result.notes, /not yet notarized/);
});
