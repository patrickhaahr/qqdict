import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const workflow = await readFile('.github/workflows/release.yml', 'utf8');
const publish = workflow.split('      - name: Publish installers\n')[1].split('        run: |\n')[1].replace(/^ {10}/gm, '');

async function publication(t, { existing = 'absent', preview = false, signed = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qqdict-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = path.join(directory, 'release');
  await mkdir(release);
  for (const arch of ['arm64', 'x64']) {
    for (const extension of ['dmg', 'zip']) await writeFile(path.join(release, `qqdict-0.5.6-mac-${arch}.${extension}`), 'fixture');
    await writeFile(path.join(release, `SHA256SUMS-${arch}.txt`), 'fixture');
    await writeFile(path.join(release, `release-metadata-${arch}.json`), JSON.stringify({ signing: signed ? 'developer-id' : 'ad-hoc' }));
  }
  await writeFile(path.join(directory, 'publish.sh'), publish);
  await writeFile(path.join(directory, 'release-notes.md'), 'Release notes');
  // Exercise the workflow's real Bash, without GitHub credentials or network.
  const gh = path.join(directory, 'gh');
  await writeFile(gh, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TASK_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[1] === 'view') {
  const states = { preview: 'true\\tfalse', draft: 'false\\ttrue', stable: 'false\\tfalse' };
  if (!states[process.env.TASK_TEST_EXISTING]) process.exit(1);
  console.log(states[process.env.TASK_TEST_EXISTING]);
}
if (args[1] === 'download') {
  const target = args[args.indexOf('--dir') + 1];
  for (const arch of ['arm64', 'x64']) fs.writeFileSync(path.join(target, 'release-metadata-' + arch + '.json'), JSON.stringify({ signing: 'developer-id' }));
}
`);
  await chmod(gh, 0o755);
  const log = path.join(directory, 'calls.jsonl');
  await execute('bash', ['publish.sh'], {
    cwd: directory,
    // The workflow parses Node's boolean output as plain text.
    env: { ...process.env, FORCE_COLOR: '0', PATH: `${directory}:${process.env.PATH}`, TASK_TEST_LOG: log,
      TASK_TEST_EXISTING: existing, TASK_RELEASE_TAG: 'v0.5.6', TASK_PRERELEASE: String(preview) },
  });
  return (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

test('new stable releases remain drafts until both architectures are uploaded', async (t) => {
  const calls = await publication(t);
  assert.deepEqual(calls.map(args => args[1]), ['view', 'create', 'edit']);
  assert.ok(calls[1].includes('--draft'));
  for (const arch of ['arm64', 'x64']) assert.ok(calls[1].includes(`release/qqdict-0.5.6-mac-${arch}.zip`));
  assert.ok(calls[2].includes('--draft=false'));
  assert.ok(calls[2].includes('--prerelease=false'));
});

test('promoting a preview uploads every asset before exposing it as stable', async (t) => {
  const calls = await publication(t, { existing: 'preview' });
  assert.deepEqual(calls.map(args => args[1]), ['view', 'upload', 'edit']);
  assert.ok(calls[2].includes('--prerelease=false'));
});

test('published stable versions are immutable, including on signed workflow reruns', async (t) => {
  assert.deepEqual((await publication(t, { existing: 'stable' })).map(args => args[1]), ['view']);
});

test('an unsigned preview cannot publish over a draft reserved for a local signed build', async (t) => {
  assert.deepEqual((await publication(t, { existing: 'draft', preview: true, signed: false })).map(args => args[1]), ['view']);
});

test('an unsigned workflow rerun preserves an existing Developer ID signed preview', async (t) => {
  assert.deepEqual((await publication(t, { existing: 'preview', preview: true, signed: false })).map(args => args[1]), ['view', 'download']);
});
