import { createStore, get, set, del, type UseStore } from 'idb-keyval';
import { z } from 'zod';
import { getWaveformModality, type WaveformModality } from '@dg-kit/core';
import {
  pullContent,
  pullContentPreferences,
  pushContent,
  pushContentPreferences,
} from '@0xnullai/sync';

export * from './product-library.js';
export * from './use-waveforms.js';

/**
 * The shared custom-waveform library.
 *
 * Agent kept its waveforms in IndexedDB (`dg-agent-waveforms`) and Chat kept
 * its own in localStorage (`dg-chat-custom-waveforms`). Two databases that
 * could not see each other: a waveform you designed in Agent simply did not
 * exist in Chat, and vice versa. Voice had a third.
 *
 * This is the one library. On first read it merges whatever those three held
 * and writes the result here, so nobody loses work in the transition.
 */

export interface WaveFrameTuple extends Array<number> {
  0: number;
  1: number;
}

export interface SharedWaveform {
  id: string;
  name: string;
  description?: string;
  frames: [number, number][];
  /** Output family: omitted legacy entries remain electrostimulation. */
  modality?: WaveformModality;
}

const waveformSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  frames: z.array(z.tuple([z.number(), z.number()])).min(1),
  modality: z.enum(['electrostimulation', 'vibration']).optional(),
});

const DB_NAME = '0xnullai-waveforms';
const STORE_NAME = 'waveforms';
const CUSTOM_KEY = 'custom';
const HIDDEN_KEY = 'hidden-builtins';
const MIGRATED_KEY = 'migrated-from-per-module';

let store: UseStore | undefined;
let syncPromise: Promise<void> | null = null;
let synced = false;
function db(): UseStore {
  if (!store) store = createStore(DB_NAME, STORE_NAME);
  return store;
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Subscribe to library changes. Both modules re-read on the same signal. */
export function subscribeWaveforms(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Parse per item rather than per array.
 *
 * One corrupt entry must not take the whole library down with it — that is
 * the user's own designed content, and there is no way to get it back.
 */
function coerceList(raw: unknown): SharedWaveform[] {
  if (!Array.isArray(raw)) return [];
  const out: SharedWaveform[] = [];
  for (const item of raw) {
    const parsed = waveformSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data as SharedWaveform);
  }
  return out;
}

/** Same waveform saved in two modules: same name and same frames. */
function signatureOf(w: SharedWaveform): string {
  return `${getWaveformModality(w)}::${w.name}::${w.frames.map((f) => f.join(',')).join(';')}`;
}

function mergeById(groups: SharedWaveform[][]): SharedWaveform[] {
  const byId = new Map<string, SharedWaveform>();
  const seenSignatures = new Set<string>();
  for (const group of groups) {
    for (const w of group) {
      const sig = signatureOf(w);
      if (byId.has(w.id) || seenSignatures.has(sig)) continue;
      byId.set(w.id, w);
      seenSignatures.add(sig);
    }
  }
  return [...byId.values()];
}

async function readLegacyIdb(dbName: string, key: string): Promise<SharedWaveform[]> {
  try {
    return coerceList(await get(key, createStore(dbName, 'waveforms')));
  } catch {
    return [];
  }
}

function readLegacyLocalStorage(key: string): SharedWaveform[] {
  try {
    return coerceList(JSON.parse(localStorage.getItem(key) ?? 'null'));
  } catch {
    return [];
  }
}

/**
 * One-time merge of the per-module libraries.
 *
 * Runs at most once; the legacy stores are left untouched so an older build
 * still works if someone rolls back.
 */
async function migrateOnce(): Promise<void> {
  if (await get(MIGRATED_KEY, db())) return;
  const [agent, voice] = await Promise.all([
    readLegacyIdb('dg-agent-waveforms', 'custom-waveforms'),
    readLegacyIdb('dg-voice-waveforms', 'custom-waveforms'),
  ]);
  const chat = readLegacyLocalStorage('dg-chat-custom-waveforms');
  const existing = coerceList(await get(CUSTOM_KEY, db()));

  const merged = mergeById([existing, agent, chat, voice]);
  if (merged.length > 0) await set(CUSTOM_KEY, merged, db());

  const hiddenLegacy = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('dg-chat-hidden-builtins') ?? 'null');
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  })();
  if (hiddenLegacy.length > 0) await set(HIDDEN_KEY, hiddenLegacy, db());

  await set(MIGRATED_KEY, true, db());
}

