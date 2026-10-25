import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
// appdmg is an optional, macOS-only dependency; pnpm skips it on Linux.
const installed = (() => { try { return require.resolve('appdmg'); } catch { return undefined; } })();
const skip = installed ? false : 'appdmg is only installed on macOS';
const { imageSizeCallback, loadAppdmg } = installed ? await import('./appdmg-adapter.mjs') : {};
const appdmgRequire = installed && createRequire(installed);
const dimensions = filename => new Promise((resolve, reject) => {
  imageSizeCallback(filename, (error, value) => error ? reject(error) : resolve(value));
});

test('DMG compatibility adapter preserves the modern image-size exports', { skip }, () => {
  const modern = appdmgRequire('image-size');
  assert.equal(typeof loadAppdmg(), 'function');
  assert.equal(appdmgRequire('image-size'), modern);
  assert.equal(typeof modern.imageSize, 'function');
});

test('legacy callback reads PNG dimensions through the patched parser', { skip }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qqdict-image-size-'));
  try {
    const filename = join(directory, 'background.png');
    const header = Buffer.alloc(33);
    Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(header);
    header.writeUInt32BE(660, 16);
    header.writeUInt32BE(420, 20);
    header[24] = 8;
    header[25] = 6;
    await writeFile(filename, header);
    const result = await dimensions(filename);
    assert.equal(result.width, 660);
    assert.equal(result.height, 420);
    await assert.rejects(dimensions(join(directory, 'missing.png')), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
