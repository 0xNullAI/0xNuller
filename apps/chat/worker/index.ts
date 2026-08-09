// DG-Chat Worker entry point.
// Same-origin hosting: frontend static assets (env.ASSETS) + room WebSocket relay (RoomDO) + public room lobby (LobbyDO) + R2 media.
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

    // Room WebSocket: /ws/room/:code -> the matching RoomDO instance.
    const roomMatch = pathname.match(/^\/ws\/room\/([^/]+)$/);
    if (roomMatch) {
      const code = decodeURIComponent(roomMatch[1]!);
      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      // Pass the room code through to the DO (idFromName is not reversible, and the DO needs it for the R2 prefix / lobby reporting).
      const fwd = new URL(request.url);
      fwd.searchParams.set('code', code);
      return stub.fetch(new Request(fwd, request));
    }

    // Lobby WebSocket + REST snapshot -> the singleton LobbyDO.
    if (pathname === '/ws/lobby' || pathname === '/api/lobby/rooms') {
      const id = env.LOBBY.idFromName(LOBBY_NAME);
      return env.LOBBY.get(id).fetch(request);
    }

    // Media upload: PUT /api/upload/:code
    const uploadMatch = pathname.match(/^\/api\/upload\/([^/]+)$/);
    if (uploadMatch && request.method === 'PUT') {
      return handleMediaUpload(request, env, decodeURIComponent(uploadMatch[1]!));
    }

    // Media read-back: GET /api/media/:code/:id
    const mediaMatch = pathname.match(/^\/api\/media\/([^/]+)\/([^/]+)$/);
    if (mediaMatch && request.method === 'GET') {
      return handleMediaRead(env, decodeURIComponent(mediaMatch[1]!), decodeURIComponent(mediaMatch[2]!));
    }

    // Everything else falls through to the static assets (SPA).
    return env.ASSETS.fetch(request);
  },
};

export { RoomDO, LobbyDO };
