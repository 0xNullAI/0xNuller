import { parsePriceTable, tokenReservation } from '@0xnullai/ai-pricing';
import { MAX_OUTPUT_TOKENS } from './ark.js';

/**
 * Public managed model ids. Every text id shares one priced route (`table.chat`); older clients
 * that still send a former tier keep working. Image-bearing requests use `table.vision`.
 * Auth records these ids on the reservation, so they must stay stable.
 */
export const TEXT_MODEL_IDS = ['basic', 'balanced', 'powerful'];
export const VISION_MODEL_IDS = ['vision', 'chat-vision'];
export const DEFAULT_MODEL_ID = 'balanced';

/**
 * Reservation allowance for one image. Ark does not report image tokens before the call, so a
 * frame is held at a conservative fixed token count; settlement uses the real usage.
 */
export const IMAGE_INPUT_TOKEN_ALLOWANCE = 16_384;
/** Upper bound on an image request's estimated input, so the published quote is a true maximum. */
export const VISION_MAX_INPUT_TOKENS = 131_072;

let cachedRaw;
let cachedTable = null;

/** The price table and upstream credential, or null when managed models must stay off. */
export function managedConfig(env) {
  if (env.AI_PRICE_TABLE !== cachedRaw) {
    cachedRaw = env.AI_PRICE_TABLE;
    cachedTable = parsePriceTable(cachedRaw);
  }
  if (!cachedTable || typeof env.VOLC_ARK_API_KEY !== 'string' || !env.VOLC_ARK_API_KEY.trim())
    return null;
  return { table: cachedTable };
}

export function isManagedModel(id) {
  return TEXT_MODEL_IDS.includes(id) || VISION_MODEL_IDS.includes(id);
}

/**
 * UTF-8 bytes are a deliberately conservative tokenizer-independent upper bound for text. Image
 * data URLs are replaced by a fixed allowance instead of being counted byte by byte.
 */
export function estimateInputTokens(input) {
  let images = 0;
  const messages = (input.messages ?? []).map((message) =>
    Array.isArray(message?.content)
      ? {
          ...message,
          content: message.content.map((part) => {
            if (part?.type !== 'image_url') return part;
            images += 1;
            return { type: 'image_url' };
          }),
        }
      : message,
  );
  const text = JSON.stringify({
    messages,
    tools: input.tools,
    tool_choice: input.tool_choice,
    response_format: input.response_format,
  });
  return Math.max(
    1,
    new TextEncoder().encode(text).byteLength + images * IMAGE_INPUT_TOKEN_ALLOWANCE,
  );
}

/** Largest hold one camera observation can take; shown to Video before it starts. */
export function visionQuote(table) {
  return tokenReservation(table.vision, VISION_MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS);
}

function publicPrices(route, version) {
  return {
    inputCreditsPerMillion: route.inputPerMillion,
    cachedInputCreditsPerMillion: route.cachedInputPerMillion,
    outputCreditsPerMillion: route.outputPerMillion,
    priceVersion: version,
  };
}

/** `/v1/models`: one text model plus the camera protocol(s). Upstream ids are never exposed. */
export function publicCatalog(table, env) {
  const vision = { ...publicPrices(table.vision, table.version), imageInput: true };
  const maxReservationCredits = visionQuote(table);
  return [
    {
      id: DEFAULT_MODEL_ID,
      object: 'model',
      name: '猫愿模型',
      description: '日常聊天、角色扮演与设备互动',
      ...publicPrices(table.chat, table.version),
      imageInput: false,
    },
    {
      id: 'vision',
      object: 'model',
      name: '视觉',
      description: '摄像头画面理解与设备互动',
      ...vision,
      maxReservationCredits,
    },
    ...(env.ENABLE_CHAT_VISION === 'true'
      ? [
          {
            id: 'chat-vision',
            object: 'model',
            name: '看图聊天',
            description: '角色聊天中的单张图片理解',
            ...vision,
            maxReservationCredits,
          },
        ]
      : []),
  ];
}
