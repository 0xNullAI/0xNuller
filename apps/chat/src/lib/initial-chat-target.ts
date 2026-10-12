export type InitialChatTarget = { kind: 'dm'; accountId: string } | { kind: 'room'; code: string };

/** A URL selects a peer, never grants access; the caller must request a fresh ticket. */
export function initialChatTarget(search: string): InitialChatTarget | null {
  const params = new URLSearchParams(search);
  if (params.has('dm')) {
    const accountId = params.get('dm')?.trim() ?? '';
    return /^[A-Za-z0-9._:-]{1,128}$/.test(accountId) ? { kind: 'dm', accountId } : null;
  }
  const code = params.get('room');
  return code ? { kind: 'room', code } : null;
}
