import { useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'dg-chat-safety-accepted';

const SECTIONS = [
  {
    title: '开始前确认',
    items: [
      '本项目会驱动设备输出波形，浏览器、蓝牙与网络链路都可能出现异常或延迟。',
      '使用时请保持清醒，并确保你可以随时通过物理方式断开设备或停止输出。',
      '本项目不是医疗产品，也不能替代专业判断或风险评估。',
    ],
  },
  {
    title: '禁用与慎用',
    items: [
      '心脏起搏器、心血管疾病、癫痫、孕期或任何不确定身体状况时，请不要使用。',
      '禁止将电极放在胸口、头部、颈部、破损皮肤、炎症区域或任何异常敏感部位。',
      '独处、睡眠、洗澡、饮酒后、驾驶中或操作机械时，禁止使用。',
    ],
  },
  {
    title: '使用中要求',
    items: [
      '首次使用或更换部位时，请从最低强度开始，逐步确认体感与安全边界。',
      '输出期间不要移动电极，不要频繁切换贴片位置，也不要让导电部件短接。',
      '若出现刺痛、灼热、头晕、心悸或任何不适，请立刻停止并断开设备。',
    ],
  },
] as const;

export function useSafetyAccepted() {
  const [accepted, setAccepted] = useState(() =>
    localStorage.getItem(STORAGE_KEY) === 'true'
  );

  function accept(dontShowAgain: boolean) {
    if (dontShowAgain) {
      localStorage.setItem(STORAGE_KEY, 'true');
    }
    setAccepted(true);
  }

  return { accepted, accept };
}

interface SafetyNoticeProps {
  onAccept: (options: { dontShowAgain: boolean }) => void;
}

export function SafetyNotice({ onAccept }: SafetyNoticeProps) {
  const [remaining, setRemaining] = useState(10);
  const [dontShow, setDontShow] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  useEffect(() => {
    if (remaining === 0) {
      btnRef.current?.focus();
      return;
    }
    const t = setTimeout(() => setRemaining(s => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [remaining]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 bg-black/50 backdrop-blur-sm">
      <article className="w-full max-w-[960px] max-h-[90vh] overflow-auto rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] p-5 shadow-[var(--shadow)] scrollbar-none sm:p-6">
        {/* Header */}
        <div className="mb-1">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-[var(--accent)]">安全确认</span>
          <h2 className="mt-1 text-xl font-bold tracking-tight text-[var(--text)] sm:text-2xl">使用前安全确认</h2>
          <p className="mt-2 text-sm leading-relaxed text-[var(--text-soft)]">
            继续之前，请确认你已经理解设备控制以及浏览器运行环境带来的风险，并能够随时主动停止。
          </p>
        </div>

        {/* Callout */}
        <div className="mt-4 rounded-[var(--radius-md)] border border-amber-500/20 bg-gradient-to-br from-amber-500/15 to-amber-500/5 p-4">
          <p className="font-semibold text-sm text-[var(--text)]">远程控制具有不确定性。</p>
          <p className="mt-1 text-sm text-[var(--text-soft)]">浏览器、蓝牙或网络链路可能卡顿、断连或产生非预期行为。请始终把"立刻停止输出"和"立刻断开设备"放在最高优先级。</p>
        </div>

        {/* Sections */}
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {SECTIONS.map(section => (
            <div key={section.title} className="rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--bg)] p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-[var(--text)]">{section.title}</h3>
              <ul className="mt-3 space-y-2.5">
                {section.items.map((item, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-sm leading-relaxed text-[var(--text-soft)]">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--surface-border)] bg-[var(--bg-elevated)] text-[11px] font-bold text-[var(--text)]">
                      {i + 1}
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="mt-5 flex flex-col gap-3 border-t border-[var(--surface-border)] pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-[var(--text-soft)]">继续即表示你已阅读并愿意自行承担使用风险。</p>
            <label className="mt-2 flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={dontShow}
                onChange={e => setDontShow(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              <span className="text-sm text-[var(--text-soft)]">下次启动时不再弹出这条安全确认</span>
            </label>
          </div>
          <button
            ref={btnRef}
            disabled={remaining > 0}
            onClick={() => onAccept({ dontShowAgain: dontShow })}
            className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--accent)] px-6 py-2.5 text-sm font-medium text-[var(--button-text)] transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {remaining > 0 ? `我已阅读（${remaining}s）` : '我已阅读并继续'}
          </button>
        </div>
      </article>
    </div>
  );
}
