import { useEffect, useState } from 'react';
import { Globe, Lock } from 'lucide-react';
import { getProfile, saveProfile, type UserProfile } from '@0xnullai/auth';

/**
 * Profile editing.
 *
 * Everything here is optional, and the copy says so — for this product, being
 * asked for personal details before you can use it is a reason to close the
 * tab.
 *
 * Two choices worth stating, because they look like omissions:
 *
 * The location field asks for a city or region, not a street address, and is
 * capped short enough that a full address does not fit. For this category of
 * product, a home address in a database that later leaks is a physical-safety
 * problem, not a spam problem, and no feature here needs that precision.
 *
 * Visibility is private by default and the toggle says plainly what public
 * means. Details like these cannot be un-shown once someone has seen them,
 * so being visible has to be a decision somebody made, not a default they
 * inherited.
 */
export function ProfileEditor() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getProfile()
      .then((p) => {
        if (!alive) return;
        setProfile(
          p ?? {
            avatarUrl: null,
            bio: null,
            birthDate: null,
            location: null,
            links: [],
            visibility: 'private',
          },
        );
      })
      .catch(() => {
        if (alive) setProfile(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!profile) return null;

  function patch(next: Partial<UserProfile>) {
    setProfile((prev) => (prev ? { ...prev, ...next } : prev));
    setStatus('idle');
  }

  async function save() {
    if (!profile) return;
    setStatus('saving');
    setError(null);
    try {
      await saveProfile(profile);
      setStatus('saved');
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : '保存失败');
    }
  }

  const isPublic = profile.visibility === 'public';

  return (
    <div className="mt-5 flex flex-col gap-3 border-t border-[var(--surface-border)] pt-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">个人资料</span>
        <span className="text-[10px] text-[var(--text-faint)]">全部选填</span>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-[var(--text-soft)]">简介</span>
        <textarea
          value={profile.bio ?? ''}
          onChange={(e) => patch({ bio: e.target.value })}
          maxLength={500}
          rows={3}
          placeholder="想让别人知道的一句话"
          className="resize-none rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-[var(--text-soft)]">生日</span>
        <input
          type="date"
          value={profile.birthDate ?? ''}
          onChange={(e) => patch({ birthDate: e.target.value || null })}
          className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
        <span className="text-[10px] text-[var(--text-faint)]">用于确认成年，不会公开显示具体日期。</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-[var(--text-soft)]">所在地区</span>
        <input
          value={profile.location ?? ''}
          onChange={(e) => patch({ location: e.target.value })}
          maxLength={60}
          placeholder="例如：上海"
          className="rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
        <span className="text-[10px] text-[var(--text-faint)]">
          只填到城市就够了。不要填详细住址——这类信息一旦泄露，风险不是被打扰而是人身安全。
        </span>
      </label>

      <button
        type="button"
        onClick={() => patch({ visibility: isPublic ? 'private' : 'public' })}
        className="flex items-center justify-between gap-3 rounded-[var(--radius-ctl)] border border-[var(--surface-border)] px-3 py-2 text-left"
      >
        <span className="flex items-center gap-2 text-sm">
          {isPublic ? (
            <Globe className="h-4 w-4 text-[var(--warning)]" />
          ) : (
            <Lock className="h-4 w-4 text-[var(--text-soft)]" />
          )}
          {isPublic ? '公开' : '仅自己可见'}
        </span>
        <span className="text-[10px] text-[var(--text-faint)]">
          {isPublic ? '房间里的其他人能看到以上内容' : '点击改为公开'}
        </span>
      </button>

      <div className="flex items-center justify-end gap-3">
        {status === 'saved' && <span className="text-xs text-[var(--success)]">已保存</span>}
        {status === 'error' && <span className="text-xs text-[var(--danger)]">{error}</span>}
        <button
          type="button"
          onClick={() => void save()}
          disabled={status === 'saving'}
          className="rounded-[var(--radius-ctl)] bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--button-text)] disabled:opacity-50"
        >
          {status === 'saving' ? '保存中…' : '保存资料'}
        </button>
      </div>
    </div>
  );
}
