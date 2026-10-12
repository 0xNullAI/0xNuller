import { CharacterAvatarDrawing } from './CharacterAvatarDrawing';
import { useEffect, useState, useRef } from 'react';
import { Button } from '@0xnullai/ui';
import { AdvancedSettings } from './AdvancedSettings';
import {
  currentAuthUserId,
  listPhotos,
  uploadPhoto,
  subscribeAuthChanges,
  type UserPhoto,
} from '@0xnullai/auth';
import {
  getCharacterAppearance,
  saveCharacterAppearance,
  type CharacterAppearance,
} from '@0xnullai/auth/appearance';
import { CharacterPortrait } from '@0xnullai/auth/appearance-react';

export function CharacterAppearancePanel({ relationshipId }: { relationshipId: string }) {
  return <AppearanceEditor key={relationshipId} relationshipId={relationshipId} />;
}

function AppearanceEditor({ relationshipId }: { relationshipId: string }) {
  const generation = useRef(0);
  const [drawing, setDrawing] = useState(false);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const [draft, setDraft] = useState<CharacterAppearance | null>(null);
  const [photos, setPhotos] = useState<UserPhoto[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState(currentAuthUserId);
  useEffect(
    () =>
      subscribeAuthChanges(() => {
        if (currentAuthUserId() !== account) {
          generation.current += 1;
          setAccount(currentAuthUserId());
          setDraft(null);
          setPhotos([]);
          setDrawing(false);
        }
      }),
    [account],
  );
  useEffect(() => {
    let valid = true;
    void Promise.all([getCharacterAppearance(relationshipId), listPhotos()])
      .then(([appearance, items]) => {
        if (valid && currentAuthUserId() === account) {
          setDraft(appearance);
          setPhotos(items);
        }
      })
      .catch((reason: unknown) => {
        if (valid) setError(String(reason));
      });
    return () => {
      valid = false;
    };
  }, [relationshipId, account]);
  const save = async (next: CharacterAppearance | null = draft) => {
    if (!next || busy) return;
    const operation = generation.current;
    setBusy(true);
    setError('');
    try {
      const result = await saveCharacterAppearance(relationshipId, next);
      if (currentAuthUserId() === account && generation.current === operation) setDraft(result);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-4 rounded-xl border border-[var(--surface-border)] p-4">
      <div>
        <h3 className="font-medium">头像</h3>
        <p className="text-xs text-[var(--text-faint)]">
          只在你们的聊天里显示，不会改动公开角色卡。
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      {draft && (
        <>
          <div className="flex flex-wrap items-center gap-4">
            <CharacterPortrait
              photoId={draft.photoId}
              className="h-24 w-24 shrink-0 rounded-full bg-[var(--bg-soft)]"
            />
            <div className="flex flex-wrap gap-2">
              <label
                className={`inline-flex h-8 cursor-pointer items-center rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-[var(--accent-foreground,#fff)] ${busy ? 'pointer-events-none opacity-60' : ''}`}
              >
                上传图片
                <input
                  className="sr-only"
                  aria-label="上传私人图片"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    if (
                      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
                      file.size > 8 * 1024 * 1024
                    ) {
                      setError('请选择 8MB 以内的 PNG/JPEG/WebP 图片');
                      return;
                    }
                    const operation = generation.current;
                    setBusy(true);
                    setError('');
                    void uploadPhoto(file, {
                      visibility: 'private',
                      purpose: 'album',
                      caption: '私人角色形象',
                    })
                      .then(async (photo) => {
                        if (currentAuthUserId() !== account || generation.current !== operation)
                          return;
                        setPhotos((items) => [photo, ...items]);
                        const saved = await saveCharacterAppearance(relationshipId, {
                          ...draft,
                          photoId: photo.id,
                        });
                        if (currentAuthUserId() === account && generation.current === operation)
                          setDraft(saved);
                      })
                      .catch((reason: unknown) => setError(String(reason)))
                      .finally(() => setBusy(false));
                  }}
                />
              </label>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => setDrawing(!drawing)}
              >
                {drawing ? '收起画板' : '给 AI 画头像'}
              </Button>
            </div>
          </div>
          {drawing && (
            <CharacterAvatarDrawing
              onClose={() => setDrawing(false)}
              onSave={async (png) => {
                const operation = generation.current;
                const owner = currentAuthUserId();
                if (!owner || owner !== account) throw new Error('账户已切换，请重新打开画板');
                setBusy(true);
                try {
                  const photo = await uploadPhoto(png, {
                    visibility: 'private',
                    purpose: 'album',
                    caption: '手绘私人角色头像',
                  });
                  if (generation.current !== operation || currentAuthUserId() !== owner)
                    throw new Error('账户已切换，未替换头像');
                  setPhotos((items) => [photo, ...items]);
                  const saved = await saveCharacterAppearance(relationshipId, {
                    ...draft,
                    photoId: photo.id,
                  });
                  if (generation.current !== operation || currentAuthUserId() !== owner)
                    throw new Error('账户已切换');
                  setDraft(saved);
                } finally {
                  if (generation.current === operation) setBusy(false);
                }
              }}
            />
          )}
          {photos.length > 0 && (
            <label className="block text-sm">
              从相册选择
              <select
                className="ml-2 max-w-full rounded border p-1"
                value={draft.photoId ?? ''}
                disabled={busy}
                onChange={(event) => void save({ ...draft, photoId: event.target.value || null })}
              >
                <option value="">默认形象</option>
                {photos.map((photo) => (
                  <option key={photo.id} value={photo.id}>
                    {photo.caption || `图片 ${photo.id.slice(0, 8)}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <AdvancedSettings>
            <div className="space-y-2">
              <h4 className="text-sm font-medium">视频通话中的形象</h4>
              <p className="text-xs text-[var(--text-faint)]">摄像头画面上以 2D 贴图显示。</p>
              <label className="block text-sm">
                叠加大小 {draft.scale}%
                <input
                  aria-label="叠加大小"
                  type="range"
                  min={15}
                  max={70}
                  value={draft.scale}
                  onChange={(event) => setDraft({ ...draft, scale: Number(event.target.value) })}
                />
              </label>
              <label className="block text-sm">
                叠加位置
                <select
                  className="ml-2 rounded border p-1"
                  value={draft.position}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      position: event.target.value as CharacterAppearance['position'],
                    })
                  }
                >
                  <option value="left">左</option>
                  <option value="center">中</option>
                  <option value="right">右</option>
                </select>
              </label>
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {busy ? '正在保存…' : '保存视频形象'}
              </Button>
            </div>
          </AdvancedSettings>
        </>
      )}
    </section>
  );
}
