import productPackage from '../../../package.json';

export const PRODUCT_VERSION = productPackage.version;
export const PRODUCT_TAG = `v${PRODUCT_VERSION}`;
export const PRODUCT_RELEASE_URL = `https://github.com/0xNullAI/0xNuller/releases/tag/${PRODUCT_TAG}`;
export const ANDROID_DOWNLOAD_URL = `https://github.com/0xNullAI/0xNuller/releases/latest/download/0xnuller-v${PRODUCT_VERSION}.apk`;
export const PRODUCT_BUILD_ID = typeof __BUILD_ID__ === 'undefined' ? 'test' : __BUILD_ID__;
