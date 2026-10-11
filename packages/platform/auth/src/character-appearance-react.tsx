import { useEffect, useState } from 'react';
import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId, subscribeAuthChanges } from './index';
import {
  readPrivateConversationSelection,
  subscribePrivateConversationSelection,
} from './conversation-selection';
import {
  characterPhotoPath,
  getCharacterAppearance,
  type CharacterAppearance,
} from './character-appearance';

/** Private asset bytes are page-memory only; changing accounts clears even an in-flight fetch. */
export function useCharacterPhoto(photoId: string | null): string | null {
  const [source, setSource] = useState<{ account: string; photoId: string; url: string } | null>(
    null,
  );
  const [account, setAccount] = useState(currentAuthUserId);
  useEffect(
    () =>
      subscribeAuthChanges(() => {
        setAccount((previous) => {
          const next = currentAuthUserId();
          if (previous !== next) setSource(null);
          return next;
        });
      }),
    [],
  );
  useEffect(() => {
    if (!photoId || !account) return;
    let valid = true;
    let objectUrl: string | undefined;
    const controller = new AbortController();
    const unsubscribe = subscribeAuthChanges(() => {
      if (currentAuthUserId() !== account) {
        valid = false;
        controller.abort();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    });
    void (async () => {
      const path = characterPhotoPath(photoId);
      const response = await fetch(`${apiBaseUrl()}${path}`, {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
        headers: { ...authRequestHeaders(), 'X-Account-Id': account },
      });
      if (
        !response.ok ||
        !/^image\/(png|jpeg|webp)$/.test(response.headers.get('content-type') ?? '')
      )
        return;
      const blob = await response.blob();
      if (!valid || currentAuthUserId() !== account || blob.size > 10_000_000) return;
      objectUrl = URL.createObjectURL(blob);
      setSource({ account, photoId, url: objectUrl });
    })().catch(() => undefined);
    return () => {
      valid = false;
      unsubscribe();
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [photoId, account]);
  return source?.account === currentAuthUserId() && source?.photoId === photoId ? source.url : null;
}

export function useSelectedCharacterAppearance(): CharacterAppearance | null {
  const [selection, setSelection] = useState(readPrivateConversationSelection);
  const [value, setValue] = useState<{ key: string; appearance: CharacterAppearance } | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(
    () =>
      subscribePrivateConversationSelection(() => setSelection(readPrivateConversationSelection())),
    [],
  );
  useEffect(() => {
    const refresh = () => setRevision((previous) => previous + 1);
    window.addEventListener('0xnullai:appearance-changed', refresh);
    return () => window.removeEventListener('0xnullai:appearance-changed', refresh);
  }, []);
  const key = selection?.relationshipId ? `${selection.accountId}:${selection.relationshipId}` : '';
  useEffect(() => {
    let valid = true;
    if (selection?.relationshipId)
      void getCharacterAppearance(selection.relationshipId)
        .then((appearance) => {
          if (valid) setValue({ key, appearance });
        })
        .catch(() => {
          if (valid) setValue(null);
        });
    return () => {
      valid = false;
    };
  }, [key, selection?.relationshipId, revision]);
  return key && value?.key === key ? value.appearance : null;
}

export function CharacterPortrait({
  photoId,
  speaking = false,
  className = '',
  fallbackSource,
}: {
  photoId: string | null;
  speaking?: boolean;
  className?: string;
  fallbackSource?: string | null;
}) {
  const source = useCharacterPhoto(photoId);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  // Only callers' in-memory blobs are accepted; no external tracking URLs.
  const publicSource = fallbackSource?.startsWith('blob:') ? fallbackSource : null;
  const displayed =
    source && !failed.has(source)
      ? source
      : publicSource && !failed.has(publicSource)
        ? publicSource
        : null;
  return (
    <div
      className={`${className} overflow-hidden rounded-2xl ${speaking ? 'ring-4 ring-violet-400' : ''}`}
      aria-label={speaking ? '角色正在说话' : '角色形象'}
    >
      {displayed ? (
        <img
          src={displayed}
          onError={() => setFailed((previous) => new Set([...previous, displayed]))}
          alt={displayed === source ? '私人角色形象' : '公开角色形象'}
          className="h-full w-full object-contain"
        />
      ) : (
        <div
          className="flex h-full min-h-16 items-center justify-center bg-violet-500/15 text-3xl"
          aria-label="默认角色形象"
        >
          ✦
        </div>
      )}
    </div>
  );
}

export function SelectedCharacterPortrait({
  speaking = false,
  fallbackSource,
}: {
  speaking?: boolean;
  fallbackSource?: string | null;
}) {
  const appearance = useSelectedCharacterAppearance();
  return (
    <div className="flex items-center gap-3">
      <CharacterPortrait
        photoId={appearance?.photoId ?? null}
        speaking={speaking}
        fallbackSource={fallbackSource}
        className="h-20 w-20"
      />
      <p className="text-xs text-[var(--text-faint)]">
        {speaking ? '正在说话' : '角色形象'} · 2D 头像
      </p>
    </div>
  );
}

/** Visual-only DOM overlay: never baked into camera frames or sent to the model. */
export function CharacterCameraOverlay({
  fallbackSource,
}: { fallbackSource?: string | null } = {}) {
  const appearance = useSelectedCharacterAppearance();
  const [enabled, setEnabled] = useState(false);
  return (
    <>
      <button
        type="button"
        className="absolute bottom-3 left-3 z-10 rounded bg-black/70 px-2 py-1 text-xs text-white"
        onClick={() => setEnabled(!enabled)}
        aria-pressed={enabled}
      >
        {enabled ? '关闭' : '开启'} 2D 角色叠加
      </button>
      {enabled && (
        <>
          <div
            className="pointer-events-none absolute bottom-12"
            style={{
              width: `${appearance?.scale ?? 35}%`,
              left:
                appearance?.position === 'left'
                  ? '4%'
                  : appearance?.position === 'center'
                    ? `${50 - appearance.scale / 2}%`
                    : undefined,
              right: !appearance || appearance.position === 'right' ? '4%' : undefined,
            }}
          >
            <CharacterPortrait
              photoId={appearance?.photoId ?? null}
              fallbackSource={fallbackSource}
              className="max-h-64"
            />
          </div>
          <span className="absolute left-3 top-16 rounded bg-black/60 p-1 text-[10px] text-white">
            2D 贴图体验 · 无 3D / 空间跟踪 · 不写入画面
          </span>
        </>
      )}
    </>
  );
}
