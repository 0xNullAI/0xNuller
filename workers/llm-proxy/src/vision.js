// Cloudflare's Llama 4 Scout catalog (2026-09) lists a 131k context and
// $0.27/$0.85 per million input/output tokens. The product converts USD to
// Credit at 1,500 Credit per USD. The full context plus the 4,096 output cap
// costs at most 59 Credit per camera observation. Auth independently enforces
// this exact hold so a client cannot lower it.
export const VISION_MODEL = Object.freeze({
  id: 'vision',
  name: '视觉',
  description: '摄像头画面理解与设备互动',
  upstreamId: '@cf/meta/llama-4-scout-17b-16e-instruct',
  inputCreditsPerMillion: 405,
  cachedInputCreditsPerMillion: 405,
  outputCreditsPerMillion: 1275,
  imageInput: true,
});
/** Private character chat uses the same priced model, but a different request contract. */
export const CHAT_VISION_MODEL = Object.freeze({
  ...VISION_MODEL,
  id: 'chat-vision',
  name: '看图聊天',
  description: '角色聊天中的单张图片理解',
});
export const VISION_CONTEXT_TOKENS = 131_000;
export const VISION_MAX_OUTPUT_TOKENS = 4_096;
export const VISION_MAX_FRAME_BYTES = 250 * 1024;
export const VISION_MAX_RESERVATION_CREDITS = Math.ceil(
  (VISION_CONTEXT_TOKENS * VISION_MODEL.inputCreditsPerMillion +
    VISION_MAX_OUTPUT_TOKENS * VISION_MODEL.outputCreditsPerMillion) /
    1_000_000,
);

/** Reject remote images, extra frames, and unbounded payloads before any hold. */
export function prepareVisionRequest(body, usageKind, conversationId, runId) {
  const chat = body.model === 'chat-vision';
  if (usageKind !== (chat ? 'agent' : 'video')) throw new Error('vision_usage_kind_invalid');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(conversationId ?? ''))
    throw new Error('vision_conversation_required');
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(runId ?? '')) throw new Error('vision_run_required');
  if (
    body.stream ||
    !Array.isArray(body.messages) ||
    body.messages.length < 1 ||
    body.messages.length > (chat ? 128 : 2)
  )
    throw new Error('vision_messages_invalid');
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 8))
    throw new Error('vision_tools_invalid');
  let imageBytes = 0;
  const messages = body.messages.map((message, index) => {
    if (
      !message ||
      !(chat ? ['system', 'user', 'assistant', 'tool'] : ['system', 'user']).includes(message.role)
    )
      throw new Error('vision_message_role_invalid');
    if (
      chat &&
      (typeof message.content === 'string' ||
        (message.role === 'assistant' &&
          message.content === null &&
          Array.isArray(message.tool_calls)))
    ) {
      if (typeof message.content === 'string' && message.content.length > 32_000)
        throw new Error('vision_content_invalid');
      const normalized = { role: message.role, content: message.content };
      if (message.role === 'tool') {
        if (
          typeof message.tool_call_id !== 'string' ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(message.tool_call_id)
        )
          throw new Error('vision_tool_call_invalid');
        normalized.tool_call_id = message.tool_call_id;
      } else if (message.tool_call_id !== undefined) throw new Error('vision_tool_call_invalid');
      if (message.tool_calls !== undefined) {
        if (
          message.role !== 'assistant' ||
          !Array.isArray(message.tool_calls) ||
          message.tool_calls.length > 8
        )
          throw new Error('vision_tool_call_invalid');
        normalized.tool_calls = message.tool_calls.map((call) => {
          if (
            call?.type !== 'function' ||
            typeof call.id !== 'string' ||
            !/^[A-Za-z0-9._:-]{1,128}$/.test(call.id) ||
            typeof call.function?.name !== 'string' ||
            !/^[A-Za-z0-9_]{1,128}$/.test(call.function.name) ||
            typeof call.function?.arguments !== 'string' ||
            call.function.arguments.length > 32_000
          )
            throw new Error('vision_tool_call_invalid');
          try {
            JSON.parse(call.function.arguments);
          } catch {
            throw new Error('vision_tool_call_invalid');
          }
          return {
            id: call.id,
            type: 'function',
            function: { name: call.function.name, arguments: call.function.arguments },
          };
        });
      }
      return normalized;
    }
    if (!Array.isArray(message.content)) {
      if (
        index !== 0 ||
        body.messages.length !== 2 ||
        message.role !== 'system' ||
        typeof message.content !== 'string'
      )
        throw new Error('vision_content_invalid');
      return { role: 'system', content: message.content };
    }
    if (index !== body.messages.length - 1 || message.role !== 'user' || imageBytes !== 0)
      throw new Error('vision_frame_position_invalid');
    if (message.content.length !== 2) throw new Error('vision_frame_count_invalid');
    const text = message.content.find((part) => part?.type === 'text');
    const image = message.content.find((part) => part?.type === 'image_url');
    if (
      typeof text?.text !== 'string' ||
      (chat && text.text.length > 32_000) ||
      !image?.image_url ||
      typeof image.image_url.url !== 'string'
    )
      throw new Error('vision_frame_content_invalid');
    const match = /^data:image\/(jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.image_url.url);
    if (!match) throw new Error('vision_frame_format_invalid');
    const bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0));
    if (bytes.length < 12 || bytes.length > VISION_MAX_FRAME_BYTES)
      throw new Error('vision_frame_size_invalid');
    if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9))
      throw new Error('vision_frame_format_invalid');
    imageBytes = bytes.length;
    return {
      role: 'user',
      content: [
        { type: 'text', text: text.text },
        { type: 'image_url', image_url: { url: image.image_url.url } },
      ],
    };
  });
  if (!chat && !imageBytes) throw new Error('vision_frame_required');
  if (chat && messages.at(-1)?.role === 'system') throw new Error('vision_messages_invalid');
  const maxTokens = Math.min(
    Math.max(Math.trunc(Number(body.max_tokens) || 1024), 1),
    VISION_MAX_OUTPUT_TOKENS,
  );
  return {
    imageBytes,
    modelInput: {
      messages,
      ...(body.tools ? { tools: body.tools } : {}),
      ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
      ...(Number.isFinite(body.temperature) && body.temperature >= 0 && body.temperature <= 2
        ? { temperature: body.temperature }
        : {}),
      max_tokens: maxTokens,
    },
  };
}

