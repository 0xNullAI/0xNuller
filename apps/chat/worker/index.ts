// DG-Chat Worker 入口。
// 同源托管：前端静态资源（env.ASSETS）+ 房间 WebSocket relay（RoomDO）+ 公开房间大厅（LobbyDO）+ R2 媒体。
import { RoomDO } from './room-do';
import { LobbyDO } from './lobby-do';
import { handleMediaUpload, handleMediaRead } from './media';
import { LOBBY_NAME } from './wire';

export interface Env {
  ASSETS: Fetcher;
  ROOM: DurableObjectNamespace<RoomDO>;
  LOBBY: DurableObjectNamespace<LobbyDO>;
  MEDIA: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // 房间 WebSocket：/ws/room/:code → 对应 RoomDO 实例。
    const roomMatch = pathname.match(/^\/ws\/room\/([^/]+)$/);
    if (roomMatch) {
      const code = decodeURIComponent(roomMatch[1]);
      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      // 把房间号透传给 DO（idFromName 不可逆，DO 需要它做 R2 前缀 / 大厅上报）。
      const fwd = new URL(request.url);
      fwd.searchParams.set('code', code);
      return stub.fetch(new Request(fwd, request));
    }

    // 大厅 WebSocket + REST 快照 → 单例 LobbyDO。
    if (pathname === '/ws/lobby' || pathname === '/api/lobby/rooms') {
      const id = env.LOBBY.idFromName(LOBBY_NAME);
      return env.LOBBY.get(id).fetch(request);
    }

    // 媒体上传：PUT /api/upload/:code
    const uploadMatch = pathname.match(/^\/api\/upload\/([^/]+)$/);
    if (uploadMatch && request.method === 'PUT') {
      return handleMediaUpload(request, env, decodeURIComponent(uploadMatch[1]));
    }

    // 媒体读回：GET /api/media/:code/:id
    const mediaMatch = pathname.match(/^\/api\/media\/([^/]+)\/([^/]+)$/);
    if (mediaMatch && request.method === 'GET') {
      return handleMediaRead(env, decodeURIComponent(mediaMatch[1]), decodeURIComponent(mediaMatch[2]));
    }

    // 其余交给静态资源（SPA）。
    return env.ASSETS.fetch(request);
  },
};

export { RoomDO, LobbyDO };
