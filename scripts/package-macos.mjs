import { access, chmod, cp, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { developerSigned, notarizationArguments, notarize, run, sign } from './macos-signing.mjs';

// Package the already-built application. The npm package:mac command builds first.
// Keep this dependency-free so the local prototype needs no packaging service.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productName = 'qqdict';
const bundleId = 'io.github.qwertyu-alex.qqdict';
const release = join(project, 'release');
const staging = join(release, '.qqdict-build');
const bundle = join(staging, `${productName}.app`);
const destination = join(release, `${productName}.app`);
const electronBundle = join(project, 'node_modules/electron/dist/Electron.app');
const nativeBridge = join(project, 'native/build/DictationBridge');
const packageInfo = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
const wsInfo = JSON.parse(await readFile(join(project, 'node_modules/ws/package.json'), 'utf8'));
const arch = process.env.QQDICT_ARCH || process.arch;
const entitlements = join(project, 'native/entitlements.plist');
const appIcon = join(project, 'assets/AppIcon.icns');
const rendererIcon = join(project, 'assets/app-icon.png');
const requestedNotarization = notarizationArguments();
if (!['arm64', 'x64'].includes(arch)) throw new Error('QQDICT_ARCH must be arm64 or x64.');
if (requestedNotarization && !developerSigned) {
  throw new Error('Apple notarization credentials require DEVELOPER_ID_APPLICATION to be configured too.');
}

if (process.platform !== 'darwin') throw new Error('macOS packaging must run on macOS.');
try {
  await access(electronBundle);
} catch {
  throw new Error('Electron runtime is missing. Run npm ci with lifecycle scripts enabled, or run node node_modules/electron/install.js, before packaging.');
}
await Promise.all([
  access(nativeBridge), access(appIcon), access(rendererIcon), access(entitlements),
  access(join(project, 'dist/main.js')), access(join(project, 'dist/preload.js')),
  access(join(project, 'dist/renderer/index.html')),
  access(join(project, 'dist/renderer/popover.html')), access(join(project, 'dist/renderer/overlay.html')),
]);

function plistSet(path, key, type, value) {
  try { run('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, path]); } catch {}
  run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, path]);
}
function plistDelete(path, key) {
  try { run('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, path]); } catch {}
}
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    // Framework symlinks are preserved, and only their real targets are visited.
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
async function isMachO(path) {
  const file = await open(path, 'r');
  try {
    const data = Buffer.alloc(4);
    const { bytesRead } = await file.read(data, 0, 4, 0);
    return bytesRead === 4 && [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]
      .includes(data.readUInt32BE(0));
  } finally {
    await file.close();
  }
}

// A release must contain matching Electron and native architectures. npm ci
// installs the Electron binary for its runner; use a matching macOS runner in CI.
const expectedArch = arch === 'x64' ? 'x86_64' : 'arm64';
for (const executable of [join(electronBundle, 'Contents/MacOS/Electron'), nativeBridge]) {
  const actual = run('/usr/bin/lipo', ['-archs', executable]).trim().split(/\s+/);
  if (!actual.includes(expectedArch)) {
    throw new Error(`Expected ${arch} binary at ${executable}; rebuild dependencies and the native helper for that architecture.`);
  }
}

await mkdir(release, { recursive: true });
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
try {
  await cp(electronBundle, bundle, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  const contents = join(bundle, 'Contents');
  const resources = join(contents, 'Resources');
  const appResources = join(resources, 'app');
  await mkdir(join(appResources, 'node_modules'), { recursive: true });
  await cp(join(project, 'dist'), join(appResources, 'dist'), { recursive: true });
  await cp(join(project, 'node_modules/ws'), join(appResources, 'node_modules/ws'), { recursive: true });
  await mkdir(join(appResources, 'assets'), { recursive: true });
  await cp(rendererIcon, join(appResources, 'assets/app-icon.png'));
  await cp(appIcon, join(resources, 'AppIcon.icns'));
  await mkdir(join(resources, 'licenses'), { recursive: true });
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) {
    await cp(join(project, 'node_modules/electron/dist', name), join(resources, 'licenses', name));
  }
  await cp(join(project, 'LICENSE'), join(resources, 'licenses/qqdict-LICENSE'));
  await rm(join(resources, 'electron.icns'), { force: true });
  await writeFile(join(appResources, 'package.json'), `${JSON.stringify({
    name: packageInfo.name, version: packageInfo.version, productName, private: true,
    description: packageInfo.description, main: 'dist/main.js', dependencies: { ws: wsInfo.version },
  }, null, 2)}\n`);
  await mkdir(join(resources, 'native'), { recursive: true });
  await cp(nativeBridge, join(resources, 'native/DictationBridge'));
  await chmod(join(resources, 'native/DictationBridge'), 0o755);
  await rm(join(resources, 'default_app.asar'), { force: true });

  await rename(join(contents, 'MacOS/Electron'), join(contents, `MacOS/${productName}`));
  const mainPlist = join(contents, 'Info.plist');
  for (const [key, type, value] of [
    ['CFBundleExecutable', 'string', productName], ['CFBundleName', 'string', productName],
    ['CFBundleDisplayName', 'string', productName], ['CFBundleIdentifier', 'string', bundleId],
    ['CFBundleVersion', 'string', packageInfo.version], ['CFBundleShortVersionString', 'string', packageInfo.version],
    ['LSApplicationCategoryType', 'string', 'public.app-category.utilities'], ['LSUIElement', 'bool', 'true'],
    ['CFBundleIconFile', 'string', 'AppIcon'], ['LSMinimumSystemVersion', 'string', '13.0'],
    ['NSMicrophoneUsageDescription', 'string', 'qqdict records your microphone while you hold the dictation hotkey.'],
    ['NSInputMonitoringUsageDescription', 'string', 'qqdict watches the selected modifier key to start and stop dictation.'],
    ['NSAccessibilityUsageDescription', 'string', 'qqdict pastes your completed transcript into the field you were using.'],
  ]) plistSet(mainPlist, key, type, value);
  for (const key of ['ElectronAsarIntegrity', 'NSCameraUsageDescription', 'NSBluetoothPeripheralUsageDescription',
    'NSBluetoothAlwaysUsageDescription', 'NSAudioCaptureUsageDescription', 'NSAppTransportSecurity']) {
    plistDelete(mainPlist, key);
  }

  const frameworks = join(contents, 'Frameworks');
  const helperBundles = [];
  for (const [suffix, idSuffix] of [['', 'helper'], [' (Renderer)', 'helper.renderer'],
    [' (GPU)', 'helper.gpu'], [' (Plugin)', 'helper.plugin']]) {
    const oldName = `Electron Helper${suffix}`;
    const helperName = `${productName} Helper${suffix}`;
    const oldBundle = join(frameworks, `${oldName}.app`);
    const helperBundle = join(frameworks, `${helperName}.app`);
    await rename(oldBundle, helperBundle);
    await rename(join(helperBundle, `Contents/MacOS/${oldName}`), join(helperBundle, `Contents/MacOS/${helperName}`));
    const helperPlist = join(helperBundle, 'Contents/Info.plist');
    for (const [key, value] of [
      ['CFBundleExecutable', helperName], ['CFBundleName', helperName], ['CFBundleDisplayName', helperName],
      ['CFBundleIdentifier', `${bundleId}.${idSuffix}`], ['CFBundleVersion', packageInfo.version],
      ['CFBundleShortVersionString', packageInfo.version],
      ['NSMicrophoneUsageDescription', 'qqdict records your microphone while you hold the dictation hotkey.'],
    ]) plistSet(helperPlist, key, 'string', value);
    helperBundles.push(helperBundle);
  }

  // Sign from the inside out. Do not use --deep to sign, which can replace the
  // native helper's stable identity. --deep is used only for verification.
  for (const path of await walk(contents)) {
    if (!await isMachO(path)) continue;
    const identifier = path.endsWith('/DictationBridge') ? `${bundleId}.bridge` : undefined;
    const isElectronExecutable = path.includes('/Contents/MacOS/') && !path.endsWith('/DictationBridge');
    sign(path, { identifier, executable: true, entitlements: isElectronExecutable ? entitlements : undefined });
  }
  for (const entry of await readdir(frameworks, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith('.framework')) sign(join(frameworks, entry.name), { executable: true });
  }
  for (const helper of helperBundles) sign(helper, { entitlements, executable: true });
  sign(bundle, { identifier: bundleId, entitlements, executable: true });
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  run('/usr/bin/plutil', ['-lint', mainPlist]);
  let notarized = false;
  if (requestedNotarization) {
    const submission = join(staging, 'notarization.zip');
    run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, submission]);
    notarized = notarize(submission, bundle);
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', bundle]);
  }
  // Never replace the last good build before signing and notarization succeed.
  const previous = join(staging, 'previous.app');
  try { await rename(destination, previous); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(bundle, destination); } catch (error) {
    try { await rename(previous, destination); } catch {}
    throw error;
  }
  await writeFile(join(release, `build-info-${arch}.json`), `${JSON.stringify({
    productName, version: packageInfo.version, bundleId, arch, minimumMacOS: '13.0',
    signing: developerSigned ? 'developer-id' : 'ad-hoc', notarized,
  }, null, 2)}\n`);
  console.log(`Packaged ${productName} ${packageInfo.version} (${arch}): ${destination}`);
  console.log(notarized ? 'Developer ID signature and Apple notarization verified.'
    : developerSigned ? 'Developer ID signature verified. This build has not been notarized.'
      : 'Ad hoc signature verified. This preview has not been notarized.');
} finally {
  await rm(staging, { recursive: true, force: true });
}
