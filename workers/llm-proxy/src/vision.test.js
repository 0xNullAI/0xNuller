import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  CHAT_VISION_MODEL,
  VISION_MAX_RESERVATION_CREDITS,
  VISION_MODEL,
  normalizeVisionResult,
  prepareVisionRequest,
  requestHash,
} from './vision.js';

const jpeg =
  'data:image/jpeg;base64,' +
  Buffer.from([0xff, 0xd8, ...Array(8).fill(0), 0xff, 0xd9]).toString('base64');
const frame = (url = jpeg) => ({
  model: 'vision',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe the frame.' },
        { type: 'image_url', image_url: { url, detail: 'auto' } },
      ],
    },
  ],
});

describe('private managed visual chat request', () => {
  const chat = (messages, extra = {}) => ({ model: 'chat-vision', messages, ...extra });
  const prepareChat = (body) => prepareVisionRequest(body, 'agent', 'private-chat', 'run:chat:001');

  it('shares the priced upstream while retaining a distinct public model id', () => {
    expect(CHAT_VISION_MODEL.id).toBe('chat-vision');
    expect(CHAT_VISION_MODEL.upstreamId).toBe(VISION_MODEL.upstreamId);
  });

  it('keeps role, Memory instructions, tool history and one transient image in the forwarded hash', async () => {
    const messages = [
      { role: 'system', content: 'Character and private Memory' },
      { role: 'user', content: 'How are you?' },
      { role: 'assistant', content: 'I am here.' },
      frame().messages[0],
    ];
    const result = prepareChat(
      chat(messages, { tools: [{ type: 'function', function: { name: 'device_stop' } }] }),
    );
    expect(result.imageBytes).toBe(12);
    expect(result.modelInput.messages).toHaveLength(4);
    expect(result.modelInput.messages[0].content).toBe('Character and private Memory');
    expect(result.modelInput.tools).toHaveLength(1);
    expect(await requestHash(result.modelInput)).not.toBe(
      await requestHash(
        prepareChat(chat([{ ...messages[0], content: 'Changed Memory' }, ...messages.slice(1)]))
          .modelInput,
      ),
    );
  });

  it('supports the no-image tool continuation without replaying the image', () => {
    const result = prepareChat(
      chat([
        { role: 'user', content: 'Stop the device' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call:1', type: 'function', function: { name: 'device_stop', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call:1', content: 'stopped' },
      ]),
    );
    expect(result.imageBytes).toBe(0);
    expect(result.modelInput.messages[1].tool_calls[0].function.name).toBe('device_stop');
  });

  it('rejects video usage, streaming, remote and misplaced images before a hold', () => {
    expect(() =>
      prepareVisionRequest(chat([frame().messages[0]]), 'video', 'private-chat', 'run:chat:001'),
    ).toThrow('usage_kind');
    expect(() => prepareChat(chat([frame().messages[0]], { stream: true }))).toThrow('messages');
    expect(() => prepareChat(chat([frame('https://example.org/image.jpg').messages[0]]))).toThrow(
      'format',
    );
    expect(() =>
      prepareChat(chat([frame().messages[0], { role: 'assistant', content: 'reply' }])),
    ).toThrow('position');
  });
});
const prepare = (body = frame()) =>
  prepareVisionRequest(body, 'video', 'private-chat', 'run:vision:001');

describe('managed visual request', () => {
  it('quotes the full model context and output cap on the server', () => {
    expect(VISION_MODEL.inputCreditsPerMillion).toBe(405);
    expect(VISION_MODEL.outputCreditsPerMillion).toBe(1275);
    expect(VISION_MAX_RESERVATION_CREDITS).toBe(59);
    expect(prepare({ ...frame(), max_tokens: 99999 }).modelInput.max_tokens).toBe(4096);
  });

  it('keeps one bounded transient data frame and hashes the forwarded body', async () => {
    const result = prepare();
    expect(result.imageBytes).toBe(12);
    expect(result.modelInput.messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: jpeg },
    });
    expect(await requestHash(result.modelInput)).toMatch(/^[a-f0-9]{64}$/);
    expect(await requestHash({ ...result.modelInput, max_tokens: 1023 })).not.toBe(
      await requestHash(result.modelInput),
    );
  });

  it('rejects remote, extra, oversized and misplaced frames before reservation', () => {
    expect(() => prepare(frame('https://example.org/frame.jpg'))).toThrow('format');
    const parts = frame().messages[0].content;
    expect(() =>
      prepare({ ...frame(), messages: [{ role: 'user', content: [...parts, parts[1]] }] }),
    ).toThrow('count');
    expect(() =>
      prepare(frame('data:image/jpeg;base64,' + Buffer.alloc(250 * 1024 + 1).toString('base64'))),
    ).toThrow('size');
    expect(() =>
      prepare({ ...frame(), messages: [...frame().messages, { role: 'user', content: 'again' }] }),
    ).toThrow('position');
    expect(() => prepareVisionRequest(frame(), 'agent', 'private-chat', 'run:vision:001')).toThrow(
      'usage_kind',
    );
    expect(() => prepareVisionRequest(frame(), 'video', '', 'run:vision:001')).toThrow(
      'conversation',
    );
  });

  it('normalizes only structured native tool calls, never prose claiming an action', () => {
    const content = normalizeVisionResult({ response: 'I used a tool.', usage: {} });
    expect(content.choices[0].message.tool_calls).toEqual([]);
    const actual = normalizeVisionResult({
      response: '',
      tool_calls: [{ name: 'video_device_control', arguments: { action: 'stop' } }],
      usage: {},
    });
    expect(actual.choices[0].message.tool_calls[0]).toMatchObject({
      type: 'function',
      function: { name: 'video_device_control', arguments: '{"action":"stop"}' },
    });
    expect(
      normalizeVisionResult({
        tool_calls: [{ name: 'video_device_control', arguments: { action: 'stop' } }],
        usage: {},
      }).choices[0].message.content,
    ).toBe('');
    expect(() => normalizeVisionResult({ response: '', tool_calls: [{ name: '' }] })).toThrow();
    expect(() =>
      normalizeVisionResult({ choices: [{ message: { role: 'assistant' } }] }),
    ).toThrow();
  });
});
