export function buildIdentity(channel = process.env.QQDICT_CHANNEL ?? 'nightly') {
  if (!['nightly', 'production'].includes(channel)) {
    throw new Error('QQDICT_CHANNEL must be nightly or production.');
  }
  const nightly = channel === 'nightly';
  return {
    channel,
    productName: nightly ? 'qqdict Nightly' : 'qqdict',
    bundleId: `io.github.qwertyu-alex.qqdict${nightly ? '.nightly' : ''}`,
    slug: nightly ? 'qqdict-nightly' : 'qqdict',
    journalDirectory: nightly ? 'Dictation Nightly' : 'Dictation',
    iconName: nightly ? 'AppIconNightly' : 'AppIcon',
    iconSource: nightly ? 'app-icon-nightly.png' : 'app-icon.png',
  };
}
