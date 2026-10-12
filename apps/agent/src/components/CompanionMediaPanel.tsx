import { useEffect, useRef, useState } from 'react';
import {
  createMediaJob,
  deleteMediaJob,
  listMediaCapabilities,
  listMediaJobs,
  mediaJobBlob,
  type MediaCapability,
  type MediaJob,
} from '@0xnullai/auth';
interface Props {
  accountId: string;
  relationshipId: string;
  conversationId: string;
}
/** Old `selfie` and `video` jobs stay visible in history; only images are offered. */
export const mediaKindName = { image: '生成图片', selfie: '情境自拍', video: '角色视频' };
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
      <button onClick={() => setRequested(true)} className="text-sm text-[var(--accent-text)]">
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
  const [prompt, setPrompt] = useState('');
  const [featureCharacter, setFeatureCharacter] = useState(false);
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
  const offer = offers.find((x) => x.kind === 'image');
  async function submit() {
    if (!offer?.enabled || !offer.credits || busy) return;
    setBusy(true);
    setError('');
    pending.current ??= crypto.randomUUID();
    try {
      const result = await createMediaJob({
        id: pending.current,
        kind: 'image',
        relationshipId,
        conversationId,
        prompt,
        featureCharacter,
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
      <h3 className="font-medium">生成图片</h3>
      <p className="text-xs text-[var(--text-faint)]">使用 Credit 生成，图片保存到你的私有相册。</p>
      <textarea
        aria-label="画面描述"
        value={prompt}
        maxLength={1000}
        disabled={busy}
        placeholder="描述画面、场景和动作"
        onChange={(e) => {
          setPrompt(e.target.value);
          pending.current = null;
        }}
        className="w-full rounded-[var(--radius-ctl)] border border-[var(--surface-border)] bg-[var(--bg-strong)] p-2"
      />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          role="switch"
          checked={featureCharacter}
          disabled={busy}
          onChange={(e) => {
            setFeatureCharacter(e.target.checked);
            pending.current = null;
          }}
        />
        让角色出镜
      </label>
      {featureCharacter && (
        <p className="text-xs text-[var(--text-faint)]">
          将角色形象图、角色卡、当前场景和最近4条消息发送给火山引擎（不含私人记忆）；没有形象图时只用文字描述。
        </p>
      )}
      <p className="text-xs">
        {offer?.enabled
          ? `本次预留 ${offer.credits} Credit，保存并确认账务后扣费；异常待核对。`
          : (offer?.reason ?? '正在读取可用能力…')}
      </p>
      <button
        disabled={busy || !offer?.enabled || !prompt.trim()}
        onClick={() => void submit()}
        className="rounded-[var(--radius-ctl)] bg-[var(--accent)] px-3 py-2 font-medium text-[var(--button-text)] disabled:opacity-40"
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
              {mediaKindName[job.kind]} ·{' '}
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
            <p className="text-xs text-[var(--text-faint)]">{job.lastError ?? job.prompt}</p>
            {!['submitting', 'processing', 'storing', 'needs_review'].includes(job.state) && (
              <button
                disabled={busy}
                onClick={() => void remove(job.id)}
                className="text-xs text-[var(--text-faint)]"
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
