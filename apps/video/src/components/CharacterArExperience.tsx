import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  CharacterPortrait,
  useCharacterPhoto,
  useSelectedCharacterAppearance,
} from '@0xnullai/auth/appearance-react';
import {
  readPrivateConversationSelection,
  subscribePrivateConversationSelection,
} from '@0xnullai/auth';
import { Button } from '@0xnullai/ui';
import { ScanFace } from 'lucide-react';
import {
  startCharacterAr,
  supportsCharacterAr,
  type CharacterArHandle,
} from './character-ar-session';

/** WebXR requests happen only after the user presses the AR button. */
export function CharacterArExperience({ fallbackSource }: { fallbackSource?: string | null }) {
  const appearance = useSelectedCharacterAppearance();
  const privateSource = useCharacterPhoto(appearance?.photoId ?? null);
  const source = privateSource ?? (fallbackSource?.startsWith('blob:') ? fallbackSource : null);
  const selection = useSyncExternalStore(
    subscribePrivateConversationSelection,
    () => {
      const current = readPrivateConversationSelection();
      return `${current?.accountId ?? ''}:${current?.relationshipId ?? ''}:${current?.characterId ?? ''}`;
    },
    () => '',
  );
  const overlayRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<CharacterArHandle | null>(null);
  const startingRef = useRef(false);
  const generationRef = useRef(0);
  const [availability, setAvailability] = useState<'checking' | 'supported' | 'unavailable'>(
    'checking',
  );
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [placed, setPlaced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void supportsCharacterAr().then((available) => {
      if (current) setAvailability(available ? 'supported' : 'unavailable');
    });
    return () => {
      current = false;
    };
  }, []);

  // A WebXR session must not retain a previous account's or character's portrait.
  useEffect(() => {
    return () => {
      generationRef.current += 1;
      void handleRef.current?.end().catch(() => undefined);
    };
  }, [selection, source]);

  useEffect(() => {
    const hide = () => {
      if (document.hidden) void handleRef.current?.end().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, []);

  useEffect(() => {
    const toolbar = toolbarRef.current;
    const blockWorldSelect = (event: Event) => event.preventDefault();
    toolbar?.addEventListener('beforexrselect', blockWorldSelect);
    return () => toolbar?.removeEventListener('beforexrselect', blockWorldSelect);
  }, [active]);

  async function openAr() {
    if (
      startingRef.current ||
      handleRef.current ||
      availability !== 'supported' ||
      !overlayRef.current
    )
      return;
    startingRef.current = true;
    setStarting(true);
    const generation = generationRef.current;
    setError(null);
    setPlaced(false);
    try {
      const handle = await startCharacterAr({
        source,
        overlay: overlayRef.current,
        isCurrent: () => generation === generationRef.current,
        onEnd: () => {
          handleRef.current = null;
          setActive(false);
        },
        onPlacement: () => setPlaced(true),
      });
      if (generation !== generationRef.current) {
        await handle.end();
        return;
      }
      handleRef.current = handle;
      setActive(true);
    } catch (cause) {
      setError(
        cause instanceof DOMException && cause.name === 'NotSupportedError'
          ? '此浏览器或设备不支持 AR 平面检测；仍可使用 2D 角色形象。'
          : cause instanceof Error
            ? cause.message
            : '无法启动 AR',
      );
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }

  return (
    <section className="mx-auto flex w-full max-w-[680px] flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-3">
      <CharacterPortrait
        photoId={appearance?.photoId ?? null}
        fallbackSource={fallbackSource}
        className="h-16 w-16 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">角色形象与空间放置</h2>
        <p className="text-xs text-[var(--text-faint)]">
          {availability === 'supported'
            ? '浏览器报告支持 WebXR AR；进入时还需平面检测。对准平面并点按，可放置或移动 2D 角色形象。'
            : availability === 'checking'
              ? '正在检测浏览器 AR 能力；此处始终可查看 2D 角色形象。'
              : '此浏览器或设备不支持 WebXR AR；可继续使用 2D 角色形象和摄像头观察。'}
        </p>
        {error && (
          <p role="alert" className="mt-1 text-xs text-[var(--danger)]">
            {error}
          </p>
        )}
      </div>
      {availability === 'supported' && (
        <Button
          size="sm"
          variant="secondary"
          disabled={active || starting}
          onClick={() => void openAr()}
        >
          <ScanFace className="h-4 w-4" />
          {active ? 'AR 进行中' : '进入 AR 放置'}
        </Button>
      )}
      <div ref={overlayRef} className="pointer-events-none fixed inset-0 z-[100]">
        {active && (
          <div
            ref={toolbarRef}
            className="pointer-events-auto absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-black/75 p-4 text-xs text-white"
          >
            <span>{placed ? '已放置。再次点按可重新放置。' : '对准平面，点按画面放置角色。'}</span>
            <Button size="sm" variant="secondary" onClick={() => void handleRef.current?.end()}>
              退出 AR
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
