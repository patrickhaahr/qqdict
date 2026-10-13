import { execFileSync } from 'node:child_process';

// Keep credential-bearing arguments and raw subprocess errors out of logs.
const sensitiveKeys = [
  'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID',
  'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER',
  'APPLE_KEYCHAIN_PROFILE', 'MACOS_CERTIFICATE_PASSWORD',
];
export function redact(message) {
  let value = String(message);
  for (const key of sensitiveKeys) {
    const secret = process.env[key];
    if (secret) value = value.split(secret).join('[redacted]');
  }
  return value;
}
export function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const diagnostic = redact(error.stderr || error.stdout || 'The command did not complete.');
    throw new Error(`${command.split('/').at(-1)} failed: ${diagnostic.trim()}`);
  }
}

export const signingIdentity = process.env.DEVELOPER_ID_APPLICATION?.trim() || '-';
export const developerSigned = signingIdentity !== '-';

export function notarizationArguments() {
  const profile = process.env.APPLE_KEYCHAIN_PROFILE?.trim();
  if (profile) return ['--keychain-profile', profile];
  const appleValues = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
  const present = appleValues.filter(key => process.env[key]);
  if (present.length && present.length !== appleValues.length) {
    throw new Error('Notarization requires APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID together.');
  }
  if (present.length) return [
    '--apple-id', process.env.APPLE_ID,
    '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD,
    '--team-id', process.env.APPLE_TEAM_ID,
  ];
  return null;
}

export function sign(path, { identifier, entitlements, executable = false } = {}) {
  const args = ['--force', '--sign', signingIdentity,
    developerSigned ? '--timestamp' : '--timestamp=none'];
  if (developerSigned && executable) args.push('--options', 'runtime');
  if (identifier) args.push('--identifier', identifier);
  if (entitlements) args.push('--entitlements', entitlements);
  run('/usr/bin/codesign', [...args, path]);
}

export function notarize(submission, stapleTarget = submission) {
  const authentication = notarizationArguments();
  if (!authentication) return false;
  if (!developerSigned) throw new Error('Notarization also requires a Developer ID Application signing identity.');
  console.log('Submitting to Apple for notarization…');
  const response = JSON.parse(run('/usr/bin/xcrun', [
    'notarytool', 'submit', submission, ...authentication,
    '--wait', '--timeout', '30m', '--output-format', 'json',
  ]));
  if (response.status !== 'Accepted') {
    throw new Error(`Apple did not accept this build for notarization (status: ${redact(response.status || 'unknown')}).`);
  }
  run('/usr/bin/xcrun', ['stapler', 'staple', stapleTarget]);
  run('/usr/bin/xcrun', ['stapler', 'validate', stapleTarget]);
  console.log('Apple notarization and stapled ticket verified.');
  return true;
}
