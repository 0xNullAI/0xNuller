/**
 * Room constants shared by the frontend and the Worker.
 *
 * It lives in `shared/` rather than `src/` or `worker/`: the two tsconfigs each only
 * include their own half (the app sees only src, the worker only worker), so this value
 * used to be written out three separate times — in `worker/wire.ts`,
 * `components/RoomEntry.tsx` and `App.tsx`. Changing one and missing the other two put
 * users in a room that looked right but had nobody in it.
 */

/** The permanently resident public room. It guarantees there is always somewhere to go, so new users never face an empty list. */
export const RESERVED_ROOM_CODE = '0xNullAI';
