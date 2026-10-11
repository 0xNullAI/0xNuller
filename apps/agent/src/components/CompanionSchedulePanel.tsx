import { useEffect, useId, useRef, useState } from 'react';
import {
  listCompanionSchedules,
  saveCompanionSchedule,
  deleteCompanionSchedule,
  listCompanionNotifications,
  readCompanionNotification,
  type CompanionNotification,
  type CompanionSchedule,
  type CompanionScheduleInput,
} from '@0xnullai/auth';
import { AdvancedSettings } from './AdvancedSettings';

interface SchedulePanelProps {
  accountId: string;
  relationshipId: string;
  conversationId: string;
}
export function CompanionSchedulePanel(props: SchedulePanelProps) {
  return (
    <ScheduleForm
      key={`${props.accountId}:${props.relationshipId}:${props.conversationId}`}
      {...props}
    />
  );
}
function ScheduleForm({ accountId, relationshipId, conversationId }: SchedulePanelProps) {
  const [items, setItems] = useState<CompanionSchedule[]>([]);
  const [notifications, setNotifications] = useState<CompanionNotification[]>([]);
  const [editing, setEditing] = useState<CompanionSchedule | null>(null);
  const [template, setTemplate] = useState('');
  const [modelMode, setModelMode] = useState(false);
  const [consent, setConsent] = useState(false);
  const [capability, setCapability] = useState<{
    enabled: boolean;
    credits: number | null;
    priceVersion: string;
    reason: string | null;
  } | null>(null);
  const [kind, setKind] = useState<'once' | 'weekly'>('weekly');
  const [localDate, setDate] = useState('');
  const [localTime, setTime] = useState('09:00');
  const [timeZone, setZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [weekdays, setDays] = useState([1, 2, 3, 4, 5]);
  const [quietStart, setQuietStart] = useState('22:00');
  const [quietEnd, setQuietEnd] = useState('08:00');
  const [dailyLimit, setLimit] = useState(1);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const locked = useRef(true);
  const formId = useId();
  useEffect(() => {
    const version = ++generation.current;
    locked.current = true;
    void Promise.all([listCompanionSchedules(relationshipId), listCompanionNotifications()])
      .then(([result, updates]) => {
        if (generation.current === version) {
          setCapability(result.capability ?? null);
          setItems(result.items.filter((item) => item.conversationId === conversationId));
          setNotifications(updates.items.filter((item) => item.conversationId === conversationId));
        }
      })
      .catch((cause) => {
        if (generation.current === version)
          setError(cause instanceof Error ? cause.message : '读取失败');
      })
      .finally(() => {
        if (generation.current === version) {
          locked.current = false;
          setBusy(false);
        }
      });
    return () => {
      generation.current = version + 1;
    };
  }, [accountId, relationshipId, conversationId, refresh]);
  function input(item: CompanionSchedule): CompanionScheduleInput {
    const {
      id,
      version,
      relationshipId,
      conversationId,
      kind,
      localDate,
      localTime,
      timeZone,
      weekdays,
      quietStart,
      quietEnd,
      dailyLimit,
      template,
      paused,
    } = item;
    return {
      id,
      version,
      relationshipId,
      conversationId,
      kind,
      localDate,
      localTime,
      timeZone,
      weekdays,
      quietStart,
      quietEnd,
      dailyLimit,
      template,
      paused,
      ...(item.mode === 'model'
        ? {
            mode: item.mode,
            acceptedCredits: item.acceptedCredits,
            generationPriceVersion: item.generationPriceVersion,
            contextConsent: item.contextConsent,
          }
        : {}),
    };
  }
  async function change(operation: () => Promise<unknown>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const version = generation.current;
    let reloading = false;
    try {
      await operation();
      if (generation.current === version) {
        setNotice('已更新定时消息');
        setEditing(null);
        setTemplate('');
        reloading = true;
        setRefresh((v) => v + 1);
      }
    } catch (cause) {
      if (generation.current === version)
        setError(cause instanceof Error ? cause.message : '更新失败');
    } finally {
      if (generation.current === version && !reloading) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  function edit(item: CompanionSchedule) {
    setEditing(item);
    setTemplate(item.template);
    setModelMode(item.mode === 'model');
    setConsent(item.contextConsent === true);
    setKind(item.kind);
    setDate(item.localDate ?? '');
    setTime(item.localTime);
    setZone(item.timeZone);
    setDays(item.weekdays);
    setQuietStart(item.quietStart);
    setQuietEnd(item.quietEnd);
    setLimit(item.dailyLimit);
  }
  return (
    <section aria-label="定时陪伴消息" className="space-y-3 p-3 text-sm">
      <p>定时发送问候，网页关闭也会执行。</p>
      {error && (
        <div role="alert">
          {error}{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              locked.current = true;
              setBusy(true);
              setError('');
              setRefresh((v) => v + 1);
            }}
          >
            重新读取
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">正在处理…</p>}
      {notifications.some((item) => item.readAt === null) && (
        <div className="space-y-2" aria-label="定时消息通知">
          {notifications
            .filter((item) => item.readAt === null)
            .map((item) => (
              <div key={item.id} className="flex flex-wrap items-center gap-2">
                <span>{new Date(item.createdAt).toLocaleString()} · 新定时消息已加入此会话</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void change(() => readCompanionNotification(item.id))}
                >
                  标记已读
                </button>
              </div>
            ))}
        </div>
      )}
      <div className="max-h-56 space-y-2 overflow-y-auto">
        {items.map((item) => (
          <div key={item.id} className="rounded border border-[var(--surface-border)] p-2">
            <p className="whitespace-pre-wrap break-words">{item.template}</p>
            <p className="text-xs">
              {item.mode === 'model'
                ? `AI主动消息 · 每条 ${item.acceptedCredits} Credit`
                : '固定模板 · 免费'}
            </p>
            <p>
              {item.localTime} · {item.timeZone} ·{' '}
              {item.paused
                ? '已暂停'
                : item.nextRunAt
                  ? `下次 ${new Date(item.nextRunAt).toLocaleString()}`
                  : '等待安排'}
            </p>
            {item.lastError && <p>{item.lastError}</p>}
            <div className="flex flex-wrap gap-3">
              <button type="button" disabled={busy} onClick={() => edit(item)}>
                编辑
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void change(() => saveCompanionSchedule({ ...input(item), paused: !item.paused }))
                }
              >
                {item.paused ? '恢复' : '暂停'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void change(() => deleteCompanionSchedule(item.id, item.version))}
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
      <form
        id={formId}
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void change(() =>
            saveCompanionSchedule({
              id: editing?.id ?? crypto.randomUUID(),
              version: editing?.version ?? 0,
              relationshipId,
              conversationId,
              kind,
              ...(kind === 'once' ? { localDate } : {}),
              localTime,
              timeZone,
              weekdays,
              quietStart,
              quietEnd,
              dailyLimit,
              template,
              ...(modelMode
                ? {
                    mode: 'model' as const,
                    acceptedCredits: capability?.credits ?? undefined,
                    generationPriceVersion: capability?.priceVersion,
                    contextConsent: consent,
                  }
                : {}),
              paused: false,
            }),
          );
        }}
      >
        <fieldset disabled={busy} className="space-y-2">
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={modelMode}
              disabled={!capability?.enabled && !modelMode}
              onChange={(e) => setModelMode(e.target.checked)}
            />
            由AI根据近期对话主动聊天
          </label>
          {modelMode ? (
            <>
              <p className="text-xs">
                每条成功发送扣 {capability?.credits}{' '}
                Credit，失败释放；按下方频率自动运行，可随时暂停。
              </p>
              <label className="flex gap-2 text-xs">
                <input
                  type="checkbox"
                  required
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                允许将本角色关系资料、最近6条会话及最多4条已确认关系记忆发送给MiniMax，按所示价格自动扣费
              </label>
              <p className="text-xs">
                下方填写聊天主题，例如温和跟进最近谈到的安排；AI不会控制设备。
              </p>
            </>
          ) : (
            <p className="text-xs">
              {capability?.reason ?? '固定模板 0 Credit；启用AI模式需另行授权。'}
            </p>
          )}

          <label className="block">
            消息模板
            <textarea
              aria-label="消息模板"
              required
              maxLength={1000}
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              rows={3}
              className="block w-full rounded border bg-transparent p-2"
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <label>
              重复{' '}
              <select
                aria-label="重复"
                value={kind}
                onChange={(event) => setKind(event.target.value as 'once' | 'weekly')}
              >
                <option value="weekly">每周</option>
                <option value="once">一次</option>
              </select>
            </label>
            <label>
              本地时间{' '}
              <input
                aria-label="本地时间"
                type="time"
                required
                value={localTime}
                onChange={(event) => setTime(event.target.value)}
              />
            </label>
          </div>
          {kind === 'once' ? (
            <label className="block">
              日期{' '}
              <input
                aria-label="日期"
                type="date"
                required
                value={localDate}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
          ) : (
            <div className="flex flex-wrap gap-2">
              {['日', '一', '二', '三', '四', '五', '六'].map((day, index) => (
                <label key={day}>
                  <input
                    type="checkbox"
                    checked={weekdays.includes(index)}
                    onChange={(event) =>
                      setDays((days) =>
                        event.target.checked ? [...days, index] : days.filter((d) => d !== index),
                      )
                    }
                  />
                  周{day}
                </label>
              ))}
            </div>
          )}
          <div className="flex gap-3">
            <button type="submit" disabled={!template.trim()}>
              {editing ? '保存修改' : '添加定时消息'}
            </button>
            {editing && (
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setTemplate('');
                }}
              >
                取消编辑
              </button>
            )}
          </div>
        </fieldset>
      </form>
      <AdvancedSettings>
        {/* Portaled outside the form element; `form` keeps these fields in submit and validation. */}
        <div className="space-y-2 text-sm">
          <h4 className="font-medium">定时消息的时区与频率</h4>
          <label className="block">
            时区{' '}
            <input
              aria-label="时区"
              form={formId}
              disabled={busy}
              required
              value={timeZone}
              onChange={(event) => setZone(event.target.value)}
              className="max-w-full rounded border bg-transparent"
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <label>
              安静开始{' '}
              <input
                aria-label="安静开始"
                form={formId}
                disabled={busy}
                type="time"
                value={quietStart}
                onChange={(event) => setQuietStart(event.target.value)}
              />
            </label>
            <label>
              安静结束{' '}
              <input
                aria-label="安静结束"
                form={formId}
                disabled={busy}
                type="time"
                value={quietEnd}
                onChange={(event) => setQuietEnd(event.target.value)}
              />
            </label>
          </div>
          <p className="text-xs">安静时段内顺延；开始与结束相同时不限制。</p>
          <label className="block">
            账号24小时上限{' '}
            <select
              aria-label="24小时上限"
              form={formId}
              disabled={busy}
              value={dailyLimit}
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n} 条
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs">两条消息至少间隔 30 分钟，超出上限会顺延。</p>
        </div>
      </AdvancedSettings>
    </section>
  );
}
