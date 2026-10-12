import type { LlmImageInput } from '@dg-agent/core';
import {
  PrivateConversationAttachmentChannel,
  type PrivateConversationAttachment,
} from '@0xnullai/auth';

const MAX_SOURCE_BYTES = 8_000_000;
const MAX_MODEL_BYTES = 250 * 1024;
const MAX_EDGE = 768;

/** Managed chat sends the chosen image through its chat-vision binding; own APIs need image input on. */
export function canUsePrivateImageInput(imageInput: boolean, providerId: string): boolean {
  return providerId === 'managed' || imageInput;
}

/** Read a server-authorized attachment and prepare one ephemeral vision input. */
export async function readPrivateImageForModel(
  accountId: string,
  conversationId: string,
  attachment: PrivateConversationAttachment,
): Promise<LlmImageInput> {
  if (
    attachment.kind !== 'image' ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(attachment.mime) ||
    attachment.size < 1 ||
    attachment.size > MAX_SOURCE_BYTES
  ) {
    throw new Error('此附件不能用于图片理解');
  }
  const channel = new PrivateConversationAttachmentChannel(accountId, conversationId);
  try {
    const source = await channel.read(attachment);
    if (
      source.size !== attachment.size ||
      source.size > MAX_SOURCE_BYTES ||
      source.type !== attachment.mime
    ) {
      throw new Error('图片内容与附件记录不一致');
    }
    if (typeof createImageBitmap !== 'function') throw new Error('当前浏览器无法处理图片');
    const bitmap = await createImageBitmap(source);
    try {
      if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 4096 || bitmap.height > 4096)
        throw new Error('图片尺寸不符合视觉输入限制');
      const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('当前浏览器无法处理图片');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const ratio of [1, 0.85, 0.7, 0.55]) {
        const output = document.createElement('canvas');
        output.width = Math.max(1, Math.round(canvas.width * ratio));
        output.height = Math.max(1, Math.round(canvas.height * ratio));
        const outputContext = output.getContext('2d', { alpha: false });
        if (!outputContext) throw new Error('当前浏览器无法处理图片');
        outputContext.drawImage(canvas, 0, 0, output.width, output.height);
        for (const quality of [0.82, 0.68, 0.54, 0.4]) {
          const blob = await new Promise<Blob>((resolve, reject) =>
            output.toBlob(
              (value) => (value ? resolve(value) : reject(new Error('图片压缩失败'))),
              'image/jpeg',
              quality,
            ),
          );
          if (blob.type !== 'image/jpeg' || blob.size > MAX_MODEL_BYTES) continue;
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 0x8000)
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
          return {
            mediaType: 'image/jpeg',
            data: btoa(binary),
            width: output.width,
            height: output.height,
            byteLength: blob.size,
          };
        }
      }
      throw new Error('图片压缩后仍超过 250KB，请使用较简单的图片');
    } finally {
      bitmap.close();
    }
  } finally {
    channel.dispose();
  }
}
