/**
 * 前端与 Worker 共用的房间常量。
 *
 * 放在 `shared/` 而不是 `src/` 或 `worker/`：两个 tsconfig 各自只 include 自己那半边
 * （app 只看 src，worker 只看 worker），所以这个值曾经在三处各写了一遍——
 * `worker/wire.ts`、`components/RoomEntry.tsx`、`App.tsx`。改一处漏两处的结果是
 * 用户进了一个「看起来对但没人在」的房间。
 */

/** 常驻公开房。它保证任何时候都有一个可进的地方，新用户不会面对空列表。 */
export const RESERVED_ROOM_CODE = '0xNullAI';
