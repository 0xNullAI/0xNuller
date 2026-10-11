import { Send } from 'lucide-react';
import { submitFeedback } from '@0xnullai/auth';
import { Button, Input, Textarea } from '@0xnullai/ui';
import { useCallback, useState, type ReactNode } from 'react';
import { PRODUCT_BUILD_ID, PRODUCT_VERSION } from '../product';
import { AdvancedEntryRow, AdvancedSubpage } from './SettingsAdvanced';

/** 关于: version, feedback, and the 数据 page (export/import) as an entry at the bottom. */
export function AboutTab({ data }: { data?: ReactNode }) {
  const [dataOpen, setDataOpen] = useState(false);
  const closeData = useCallback(() => setDataOpen(false), []);
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const buildLabel =
    PRODUCT_BUILD_ID.length === 40 ? PRODUCT_BUILD_ID.slice(0, 12) : PRODUCT_BUILD_ID;
  if (dataOpen)
    return (
      <AdvancedSubpage title="数据" onBack={closeData}>
        {data}
      </AdvancedSubpage>
    );
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="text-sm font-semibold">猫愿</h3>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-[var(--text-faint)]">产品版本</dt>
          <dd className="font-mono text-[var(--text)]">v{PRODUCT_VERSION}</dd>
          <dt className="text-[var(--text-faint)]">构建</dt>
          <dd className="break-all font-mono text-xs text-[var(--text-soft)]">{buildLabel}</dd>
        </dl>
      </section>
      {data ? <AdvancedEntryRow label="数据" onOpen={() => setDataOpen(true)} /> : null}
      <section>
        <h3 className="text-sm font-semibold">反馈</h3>
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={4000}
          rows={4}
          aria-label="反馈内容"
          placeholder="请描述问题或建议"
          className="mt-3 text-sm"
        />
        <Input
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          maxLength={254}
          aria-label="联系方式"
          placeholder="联系方式（可选）"
          className="mt-2 text-sm"
        />
        <div className="mt-2 flex items-center gap-3">
          <Button
            size="sm"
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
          >
            <Send className="h-4 w-4" />
            {sending ? '提交中…' : '提交反馈'}
          </Button>
          {status && (
            <span role="status" className="text-xs text-[var(--text-soft)]">
              {status}
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
