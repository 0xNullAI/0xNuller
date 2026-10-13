import { MAX_MEDIA_BYTES, isAllowedMediaType, type MediaRef, type WireChat } from './wire';

/**
 * Shapes for what one member's client sends that other members' clients render.
 *
 * The relay used to pass these through as sent, so one malformed frame (a name that is an
 * object, a mention that is null) crashed every other member's Chat, and a stored one broke
 * history for the whole room on every rejoin. Anything stored or relayed is reduced to the
 * fields the clients read, each of the type they expect; the rest is dropped.
 */

const MAX_MENTIONS = 20;
const MAX_CATALOG = 300;
const MAX_QUEUE = 100;

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function finite(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : undefined;
}

/** Undefined when absent, null when present but not a media reference this room issued. */
export function mediaRefShape(value: unknown): MediaRef | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') return null;
  const m = value as Record<string, unknown>;
  if (
    (m.kind !== 'image' && m.kind !== 'audio') ||
    typeof m.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(m.id) ||
    typeof m.mime !== 'string' ||
    !isAllowedMediaType(m.mime)
  )
    return null;
  const size = finite(m.size, 1, MAX_MEDIA_BYTES);
  if (size === undefined) return null;
  const durationMs = finite(m.durationMs, 0, 10 * 60_000);
  const w = finite(m.w, 1, 20_000);
  const h = finite(m.h, 1, 20_000);
  return {
    kind: m.kind,
    id: m.id,
    mime: m.mime,
    size,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(w !== undefined ? { w } : {}),
    ...(h !== undefined ? { h } : {}),
  };
}

export function mentionsShape(value: unknown): WireChat['mentions'] {
  if (!Array.isArray(value)) return undefined;
  const mentions = value
    .flatMap((entry) => {
      const mention = entry as { peerId?: unknown; n?: unknown } | null;
      return typeof mention?.peerId === 'string' &&
        mention.peerId.length > 0 &&
        mention.peerId.length <= 128 &&
        typeof mention.n === 'string'
        ? [{ peerId: mention.peerId, n: mention.n.slice(0, 80) }]
        : [];
    })
    .slice(0, MAX_MENTIONS);
  return mentions.length ? mentions : undefined;
}

function strings(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string' && item.length <= maxLength)
        .slice(0, maxItems)
    : undefined;
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return options.includes(value as T) ? (value as T) : undefined;
}

function defined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/**
 * A presence or device-state frame, rebuilt from known fields. `null` values are kept where
 * the clients use them to mean "cleared"; any other wrong type is dropped as if absent.
 */
export function stateFrameShape(t: string, msg: Record<string, unknown>): Record<string, unknown> {
  const nullable = <T>(value: unknown, read: (value: unknown) => T | undefined) =>
    value === null ? null : read(value);
  const bool = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
  const level = (value: unknown) => finite(value, 0, 200);
  if (t === 'presence') return defined({ t, n: text(msg.n, 40) });
  if (t === 'sf')
    return defined({
      t,
      sa: level(msg.sa),
      sb: level(msg.sb),
      wa: nullable(msg.wa, (value) => text(value, 128)),
      wb: nullable(msg.wb, (value) => text(value, 128)),
      fA: bool(msg.fA),
      fB: bool(msg.fB),
      oa: level(msg.oa),
      ob: level(msg.ob),
      obtn: nullable(msg.obtn, (value) => text(value, 80)),
      se: nullable(msg.se, (value) => text(value, 120)),
      sv: nullable(msg.sv, (value) => finite(value, -1e9, 1e9)),
      sea: nullable(msg.sea, (value) => finite(value, 0, 1e15)),
    });
  if (t === 'ss') {
    const catalog = Array.isArray(msg.cat)
      ? msg.cat
          .flatMap((entry) => {
            const wave = entry as Record<string, unknown> | null;
            return typeof wave?.id === 'string' &&
              wave.id.length <= 128 &&
              typeof wave.name === 'string'
              ? [
                  defined({
                    id: wave.id,
                    name: wave.name.slice(0, 60),
                    custom: wave.custom === true,
                    modality: oneOf(wave.modality, ['electrostimulation', 'vibration'] as const),
                  }),
                ]
              : [];
          })
          .slice(0, MAX_CATALOG)
      : undefined;
    const coyotes = Array.isArray(msg.cy)
      ? msg.cy
          .flatMap((entry) => {
            const coyote = entry as Record<string, unknown> | null;
            return typeof coyote?.deviceId === 'string' && coyote.deviceId.length <= 256
              ? [defined({ deviceId: coyote.deviceId, name: text(coyote.name, 120) })]
              : [];
          })
          .slice(0, 16)
      : undefined;
    const modes = ['single', 'list', 'random'] as const;
    return defined({
      t,
      n: text(msg.n, 40),
      u: nullable(msg.u, (value) => text(value, 64)),
      dc: bool(msg.dc),
      cy: coyotes,
      b: nullable(msg.b, (value) => finite(value, 0, 100)),
      cat: catalog,
      qA: strings(msg.qA, MAX_QUEUE, 128),
      qB: strings(msg.qB, MAX_QUEUE, 128),
      mA: oneOf(msg.mA, modes),
      mB: oneOf(msg.mB, modes),
      iA: finite(msg.iA, 1, 3600),
      iB: finite(msg.iB, 1, 3600),
      ciA: finite(msg.ciA, 0, MAX_QUEUE),
      ciB: finite(msg.ciB, 0, MAX_QUEUE),
      da: bool(msg.da),
      ag: strings(msg.ag, 8, 64),
      oc: bool(msg.oc),
      obt: nullable(msg.obt, (value) => finite(value, 0, 100)),
      obtn: nullable(msg.obtn, (value) => text(value, 80)),
      sk: nullable(msg.sk, (value) => oneOf(value, ['paw-prints', 'civet-edging'] as const)),
      sc: bool(msg.sc),
      sbt: nullable(msg.sbt, (value) => finite(value, 0, 100)),
    });
  }
  return { t };
}
