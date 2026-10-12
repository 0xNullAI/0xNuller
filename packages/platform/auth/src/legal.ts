/**
 * The one version string for the 用户协议 and 隐私政策 shown at registration.
 *
 * The client sends it as `acceptedTerms` when the person ticks the consent box, and the Auth
 * Worker accepts a registration only when it matches exactly and records it. Bump it whenever
 * either text in apps/web/src/legal changes in substance, so the record says which wording each
 * account agreed to. Lives in the auth package because both sides of that contract import it.
 */
export const LEGAL_TERMS_VERSION = '2026-10-11';
