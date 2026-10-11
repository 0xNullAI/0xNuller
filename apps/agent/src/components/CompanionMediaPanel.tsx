import { useEffect, useRef, useState } from 'react';
import {
  createMediaJob,
  deleteMediaJob,
  listMediaCapabilities,
  listMediaJobs,
  mediaJobBlob,
  type MediaCapability,
  type MediaJob,
  type MediaKind,
} from '@0xnullai/auth';
interface Props {
  accountId: string;
  relationshipId: string;
  conversationId: string;
}
const names = { image: '生成图片', selfie: '情境自拍', video: '角色视频（5秒）' };
export function MediaJobPreview({ job }: { job: MediaJob }) {
  const [url, setUrl] = useState('');
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!requested) return;
    let alive = true;
    let objectUrl = '';
    void mediaJobBlob(job.id)
      .then((blob) => {
        if (alive) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      })
      .catch(() => {
        if (alive) setError('媒体已删除或暂不可用');
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [job.id, requested]);
  if (!requested)
    return (
      <button onClick={() => setRequested(true)} className="text-sm text-violet-300">
        {job.kind === 'video' ? '查看视频' : '查看图片'}
      </button>
    );
  if (error) return <p role="status">{error}</p>;
  if (!url) return <p>加载媒体…</p>;
  return job.kind === 'video' ? (
    <video src={url} controls playsInline className="max-h-80 w-full rounded-lg" />
  ) : (
    <img src={url} alt="AI生成图片" className="max-h-80 rounded-lg object-contain" />
  );
}
export function CompanionMediaPanel(props: Props) {
  return (
    <MediaPanel
      key={`${props.accountId}:${props.relationshipId}:${props.conversationId}`}
      {...props}
    />
  );
}
function MediaPanel({ relationshipId, conversationId }: Props) {
  const [offers, setOffers] = useState<MediaCapability[]>([]);
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [kind, setKind] = useState<MediaKind>('image');
  const [prompt, setPrompt] = useState('');
  const [context, setContext] = useState(false);
  const [characterContext, setCharacterContext] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const pending = useRef<string | null>(null);
  useEffect(() => {
    alive.current = true;
    let stopped = false;
    const refresh = async () => {
      try {
        const [caps, list] = await Promise.all([
          listMediaCapabilities(),
          listMediaJobs(conversationId),
        ]);
        if (!stopped) {
          setOffers(caps.items);
          setJobs(list.items);
        }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : '加载失败');
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      stopped = true;
      alive.current = false;
      clearInterval(timer);
    };
  }, [conversationId]);
  const offer = offers.find((x) => x.kind === kind);
  async function submit() {
    if (!offer?.enabled || !offer.credits || busy) return;
    setBusy(true);
    setError('');
    pending.current ??= crypto.randomUUID();
    try {
      const result = await createMediaJob({
        id: pending.current,
        kind,
        relationshipId,
        conversationId,
        prompt,
        useConversationContext: context,
        useCharacterContext: characterContext,
        acceptedCredits: offer.credits,
        priceVersion: offer.priceVersion,
      });
      if (alive.current) {
        setJobs((old) => [result.item, ...old.filter((x) => x.id !== result.item.id)]);
        window.dispatchEvent(
          new CustomEvent('0xnullai:media-jobs-changed', { detail: { conversationId } }),
        );
        pending.current = null;
        setPrompt('');
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : '提交失败');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    try {
      await deleteMediaJob(id);
      if (alive.current) {
        setJobs((old) => old.filter((x) => x.id !== id));
        window.dispatchEvent(
          new CustomEvent('0xnullai:media-jobs-changed', { detail: { conversationId } }),
        );
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="space-y-3 rounded-xl border border-white/10 p-3">
      <h3 className="font-medium">角色图片与视频</h3>
      <p className="text-xs text-gray-400">使用 Credit 生成，图片保存到你的私有相册。</p>
      <select
        aria-label="媒体类型"
        value={kind}
        disabled={busy}
        onChange={(e) => {
          setKind(e.target.value as MediaKind);
          pending.current = null;
        }}
        className="w-full rounded bg-zinc-900 p-2"
      >
        {Object.entries(names).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <textarea
        aria-label="画面描述"
        value={prompt}
        maxLength={1000}
        disabled={busy}
        placeholder="描述角色外观、场景和动作"
        onChange={(e) => {
          setPrompt(e.target.value);
          pending.current = null;
        }}
        className="w-full rounded bg-zinc-900 p-2"
      />
      <label className="flex gap-2 text-xs">
        <input
          type="checkbox"
          checked={characterContext}
          disabled={busy}
          onChange={(e) => {
            setCharacterContext(e.target.checked);
            pending.current = null;
          }}
        />
        将我的角色卡和当前场景设定发送给 MiniMax（不含私人记忆）
      </label>
      <label className="flex gap-2 text-xs">
        <input
          type="checkbox"
          checked={context}
          disabled={busy}
          onChange={(e) => {
            setContext(e.target.checked);
            pending.current = null;
          }}
        />
        将此会话最近4条消息作为场景参考发送给 MiniMax
      </label>
      <p className="text-xs">
        {offer?.enabled
          ? `本次预留 ${offer.credits} Credit，保存并确认账务后扣费；异常待核对。`
          : (offer?.reason ?? '正在读取可用能力…')}
      </p>
      <button
        disabled={busy || !offer?.enabled || !prompt.trim()}
        onClick={() => void submit()}
        className="rounded bg-violet-600 px-3 py-2 disabled:opacity-40"
      >
        {busy ? '处理中…' : '确认生成'}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <ul className="space-y-3">
        {jobs.map((job) => (
          <li key={job.id} className="space-y-2 border-t border-white/10 pt-2">
            <p className="text-sm">
              {names[job.kind]} ·{' '}
              {job.state === 'succeeded'
                ? '已完成'
                : job.state === 'needs_review'
                  ? '账务待核对'
                  : job.state === 'failed'
                    ? '失败'
                    : job.state === 'submission_unknown'
                      ? '结果不明，未扣费'
                      : job.state === 'deleting'
                        ? '删除中'
                        : '后台处理中'}
            </p>
            {job.state === 'succeeded' && <MediaJobPreview job={job} />}
            <p className="text-xs text-gray-400">{job.lastError ?? job.prompt}</p>
            {!['submitting', 'processing', 'storing', 'needs_review'].includes(job.state) && (
              <button
                disabled={busy}
                onClick={() => void remove(job.id)}
                className="text-xs text-gray-400"
              >
                删除
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
