/** One read-only projection. The underlying AI or Chat service remains the authority. */
export interface ConversationView {
  accountId: string;
  conversationId: string;
  kind: 'ai_private' | 'human_dm' | 'human_group';
  title: string;
  items: readonly TimelineItem[];
  composer: readonly ComposerCapability[];
}

export type ComposerCapability =
  | 'text'
  | 'image'
  | 'voice_message'
  | 'camera_observation'
  | 'realtime_voice'
  | 'generate_image'
  | 'generate_video'
  | 'device_control';

export type TimelineItemKind =
  | 'human_message'
  | 'ai_message'
  | 'system_event'
  | 'voice_transcript'
  | 'camera_observation'
  | 'media_job';

export interface TimelineAttachment {
  kind: 'image' | 'voice' | 'video';
  /** Null only for older Chat records that expose a resolved URL without an object ID. */
  objectId: string | null;
  mime: string;
  access: 'account_request' | 'socket_capability' | 'room_authorized_url';
  /** Address is only a route to request; it does not grant authorization by itself. */
  path: string;
  availability: 'ready' | 'requires_connection' | 'unavailable';
  durationMs?: number;
}

export interface TimelineItem {
  conversationId: string;
  itemId: string;
  kind: TimelineItemKind;
  author: { id: string; label: string; source: 'account' | 'person' | 'agent' | 'system' };
  /** A display hint; never the primary ordering key when a server sequence exists. */
  createdAt: number;
  status: 'pending' | 'saved' | 'failed' | 'needs_review';
  body: string;
  attachments: readonly TimelineAttachment[];
  /** Message sequence assigned by the owning server. */
  serverSequence?: number;
  /** Async task/event is inserted after this server sequence. */
  afterSequence?: number;
  /** Stable source order for older records without sequence. */
  sourceIndex: number;
}
