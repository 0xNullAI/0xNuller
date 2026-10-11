import type { WireReply } from './wire';
/** Resolve only the current RoomDO's history. Clients supply an ID, never trusted quote text. */
export function resolveMessageReply(sql: SqlStorage, value: unknown): WireReply | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) return undefined;
  const row = sql
    .exec('SELECT id,from_id,name,body FROM messages WHERE id=? LIMIT 1', value)
    .toArray()[0];
  if (!row) return { id: value, senderId: '', senderName: '', text: '', unavailable: true };
  const body = JSON.parse(row.body as string) as {
    x?: string;
    m?: { kind?: string };
    recalled?: true;
  };
  if (body.recalled)
    return {
      id: value,
      senderId: String(row.from_id),
      senderName: String(row.name).slice(0, 100),
      text: '消息已撤回',
      recalled: true,
    };
  return {
    id: value,
    senderId: String(row.from_id),
    senderName: String(row.name).slice(0, 100),
    text:
      typeof body.x === 'string' && body.x
        ? body.x.slice(0, 500)
        : body.m?.kind === 'image'
          ? '[图片]'
          : body.m?.kind === 'audio'
            ? '[语音]'
            : '[消息]',
  };
}
