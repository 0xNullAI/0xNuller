import { Globe, Link2, Lock, Plus, X } from 'lucide-react';
import { Input, Textarea } from '@0xnullai/ui';
import type { UserProfile } from '@0xnullai/auth';
import { ProfileSection } from './frame';

/**
 * The self-edit mode of the profile.
 *
 * It sits inside the same dialog, under the same identity block, in the same
 * order as the read-only view: bio where the bio is, region where the region
 * is. That is the point of it — you are editing the page, not filling in a
 * form that happens to feed it. The previous version was a labelled stack
 * bolted onto the bottom of the account dialog, and nothing in it told you
 * what other people would end up seeing.
 *
 * The fields only. Saving lives in the dialog's action bar along with follow
 * and direct message, because that bar is pinned and this list scrolls — a
 * save button at the end of the list is a save button below the fold, next to
 * a pinned 「关闭」 that discards everything.
 *
 * **Every field is optional and the copy says so.** An account that fills in
 * nothing is a first-class account. For this product, being asked for personal
 * details before you can use something is a reason to close the tab, so
 * 「全部选填」 is stated where it will be read rather than buried in help text.
 *
 * Two limits here are deliberate and must survive future edits:
 *
 * `location` is region-level, and the input is capped short enough that a
 * street address does not fit. For this category of product a home address in
 * a database that later leaks is a physical-safety problem, not a spam
 * problem, and nothing in the product needs that precision.
 *
 * `visibility` is private by default and the two options say plainly what each
 * one means. Information like this cannot be un-seen once somebody has seen
 * it, so being visible has to be a decision that was made rather than one that
 * was inherited.
 *
 * There is no avatar upload and no avatar URL field. See the note on `Avatar`
 * in @0xnullai/ui: uploads mean a moderation pipeline, and a remote URL adds
 * handing every viewer's IP to a third-party host on top of that.
 */

const MAX_LINKS = 5;

/** Blank rows are how a link is removed, so they are dropped on the way out rather than stored. */
export function cleanProfile(draft: UserProfile): UserProfile {
  return {
    ...draft,
    bio: draft.bio?.trim() || null,
    location: draft.location?.trim() || null,
    links: draft.links.map((l) => l.trim()).filter(Boolean),
  };
}

export function ProfileForm({
  draft,
  onChange,
}: {
  draft: UserProfile;
  onChange: (next: UserProfile) => void;
}) {
  const patch = (next: Partial<UserProfile>) => onChange({ ...draft, ...next });

  return (
    <div className="flex flex-col gap-5">
      <ProfileSection title="简介" hint="全部选填">
        <Textarea
          value={draft.bio ?? ''}
          onChange={(e) => patch({ bio: e.target.value })}
          maxLength={500}
          rows={3}
          placeholder="想让别人知道的一句话"
          className="resize-none"
          aria-label="简介"
        />
      </ProfileSection>

      <ProfileSection title="所在地区">
        <Input
          value={draft.location ?? ''}
          onChange={(e) => patch({ location: e.target.value })}
          maxLength={60}
          placeholder="例如：上海"
          aria-label="所在地区"
        />
        <p className="text-[10px] leading-relaxed text-[var(--text-faint)]">
          只填到城市就够了。不要填详细住址——这类信息一旦泄露，风险不是被打扰而是人身安全。
        </p>
      </ProfileSection>

      <ProfileSection title="生日">
        <Input
          type="date"
          value={draft.birthDate ?? ''}
          onChange={(e) => patch({ birthDate: e.target.value || null })}
          aria-label="生日"
        />
        <p className="text-[10px] text-[var(--text-faint)]">
          用于确认成年。具体日期不会展示给任何人，公开主页上也不会。
        </p>
      </ProfileSection>

      <ProfileSection title="链接" hint={`最多 ${MAX_LINKS} 条`}>
        <div className="flex flex-col gap-2">
          {draft.links.map((link, i) => (
            <div key={i} className="flex items-center gap-2">
              <Link2 className="h-4 w-4 shrink-0 text-[var(--text-faint)]" />
              <Input
                value={link}
                onChange={(e) =>
                  patch({ links: draft.links.map((l, j) => (j === i ? e.target.value : l)) })
                }
                placeholder="https://"
                aria-label={`链接 ${i + 1}`}
              />
              <button
                type="button"
                aria-label={`删除链接 ${i + 1}`}
                onClick={() => patch({ links: draft.links.filter((_, j) => j !== i) })}
                className="shrink-0 rounded-[var(--radius-ctl)] p-1.5 text-[var(--text-faint)] transition-colors duration-[var(--dur)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          {draft.links.length < MAX_LINKS && (
            <button
              type="button"
              onClick={() => patch({ links: [...draft.links, ''] })}
              className="flex items-center gap-1.5 self-start rounded-[var(--radius-ctl)] px-2 py-1 text-xs text-[var(--text-soft)] transition-colors duration-[var(--dur)] hover:bg-[var(--bg-soft)] hover:text-[var(--text)]"
            >
              <Plus className="h-3.5 w-3.5" />
              添加链接
            </button>
          )}
        </div>
        <p className="text-[10px] leading-relaxed text-[var(--text-faint)]">
          链接会把这个账号和站外身份连起来，想清楚再填。
        </p>
      </ProfileSection>

      <ProfileSection title="谁能看到">
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              {
                value: 'private',
                icon: <Lock className="h-4 w-4" />,
                title: '仅自己可见',
                blurb: '别人打开你的主页只会看到用户名。',
              },
              {
                value: 'public',
                icon: <Globe className="h-4 w-4" />,
                title: '公开',
                blurb: '任何人都能看到以上内容，包括没有登录的人。',
              },
            ] as const
          ).map((option) => {
            const active = draft.visibility === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => patch({ visibility: option.value })}
                className={
                  'flex flex-col gap-1 rounded-[var(--radius-sm)] border px-3 py-2.5 text-left transition-colors duration-[var(--dur)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ' +
                  (active
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--surface-border)] hover:border-[var(--surface-border-strong)]')
                }
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span className={active ? 'text-[var(--accent)]' : 'text-[var(--text-faint)]'}>
                    {option.icon}
                  </span>
                  {option.title}
                </span>
                <span className="text-[10px] leading-relaxed text-[var(--text-faint)]">
                  {option.blurb}
                </span>
              </button>
            );
          })}
        </div>
      </ProfileSection>
    </div>
  );
}
