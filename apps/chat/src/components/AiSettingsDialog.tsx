import { Overlay } from '@0xnullai/ui';
import { useState } from 'react';
import { X, Bot } from 'lucide-react';
import type { AiConfig } from '../lib/ai-config';
import { AI_PROVIDER_PRESETS, getPreset, loadAiConfig, saveAiConfig } from '../lib/ai-config';

interface AiSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AiSettingsDialog({ open, onClose }: AiSettingsDialogProps) {
  // Load the saved config on init; saving updates local state in step (this component is
  // the only writer).
  const [config, setConfig] = useState<AiConfig>(loadAiConfig);

  if (!open) return null;

  const preset = getPreset(config.providerId);
  const needsKey = preset?.needsKey ?? true;

  function selectPreset(id: string) {
    const p = getPreset(id);
    if (!p) return;
    setConfig((c) => ({
      providerId: p.id,
      // Switching presets prefills baseUrl / model (still editable).
      baseUrl: p.baseUrl,
      model: p.defaultModel,
      // Presets that need no key clear apiKey, so no credential is carried over by mistake.
      apiKey: p.needsKey ? c.apiKey : '',
    }));
  }

  function save() {
    saveAiConfig({
      providerId: config.providerId,
      baseUrl: config.baseUrl.trim(),
      model: config.model.trim(),
      apiKey: config.apiKey.trim(),
    });
    onClose();
  }

  const inputClass =
    'w-full rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]';

  return (
    <Overlay onDismiss={onClose}>
      <div
        role="dialog"
        aria-label="AI 设置"
        className="flex max-h-[85vh] w-[min(480px,calc(100vw-32px))] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--surface-border)] bg-[var(--bg-elevated)] shadow-[var(--shadow)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Title bar */}
        <div className="flex items-center justify-between border-b border-[var(--surface-border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold text-[var(--text)]">AI 设置</h2>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-soft)] hover:bg-[var(--bg-soft)]"
            aria-label="关闭"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {/* Provider preset */}
          <div className="space-y-1">
            <label className="text-xs text-[var(--text-soft)]">供应商</label>
            <select
              value={config.providerId}
              onChange={(e) => selectPreset(e.target.value)}
              className={inputClass}
              style={{ fontSize: '16px' }}
            >
              {AI_PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {/* Model */}
          <div className="space-y-1">
            <label className="text-xs text-[var(--text-soft)]">模型</label>
            <input
              value={config.model}
              onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value }))}
              placeholder="gpt-4o-mini"
              className={inputClass}
              style={{ fontSize: '16px' }}
            />
          </div>

          {/* API endpoint */}
          <div className="space-y-1">
            <label className="text-xs text-[var(--text-soft)]">接口地址</label>
            <input
              value={config.baseUrl}
              onChange={(e) => setConfig((c) => ({ ...c, baseUrl: e.target.value }))}
              placeholder="https://api.openai.com/v1"
              className={inputClass}
              style={{ fontSize: '16px' }}
            />
          </div>

          {/* API key (shown only for providers that need one) */}
          {needsKey && (
            <div className="space-y-1">
              <label className="text-xs text-[var(--text-soft)]">API 密钥</label>
              <input
                type="password"
                value={config.apiKey}
                onChange={(e) => setConfig((c) => ({ ...c, apiKey: e.target.value }))}
                placeholder="sk-..."
                autoComplete="off"
                className={inputClass}
                style={{ fontSize: '16px' }}
              />
            </div>
          )}

          {/* Hint */}
          <p className="text-xs leading-relaxed text-[var(--text-faint)]">
            {needsKey
              ? '兼容 OpenAI Chat Completions 接口。密钥仅保存在本机浏览器，用于房间内 AI 角色调用模型。'
              : '免费代理由 0xNullAI 提供，无需配置 API 密钥即可让房间内 AI 角色直接使用。'}
          </p>
        </div>

        {/* Footer bar */}
        <div className="flex justify-end gap-2 border-t border-[var(--surface-border)] px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-[var(--radius-sm)] px-3 py-1.5 text-sm text-[var(--text-soft)] hover:bg-[var(--bg-soft)]"
          >
            取消
          </button>
          <button
            onClick={save}
            className="rounded-[var(--radius-sm)] bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-[var(--button-text)] hover:opacity-90"
          >
            保存
          </button>
        </div>
      </div>
    </Overlay>
  );
}
