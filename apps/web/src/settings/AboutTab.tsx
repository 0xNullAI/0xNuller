import { HardDrive, MessageSquare, Send } from 'lucide-react';
import { submitFeedback } from '@0xnullai/auth';
import { Button, Input, Textarea } from '@0xnullai/ui';
import { useCallback, useState, type ReactNode } from 'react';
import { PRODUCT_BUILD_ID, PRODUCT_VERSION } from '../product';
import { AdvancedSubpage } from './SettingsAdvanced';
import { SettingsGroup, SettingsPage, SettingsRow } from './settings-list';

/** 关于: version, then 数据 (export/import) and 反馈 as entries. */
export function AboutTab({ data }: { data?: ReactNode }) {
  const [page, setPage] = useState<'main' | 'data' | 'feedback'>('main');
  const back = useCallback(() => setPage('main'), []);
  const buildLabel =
    PRODUCT_BUILD_ID.length === 40 ? PRODUCT_BUILD_ID.slice(0, 12) : PRODUCT_BUILD_ID;

  if (page === 'data')
    return (
      <AdvancedSubpage title="数据" onBack={back}>
        {data}
      </AdvancedSubpage>
    );
  if (page === 'feedback')
    return (
      <AdvancedSubpage title="反馈" onBack={back}>
        <FeedbackForm />
      </AdvancedSubpage>
    );

  return (
    <SettingsPage>
      <SettingsGroup label="猫愿">
        <SettingsRow label="版本" value={`v${PRODUCT_VERSION}`} />
        <SettingsRow label="构建" value={<span className="font-mono text-xs">{buildLabel}</span>} />
      </SettingsGroup>
      <SettingsGroup>
        {data ? (
          <SettingsRow icon={HardDrive} label="数据" onClick={() => setPage('data')} />
        ) : null}
        <SettingsRow icon={MessageSquare} label="反馈" onClick={() => setPage('feedback')} />
      </SettingsGroup>
    </SettingsPage>
  );
}

function FeedbackForm() {
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  return (
    <SettingsPage>
      <SettingsGroup footer={status ?? '我们会认真看每一条反馈。'}>
        <div className="flex flex-col gap-2 p-4">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={4000}
            rows={5}
            aria-label="反馈内容"
            placeholder="请描述问题或建议"
            className="text-sm"
          />
          <Input
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            maxLength={254}
            aria-label="联系方式"
            placeholder="联系方式（可选）"
            className="text-sm"
          />
        </div>
      </SettingsGroup>
      <Button
        className="w-fit"
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
    </SettingsPage>
  );
}
