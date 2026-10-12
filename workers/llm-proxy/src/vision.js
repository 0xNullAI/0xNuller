import { outputCap, sha256Hex } from './ark.js';

const VISION_MAX_FRAME_BYTES = 250 * 1024;

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
  // Chat turns carry the companion's full tool set (device, memory, scene); camera turns fewer.
  if (
    body.tools !== undefined &&
    (!Array.isArray(body.tools) || body.tools.length > (chat ? 16 : 8))
  )
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
  const maxTokens = outputCap(body);
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

export function requestHash(modelInput) {
  return sha256Hex(JSON.stringify(modelInput));
}

/** Only a structured reply or valid structured tool calls is a usable observation. */
export function normalizeVisionResult(payload) {
  const message = Array.isArray(payload?.choices) ? payload.choices[0]?.message : undefined;
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
