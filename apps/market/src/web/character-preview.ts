import {
  authRequestHeaders,
  currentAuthUserId,
  subscribeAuthChanges,
  type CreditBalance,
} from '@0xnullai/auth';
import { MANAGED_SERVICE_URL } from '@0xnullai/llm-providers';
import {
  characterCardContext,
  parseCharacterCard,
  type CharacterCard,
} from '@0xnullai/scenes/character-card';
export interface PreviewModel {
  id: string;
  name: string;
  inputCreditsPerMillion: number;
  outputCreditsPerMillion: number;
  priceVersion: string;
}
export interface PreviewMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface PreviewSnapshot {
  name: string;
  prompt: string;
  card: CharacterCard;
}
async function request(
  path: string,
  owner: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<Record<string, unknown>> {
  if (currentAuthUserId() !== owner || signal.aborted) throw new Error('试聊已停止或账户已切换');
  const controller = new AbortController();
  let revoked = false;
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const unsubscribe = subscribeAuthChanges(() => {
    if (currentAuthUserId() !== owner) {
      revoked = true;
      controller.abort();
    }
  });
  try {
    const response = await fetch(`${MANAGED_SERVICE_URL}${path}`, {
      method: body ? 'POST' : 'GET',
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        ...authRequestHeaders(),
        ...(body
          ? { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await response.json()) as Record<string, unknown>;
    if (revoked || signal.aborted || currentAuthUserId() !== owner)
      throw new Error('试聊已停止或账户已切换');
    if (!response.ok)
      throw new Error(
        `${typeof data.error === 'string' ? data.error : '试聊请求失败'}${data.billing_status ? `（结算状态：${String(data.billing_status)}）` : ''}`,
      );
    return data;
  } finally {
    unsubscribe();
    signal.removeEventListener('abort', abort);
  }
}
export async function previewCatalog(
  owner: string,
  signal: AbortSignal,
): Promise<{ models: PreviewModel[]; credit: CreditBalance }> {
  const data = await request('/v1/models', owner, signal);
  if (
    !Array.isArray(data.data) ||
    !data.credit ||
    typeof data.credit !== 'object' ||
    !Number.isFinite((data.credit as CreditBalance).available)
  )
    throw new Error('模型价格或余额暂不可用');
  const models = data.data.filter(
    (model): model is PreviewModel =>
      model &&
      typeof model.id === 'string' &&
      typeof model.name === 'string' &&
      typeof model.priceVersion === 'string' &&
      Number.isFinite(model.inputCreditsPerMillion) &&
      model.inputCreditsPerMillion >= 0 &&
      Number.isFinite(model.outputCreditsPerMillion) &&
      model.outputCreditsPerMillion >= 0,
  );
  if (!models.length) throw new Error('没有可用的托管文字模型');
  return { models, credit: data.credit as CreditBalance };
}
export async function previewTurn(
  snapshot: PreviewSnapshot,
  messages: PreviewMessage[],
  model: string,
  owner: string,
  signal: AbortSignal,
): Promise<{ text: string; charged: number }> {
  const card = parseCharacterCard(snapshot.card);
  if (!card) throw new Error('详细设定无效或超出限制，请修正后再试聊；未发起收费请求');
  if (!snapshot.name.trim() || !snapshot.prompt.trim())
    throw new Error('请先填写名称和基础 Prompt');
  if (
    snapshot.prompt.length > 32000 ||
    messages.length > 12 ||
    messages.some((message) => message.content.length > 4000)
  )
    throw new Error(
      '试聊仅支持 32000 字以内 Prompt、每条 4000 字及最多 6 轮，请缩短设定或重新开始',
    );
  const data = await request('/v1/chat/completions', owner, signal, {
    model,
    stream: false,
    max_tokens: 512,
    messages: [
      {
        role: 'system',
        content: `这是公开 Prompt 卡草稿的纯文字试聊。没有设备、工具或私人记忆。\n卡片名称：${snapshot.name}\n${snapshot.prompt}\n${characterCardContext(card)}`,
      },
      ...messages.map(({ role, content }) => ({ role, content })),
    ],
  });
  const choices = data.choices as { message?: { content?: unknown } }[] | undefined;
  const text = choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim())
    throw new Error('模型未返回文字，请检查账本确认本次用量');
  if (typeof data.credit_charged !== 'number' || !Number.isFinite(data.credit_charged))
    throw new Error('结算结果尚未确认，请检查账本');
  return { text, charged: data.credit_charged };
}
