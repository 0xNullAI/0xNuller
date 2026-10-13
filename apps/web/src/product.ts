// Named import: Vite tree-shakes JSON fields, so the entry carries the version string
// rather than the whole root manifest (scripts, workspaces, dependency lists).
import { version } from '../../../package.json';

export const PRODUCT_VERSION = version;
export const PRODUCT_TAG = `v${PRODUCT_VERSION}`;
export const PRODUCT_RELEASE_URL = `https://github.com/0xNullAI/0xNuller/releases/tag/${PRODUCT_TAG}`;
export const PRODUCT_BUILD_ID = typeof __BUILD_ID__ === 'undefined' ? 'test' : __BUILD_ID__;
