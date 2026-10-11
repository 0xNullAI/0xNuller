import { Overlay } from '@0xnullai/ui';
import { currentAuthUserId } from '@0xnullai/auth';
import type { GroupMembership } from '../../worker/wire';
export function GroupMembershipDialog({
  members,
  onAction,
  onClose,
}: {
  members: GroupMembership[];
  onAction: (action: 'list' | 'remove' | 'ban' | 'restore', accountId?: string) => void;
  onClose: () => void;
}) {
  return (
    <Overlay onDismiss={onClose}>
      <section
        role="dialog"
        aria-label="群成员管理"
        className="max-h-[80vh] w-full max-w-md overflow-auto rounded-2xl bg-[var(--bg)] p-4"
      >
        <div className="flex items-center justify-between">
          <h2>群成员管理</h2>
          <button onClick={onClose}>关闭</button>
        </div>
        <p className="my-2 text-xs text-[var(--text-faint)]">
          显示最近 200 位已验证成员。旧匿名成员不会自动关联账号。移除与封禁都需恢复后才能重新加入。
        </p>
        <button onClick={() => onAction('list')} className="mb-2 text-sm">
          刷新成员
        </button>
        {members.length === 0 && <p role="status">暂无可显示的已验证成员。</p>}
        {members.map((member) => (
          <div
            key={member.account_id}
            className="flex items-center gap-2 border-t border-[var(--surface-border)] py-2 text-sm"
          >
            <span className="min-w-0 flex-1 truncate">
              {member.name || '未命名成员'} ·{' '}
              {
                { active: '在群内', left: '已退出', removed: '已移除', banned: '已封禁' }[
                  member.state
                ]
              }
            </span>
            {member.account_id !== currentAuthUserId() &&
              (member.state === 'removed' || member.state === 'banned' ? (
                <button onClick={() => onAction('restore', member.account_id)}>恢复加入</button>
              ) : (
                <>
                  <button onClick={() => onAction('remove', member.account_id)}>移除</button>
                  <button onClick={() => onAction('ban', member.account_id)}>封禁</button>
                </>
              ))}
          </div>
        ))}
      </section>
    </Overlay>
  );
}