export async function requestHash(modelInput) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(modelInput)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The binding can return its native response/tool_calls form instead of choices. */
export function normalizeVisionResult(payload) {
  if (Array.isArray(payload?.choices) && payload.choices.length > 0) {
    const message = payload.choices[0]?.message;
    if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls)))
      throw new Error('vision_result_invalid');
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of calls) {
      if (
        !call ||
        call.type !== 'function' ||
        typeof call.function?.name !== 'string' ||
        !call.function.name.trim() ||
        typeof call.function.arguments !== 'string'
      )
        throw new Error('vision_tool_call_invalid');
      JSON.parse(call.function.arguments);
    }
    if ((typeof message.content !== 'string' || !message.content.trim()) && calls.length === 0)
      throw new Error('vision_result_empty');
    return payload;
  }
  if (!payload || (typeof payload.response !== 'string' && !Array.isArray(payload.tool_calls)))
    throw new Error('vision_result_invalid');
  const toolCalls = Array.isArray(payload.tool_calls)
    ? payload.tool_calls.map((call) => {
        if (!call || typeof call.name !== 'string' || !call.name.trim())
          throw new Error('vision_tool_call_invalid');
        const args =
          typeof call.arguments === 'string'
            ? call.arguments
            : JSON.stringify(call.arguments ?? {});
        JSON.parse(args);
        return {
          id: crypto.randomUUID(),
          type: 'function',
          function: { name: call.name, arguments: args },
        };
      })
    : [];
  if ((typeof payload.response !== 'string' || !payload.response.trim()) && toolCalls.length === 0)
    throw new Error('vision_result_empty');
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: typeof payload.response === 'string' ? payload.response : '',
          tool_calls: toolCalls,
        },
      },
    ],
    usage: payload.usage,
  };
}
