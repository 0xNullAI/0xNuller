/**
 * The public 用户协议 page. Kept apart from the text so the shell can recognise the address
 * without pulling the document into the initial bundle.
 */
export const LEGAL_TERMS_TITLE = '用户协议';
export const LEGAL_TERMS_PATH = '/legal/terms';

/** `/legal/terms` (trailing slash and case tolerated). */
export function isLegalTermsPath(pathname: string): boolean {
  return /^\/legal\/terms\/?$/i.test(pathname);
}
