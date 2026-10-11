import { isDmRoomCode } from './dm';

export type RoomIndexKind = 'group' | 'dm';
export type RoomIndexSource = 'admission' | 'historical-hint';

export function validRoom(code: unknown, kind: unknown): code is string {
  return (
    typeof code === 'string' &&
    (kind === 'dm' || kind === 'group') &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(code) &&
    (kind === 'dm' ? isDmRoomCode(code) : !code.startsWith('dm:'))
  );
}
