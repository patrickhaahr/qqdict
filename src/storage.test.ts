import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateLegacyHistory } from './storage';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qqdict-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'old-app'), current = path.join(root, 'qqdict');
  await mkdir(legacy);
  return { legacy, current };
}

test('renaming imports the legacy cache once, preserves its original, and copies no other app files', async t => {
  const { legacy, current } = await fixture(t);
  const original = '{"version":1,"settings":{"hotkey":"fn"},"history":[{"text":"Saved words"}]}';
  await writeFile(path.join(legacy, 'history.json'), original);
  await writeFile(path.join(legacy, 'unrelated-file'), 'Do not import');
  assert.equal(await migrateLegacyHistory(current, legacy), true);
  assert.equal(await readFile(path.join(current, 'history.json'), 'utf8'), original);
  assert.equal(await readFile(path.join(legacy, 'history.json'), 'utf8'), original);
  assert.deepEqual(await readdir(current), ['history.json']);
  assert.equal((await stat(path.join(current, 'history.json'))).mode & 0o777, 0o600);
  assert.equal(await migrateLegacyHistory(current, legacy), false);
});

test('existing qqdict history is never replaced by legacy history', async t => {
  const { legacy, current } = await fixture(t);
  await mkdir(current);
  await writeFile(path.join(current, 'history.json'), 'new history');
  await writeFile(path.join(legacy, 'history.json'), 'old history');
  assert.equal(await migrateLegacyHistory(current, legacy), false);
  assert.equal(await readFile(path.join(current, 'history.json'), 'utf8'), 'new history');
});

test('a new installation with no legacy history starts cleanly', async t => {
  const { legacy, current } = await fixture(t);
  assert.equal(await migrateLegacyHistory(current, legacy), false);
  assert.deepEqual(await readdir(current), []);
});