/** Every custom waveform, newest first. */
export async function listCustomWaveforms(): Promise<SharedWaveform[]> {
  await migrateOnce();
  void syncWaveforms();
  return coerceList(await get(CUSTOM_KEY, db()));
}

/** Local-first account reconciliation. Remote failure is intentionally invisible. */
export function syncWaveforms(): Promise<void> {
  if (synced) return Promise.resolve();
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    await migrateOnce();
    const local = coerceList(await get(CUSTOM_KEY, db()));
    const [remote, preferences] = await Promise.all([
      pullContent('waveform'),
      pullContentPreferences('waveform'),
    ]);
    if (!remote) return;
    synced = true;
    const byId = new Map(local.map((w) => [w.id, w]));
    for (const item of remote) {
      if (item.deleted) byId.delete(item.id);
      else {
        const parsed = waveformSchema.safeParse({
          id: item.id,
          name: item.name,
          ...(item.payload as object),
        });
        if (parsed.success) byId.set(item.id, parsed.data as SharedWaveform);
      }
    }
    const merged = [...byId.values()];
    await set(CUSTOM_KEY, merged, db());
    if (preferences) {
      const localHidden = await listHiddenBuiltinsWithoutSync();
      await set(HIDDEN_KEY, [...new Set([...localHidden, ...preferences.hiddenBuiltinIds])], db());
    }
    const remoteIds = new Set(remote.map((item) => item.id));
    await pushContent(
      merged
        .filter((w) => !remoteIds.has(w.id))
        .map((w, order) => ({
          id: w.id,
          kind: 'waveform' as const,
          name: w.name,
          payload: {
            frames: w.frames,
            ...(w.description ? { description: w.description } : {}),
            ...(w.modality ? { modality: w.modality } : {}),
          },
          order,
        })),
    );
    notify();
  })().finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

if (typeof window !== 'undefined')
  window.addEventListener('0xnullai:auth-changed', () => {
    synced = false;
    void syncWaveforms();
  });

/** Add or replace one. Newest first, matching what Agent's library did. */
export async function saveCustomWaveform(waveform: SharedWaveform): Promise<void> {
  const parsed = waveformSchema.parse(waveform) as SharedWaveform;
  const current = await listCustomWaveforms();
  await set(CUSTOM_KEY, [parsed, ...current.filter((w) => w.id !== parsed.id)], db());
  notify();
  void pushContent([
    {
      id: parsed.id,
      kind: 'waveform',
      name: parsed.name,
      payload: {
        frames: parsed.frames,
        ...(parsed.description ? { description: parsed.description } : {}),
        ...(parsed.modality ? { modality: parsed.modality } : {}),
      },
    },
  ]);
}

export async function removeCustomWaveform(id: string): Promise<void> {
  const current = await listCustomWaveforms();
  await set(
    CUSTOM_KEY,
    current.filter((w) => w.id !== id),
    db(),
  );
  notify();
  void pushContent([{ id, kind: 'waveform', name: id, payload: null, deleted: true }]);
}

/** Built-in ids the user chose to hide. Chat had this concept; it is shared now. */
export async function listHiddenBuiltins(): Promise<string[]> {
  await migrateOnce();
  void syncWaveforms();
  return listHiddenBuiltinsWithoutSync();
}

async function listHiddenBuiltinsWithoutSync(): Promise<string[]> {
  const raw = await get(HIDDEN_KEY, db());
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

export async function setBuiltinHidden(id: string, hidden: boolean): Promise<void> {
  const current = await listHiddenBuiltins();
  const next = hidden ? [...new Set([...current, id])] : current.filter((x) => x !== id);
  await set(HIDDEN_KEY, next, db());
  notify();
  void pushContentPreferences('waveform', { hiddenBuiltinIds: next });
}

/** Test seam: forget everything, including the migration marker. */
export async function __resetWaveformLibrary(): Promise<void> {
  await Promise.all([del(CUSTOM_KEY, db()), del(HIDDEN_KEY, db()), del(MIGRATED_KEY, db())]);
  notify();
}
