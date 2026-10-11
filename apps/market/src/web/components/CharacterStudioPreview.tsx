import { currentAuthUserId, subscribeAuthChanges } from '@0xnullai/auth';
import { Button, registerNavigationGuard } from '@0xnullai/ui';
import { useEffect, useRef, useState } from 'react';
import {
  previewCatalog,
  previewTurn,
  type PreviewSnapshot,
  type PreviewMessage,
} from '../character-preview';

/** Mount keyed by the complete draft fingerprint: edits revoke the old request and transcript. */
export function CharacterStudioPreview({ snapshot }: { snapshot: PreviewSnapshot }) {
  const [open, setOpen] = useState(false);
  const [owner] = useState(currentAuthUserId);
  const [revoked, setRevoked] = useState(false);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof previewCatalog>> | null>(null);
  const [model, setModel] = useState('');
  const [messages, setMessages] = useState<PreviewMessage[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [charged, setCharged] = useState<number | null>(null);
  const request = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const stop = () => {
    request.current?.abort();
    request.current = null;
    setBusy(false);
  };
  useEffect(() => {
    alive.current = true;
    const unsubscribe = subscribeAuthChanges(() => {
      if (currentAuthUserId() !== owner) {
        stop();
        setRevoked(true);
        setMessages([]);
        setCatalog(null);
      }
    });
    const guard = registerNavigationGuard((destination) => {
      if (destination.pathname !== '/market') stop();
      return null;
    });
    const hidden = () => {
      if (document.hidden) stop();
    };
    window.addEventListener('pagehide', stop);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      alive.current = false;
      request.current?.abort();
      unsubscribe();
      guard();
      window.removeEventListener('pagehide', stop);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [owner]);
  const load = async () => {
    if (!owner || revoked) return;
    stop();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await previewCatalog(owner, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setCatalog(result);
      setModel((previous) =>
        result.models.some((item) => item.id === previous) ? previous : result.models[0]!.id,
      );
    } catch (reason) {
      if (alive.current && !controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : '无法读取价格');
    } finally {
      if (alive.current && request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  };
  const send = async () => {
    if (!owner || revoked || busy || !catalog || !input.trim()) return;
    const controller = new AbortController();
    request.current = controller;
    const outgoing: PreviewMessage[] = [...messages, { role: 'user', content: input.trim() }];
    setBusy(true);
    setError('');
    setCharged(null);
    try {
      const result = await previewTurn(snapshot, outgoing, model, owner, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setMessages([...outgoing, { role: 'assistant', content: result.text }]);
      setInput('');
      setCharged(result.charged);
      // Refresh authoritative balance; failure does not erase an already settled reply.
      try {
        const refreshed = await previewCatalog(owner, controller.signal);
        if (alive.current && !controller.signal.aborted) setCatalog(refreshed);
      } catch {
        if (alive.current && !controller.signal.aborted) {
          setCatalog(null);
          setError('回复已完成，余额刷新失败；请刷新价格后继续');
        }
      }
    } catch (reason) {
      if (alive.current && !controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : '试聊失败');
    } finally {
      if (alive.current && request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  };
  const price = catalog?.models.find((item) => item.id === model);
  return (
    <section
      className="space-y-3 rounded-xl border border-[var(--surface-border)] p-3"
      aria-label="草稿试聊"
    >
      <Button
        variant="secondary"
        onClick={() => {
          if (open) {
            stop();
            setMessages([]);
            setInput('');
          } else void load();
          setOpen(!open);
        }}
      >
        {' '}
        {open ? '关闭试聊' : '试聊当前草稿'}{' '}
      </Button>
      {open && (
        <>
          <p className="text-sm">
            使用当前未发布人设的真实托管文字模型，每次发送可能扣
            Credit。取消后已产生的用量仍可能收费，记录归现有文本 / Agent 用量。最多 6 轮、每次最多
            512 输出 Token。
          </p>
          <p className="text-xs">
            没有工具、设备或私人记忆；试聊不保存为正式聊天或关系，不增加公开浏览/下载计数。修改草稿、关闭试聊会清空试聊记录。
          </p>
          {!owner || revoked ? (
            <p role="status">请登录并重新打开编辑器后试聊。</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {catalog && (
                  <label>
                    模型{' '}
                    <select
                      aria-label="试聊模型"
                      value={model}
                      disabled={busy}
                      onChange={(event) => {
                        setModel(event.target.value);
                        setMessages([]);
                        setCharged(null);
                      }}
                    >
                      {catalog.models.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>
                  刷新价格与余额
                </Button>
              </div>
              {price && (
                <p className="text-xs">
                  当前可用 {catalog!.credit.available} Credit；每百万 Token 输入{' '}
                  {price.inputCreditsPerMillion} / 输出 {price.outputCreditsPerMillion}{' '}
                  Credit。价格版本 {price.priceVersion}，最终按服务端实际用量结算。
                </p>
              )}
              <div
                role="log"
                aria-label="试聊消息"
                className="max-h-80 space-y-3 overflow-y-auto break-words"
              >
                {messages.map((message, index) => (
                  <p key={index} className="whitespace-pre-wrap text-sm">
                    <strong>{message.role === 'user' ? '你' : snapshot.name}：</strong>
                    {message.content}
                  </p>
                ))}
              </div>
              {charged !== null && <p role="status">本次已结算 {charged} Credit</p>}
              <label className="block">
                试聊消息
                <textarea
                  aria-label="试聊输入"
                  className="block w-full rounded-lg border p-2"
                  value={input}
                  maxLength={4000}
                  disabled={busy}
                  onChange={(event) => setInput(event.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || !catalog || !input.trim() || messages.length >= 12}
                  onClick={() => void send()}
                >
                  发送并使用 Credit
                </Button>
                {busy && (
                  <Button variant="secondary" onClick={stop}>
                    停止试聊
                  </Button>
                )}
                <Button
                  variant="ghost"
                  onClick={() => {
                    stop();
                    setMessages([]);
                    setCharged(null);
                    setError('');
                  }}
                >
                  重新开始
                </Button>
              </div>
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
