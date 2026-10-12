/**
 * The two public legal pages. Kept apart from the texts so the shell can recognise the
 * address without pulling the documents into the initial bundle.
 */
export type LegalDocumentId = 'terms' | 'privacy';

export const LEGAL_DOCUMENT_TITLES: Record<LegalDocumentId, string> = {
  terms: '用户协议',
  privacy: '隐私政策',
};

export const LEGAL_DOCUMENT_ORDER: readonly LegalDocumentId[] = ['terms', 'privacy'];

export function legalDocumentPath(id: LegalDocumentId): string {
  return `/legal/${id}`;
}

/** `/legal/privacy` and `/legal/terms` (trailing slash and case tolerated); anything else is null. */
export function legalDocumentFromPath(pathname: string): LegalDocumentId | null {
  const match = /^\/legal\/(terms|privacy)\/?$/i.exec(pathname);
  return match ? (match[1]!.toLowerCase() as LegalDocumentId) : null;
}
