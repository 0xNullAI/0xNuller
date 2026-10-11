import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId, subscribeAuthChanges } from './index';

export interface PrivateConversationAttachment {
  id: string;
  messageId: string;
  kind: 'image' | 'voice';
  mime: string;
  size: number;
  createdAt: number;
  contentUrl: string;
  /** User-authored text accompanying a voice clip; never an ASR claim. */
  caption?: string | null;
}

export interface VoiceTranscription {
  enabled: boolean;
  offer: { rate: number; maxCredits: number; priceVersion: string } | null;
  job: {
    state: 'running' | 'settlement_pending' | 'succeeded' | 'failed' | 'needs_review';
    credits: number | null;
    transcript: string | null;
    seconds: number | null;
  } | null;
}

/** A single account/conversation-bound handle; a logout invalidates even A→B→A. */
export class PrivateConversationAttachmentChannel {
  private valid = true;
  private readonly unsubscribe: () => void;
  readonly accountId: string;
  readonly conversationId: string;

  constructor(accountId: string, conversationId: string) {
    this.accountId = accountId;
    this.conversationId = conversationId;
    this.unsubscribe = subscribeAuthChanges(() => {
      if (currentAuthUserId() !== accountId) this.valid = false;
    });
  }

  dispose(): void {
    this.valid = false;
    this.unsubscribe();
  }

  private assertCurrent(): void {
    if (!this.valid || currentAuthUserId() !== this.accountId)
      throw new Error('账号已切换，请重新打开会话。');
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    this.assertCurrent();
    const response = await fetch(
      `${apiBaseUrl()}/api/auth/conversations/${encodeURIComponent(this.conversationId)}/attachments${path}`,
      {
        ...init,
        credentials: 'include',
        cache: 'no-store',
        headers: { ...authRequestHeaders(), 'X-Account-Id': this.accountId, ...init?.headers },
      },
    );
    this.assertCurrent();
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      this.assertCurrent();
      throw new Error(body.error ?? '附件服务暂不可用，请重试。');
    }
    return response;
  }

  async list(): Promise<PrivateConversationAttachment[]> {
    const response = await this.request('');
    const body = (await response.json()) as { items: PrivateConversationAttachment[] };
    this.assertCurrent();
    return body.items;
  }

  async upload(file: Blob, caption = ''): Promise<PrivateConversationAttachment> {
    const stagedResponse = await this.request('', {
      method: 'POST',
      headers: { 'content-type': file.type },
      body: file,
    });
    const staged = (await stagedResponse.json()) as { attachment: PrivateConversationAttachment };
    this.assertCurrent();
    const response = await this.request(`/${encodeURIComponent(staged.attachment.id)}/commit`, {
      method: 'POST',
      ...(caption.trim()
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ caption: caption.trim() }),
          }
        : {}),
    });
    const body = (await response.json()) as { attachment: PrivateConversationAttachment };
    this.assertCurrent();
    if (typeof window !== 'undefined')
      window.dispatchEvent(new Event('0xnullai:conversation-updated'));
    return body.attachment;
  }

  async read(attachment: PrivateConversationAttachment): Promise<Blob> {
    const response = await this.request(`/${encodeURIComponent(attachment.id)}/content`);
    const blob = await response.blob();
    this.assertCurrent();
    return blob;
  }

  async transcription(attachmentId: string): Promise<VoiceTranscription> {
    const response = await this.request(`/${encodeURIComponent(attachmentId)}/transcription`);
    const body = (await response.json()) as VoiceTranscription;
    this.assertCurrent();
    return body;
  }

  async transcribe(
    attachmentId: string,
    offer: NonNullable<VoiceTranscription['offer']>,
  ): Promise<VoiceTranscription['job']> {
    const response = await this.request(`/${encodeURIComponent(attachmentId)}/transcription`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        consent: true,
        acceptedMaxCredits: offer.maxCredits,
        priceVersion: offer.priceVersion,
      }),
    });
    const body = (await response.json()) as { job: VoiceTranscription['job'] };
    this.assertCurrent();
    return body.job;
  }
}
