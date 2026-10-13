// Named import: Vite tree-shakes JSON fields, so the entry carries the version string
// rather than the whole root manifest (scripts, workspaces, dependency lists).
import { version } from '../../../package.json';

export const PRODUCT_VERSION = version;
export const PRODUCT_BUILD_ID = typeof __BUILD_ID__ === 'undefined' ? 'test' : __BUILD_ID__;
