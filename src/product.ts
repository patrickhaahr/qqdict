import metadata from '../package.json';
import { buildIdentity } from '../scripts/build-channel.mjs';

export const BUILD_IDENTITY = buildIdentity();
export const PRODUCT_NAME = BUILD_IDENTITY.productName;
export const PRODUCT_VERSION = metadata.version;
export const PRODUCT_REPOSITORY = 'https://github.com/qwertyu-alex/qqdict';
