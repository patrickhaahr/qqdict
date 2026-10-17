export function buildIdentity(channel?: string): {
  channel: 'nightly' | 'production';
  productName: string;
  bundleId: string;
  slug: string;
  journalDirectory: string;
  iconName: string;
  iconSource: string;
};
