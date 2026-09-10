import { Download, Send } from 'lucide-react';
import { submitFeedback } from '@0xnullai/auth';
import { useState } from 'react';
import { ExperimentalDeviceSection } from './ExperimentalDeviceSection';
import { CLIENT_DOWNLOAD_URL, PRODUCT_BUILD_ID, PRODUCT_VERSION } from '../product';

export function AboutTab() {
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const buildLabel =
    PRODUCT_BUILD_ID.length === 40 ? PRODUCT_BUILD_ID.slice(0, 12) : PRODUCT_BUILD_ID;
  return (
    <div className="flex max-w-lg flex-col gap-5">
      <section>
        <h3 className="text-sm font-semibold">0xNuller</h3>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-[var(--text-faint)]">产品版本</dt>
          <dd className="font-mono text-[var(--text)]">v{PRODUCT_VERSION}</dd>
          <dt className="text-[var(--text-faint)]">构建</dt>
          <dd className="break-all font-mono text-xs text-[var(--text-soft)]">{buildLabel}</dd>
        </dl>
      </section>
      <ExperimentalDeviceSection />
      <section className="border-t border-[var(--surface-border)] pt-4">
        <h3 className="text-sm font-semibold">反馈</h3>
        <p className="mt-1 text-xs text-[var(--text-faint)]">内容会安全保存并转发给产品维护者。</p>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={4000}
          placeholder="请描述问题或建议"
          className="mt-3 min-h-28 w-full rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-soft)] p-3 text-sm"
        />
        <input
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          maxLength={254}
          placeholder="联系方式（可选）"
          className="mt-2 min-h-10 w-full rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-soft)] px-3 text-sm"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            disabled={sending || !message.trim()}
            onClick={async () => {
              setSending(true);
              setStatus(null);
              try {
                await submitFeedback({ message, contact });
                setMessage('');
                setContact('');
                setStatus('已提交，感谢反馈。');
              } catch (e) {
                setStatus(e instanceof Error ? e.message : '提交失败，请稍后重试');
              } finally {
                setSending(false);
              }
            }}
            className="inline-flex min-h-10 items-center gap-2 rounded-[var(--radius-ctl)] bg-[var(--accent)] px-3 text-sm text-white disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            {sending ? '提交中…' : '提交反馈'}
          </button>
          {status && (
            <span role="status" className="text-xs text-[var(--text-soft)]">
              {status}
            </span>
          )}
        </div>
      </section>
      <section className="flex flex-wrap gap-2 border-t border-[var(--surface-border)] pt-4">
        <a
          href={CLIENT_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-10 items-center gap-2 rounded-[var(--radius-ctl)] border border-[var(--surface-border)] px-3 text-sm text-[var(--text)] hover:bg-[var(--bg-soft)]"
        >
          <Download className="h-4 w-4" /> 下载客户端
        </a>
      </section>
    </div>
  );
}
