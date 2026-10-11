import { uploadMedia } from './media';
import type { ChatReplyContext } from './protocol';
import type { OutgoingMedia } from '../hooks/use-peer-room';
interface MediaRoom {
  roomId: string | null;
  mediaToken: string | null;
}
/** The same room capability must still be active before upload and before publishing its message. */
export async function sendRoomMedia(
  {
    room,
    active,
    send,
    upload = uploadMedia,
  }: {
    room: MediaRoom;
    active: () => MediaRoom;
    send: (
      text: string,
      media: OutgoingMedia,
      mentions?: ChatReplyContext['mentions'],
      replyTo?: ChatReplyContext['replyTo'],
    ) => boolean;
    upload?: typeof uploadMedia;
  },
  blob: Blob,
  kind: 'image' | 'audio',
  meta?: { durationMs?: number; w?: number; h?: number },
  reply?: ChatReplyContext,
): Promise<void> {
  if (!room.roomId || !room.mediaToken) throw new Error('会话尚未连接，无法上传媒体');
  const check = () => {
    const current = active();
    if (current.roomId !== room.roomId || current.mediaToken !== room.mediaToken)
      throw new Error('上传期间会话已切换，请重新发送');
  };
  check();
  const media = await upload(room.roomId, room.mediaToken, blob, kind, meta);
  check();
  if (!send('', media, reply?.mentions, reply?.replyTo))
    throw new Error('会话连接已断开，请重新发送');
}
