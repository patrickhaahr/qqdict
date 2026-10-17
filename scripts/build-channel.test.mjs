import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import { buildIdentity } from './build-channel.mjs';

test('local builds default to Nightly in a clean environment', () => {
  const env = { ...process.env };
  delete env.QQDICT_CHANNEL;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e',
    'import { buildIdentity } from "./scripts/build-channel.mjs"; console.log(JSON.stringify(buildIdentity()));'],
  { env, encoding: 'utf8' });
  assert.equal(JSON.parse(result).channel, 'nightly');
});

test('Nightly installs and stores data separately from production', () => {
  const nightly = buildIdentity('nightly');
  const production = buildIdentity('production');
  assert.equal(nightly.productName, 'qqdict Nightly');
  assert.equal(nightly.bundleId, 'io.github.qwertyu-alex.qqdict.nightly');
  assert.equal(production.productName, 'qqdict');
  assert.equal(production.bundleId, 'io.github.qwertyu-alex.qqdict');
  for (const key of ['productName', 'bundleId', 'slug', 'journalDirectory']) {
    assert.notEqual(nightly[key], production[key], key);
  }
});

test('an unknown channel fails instead of silently using production', () => {
  assert.throws(() => buildIdentity('release'), /QQDICT_CHANNEL must be nightly or production/);
  assert.throws(() => buildIdentity(''), /QQDICT_CHANNEL must be nightly or production/);
});

test('compiled app identity is fixed for each channel without a runtime environment', async () => {
  for (const channel of ['nightly', 'production']) {
    const result = await build({
      entryPoints: ['src/product.ts'], bundle: true, format: 'cjs', write: false,
      define: { 'process.env.QQDICT_CHANNEL': JSON.stringify(channel) },
    });
    const context = { module: { exports: {} } };
    vm.runInNewContext(result.outputFiles[0].text, context);
    assert.equal(context.module.exports.PRODUCT_NAME, buildIdentity(channel).productName);
    assert.equal(context.module.exports.BUILD_IDENTITY.channel, channel);
  }
});
