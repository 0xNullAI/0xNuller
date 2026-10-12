import { signDmTicket, verifyDmTicket } from './dm-ticket';

const TICKET_MS = 60_000;
export const GROUP_AI_MODEL_IDS = ['basic', 'balanced', 'powerful'] as const;
export type GroupAiModelId = (typeof GROUP_AI_MODEL_IDS)[number];

export interface GroupAiTicket {
  payer: string;
  room: string;
  triggerId: string;
  roleId: string;
  grantId: string;
  modelId: GroupAiModelId;
  bodyHash: string;
  reservationKey: string;
}

export async function sha256Body(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function groupAiReservationKey(room: string, triggerId: string, roleId: string) {
  return `group-ai:${await sha256Body(JSON.stringify([room, triggerId, roleId]))}`;
}

export async function signGroupAiTicket(
  secret: string,
  input: Omit<GroupAiTicket, 'reservationKey'>,
  now = Date.now(),
): Promise<{ ticket: string; reservationKey: string }> {
  if (!validInput(input)) throw new Error('invalid group AI ticket input');
  const reservationKey = await groupAiReservationKey(input.room, input.triggerId, input.roleId);
  return {
    reservationKey,
    ticket: await signDmTicket(secret, {
      aud: 'group-ai',
      sub: input.payer,
      room: input.room,
      triggerId: input.triggerId,
      roleId: input.roleId,
      grantId: input.grantId,
      modelId: input.modelId,
      bodyHash: input.bodyHash,
      iat: now,
      exp: now + TICKET_MS,
    }),
  };
}

export async function verifyGroupAiTicket(
  secret: string,
  token: string,
  expected: { reservationKey: string; modelId: string; bodyHash: string },
  now = Date.now(),
): Promise<GroupAiTicket | null> {
  const claims = await verifyDmTicket(secret, token, now);
  if (claims?.aud !== 'group-ai' || claims.exp - claims.iat > TICKET_MS) return null;
  const input = {
    payer: claims.sub,
    room: claims.room ?? '',
    triggerId: claims.triggerId ?? '',
    roleId: claims.roleId ?? '',
    grantId: claims.grantId ?? '',
    modelId: claims.modelId as GroupAiModelId,
    bodyHash: claims.bodyHash ?? '',
  };
  if (
    !validInput(input) ||
    input.modelId !== expected.modelId ||
    input.bodyHash !== expected.bodyHash ||
    (await groupAiReservationKey(input.room, input.triggerId, input.roleId)) !==
      expected.reservationKey
  )
    return null;
  return { ...input, reservationKey: expected.reservationKey };
}

function validInput(input: Omit<GroupAiTicket, 'reservationKey'>): boolean {
  return (
    /^[A-Za-z0-9._:-]{1,128}$/.test(input.payer) &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(input.room) &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(input.triggerId) &&
    /^[A-Za-z0-9_-]{1,64}$/.test(input.roleId) &&
    /^[0-9a-f-]{36}$/.test(input.grantId) &&
    GROUP_AI_MODEL_IDS.includes(input.modelId) &&
    /^[0-9a-f]{64}$/.test(input.bodyHash)
  );
}
