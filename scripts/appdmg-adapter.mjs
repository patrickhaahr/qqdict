import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const appdmgRequire = createRequire(require.resolve('appdmg'));
const { imageSizeFromFile } = appdmgRequire('image-size/fromFile');

export function imageSizeCallback(filename, callback) {
  // appdmg 0.6.6 expects the pre-2.x filename/callback API. Its parser dependency
  // is overridden to patched image-size 2.0.3 in package.json and package-lock.
  imageSizeFromFile(filename).then(result => callback(null, result), error => callback(error));
}

export function loadAppdmg() {
  const imageSizePath = appdmgRequire.resolve('image-size');
  const modern = appdmgRequire(imageSizePath);
  if (typeof modern.imageSize !== 'function' || typeof imageSizeFromFile !== 'function') {
    throw new Error('The DMG builder requires the patched image-size 2.x dependency. Run npm ci.');
  }
  // appdmg captures the callback function during its synchronous CommonJS load.
  // Restore the cache immediately, so every other caller keeps the modern API.
  const cached = appdmgRequire.cache[imageSizePath];
  cached.exports = imageSizeCallback;
  try {
    return require('appdmg');
  } finally {
    cached.exports = modern;
  }
}
