export const MEMORY_COLUMNS =
  'id, kind, title, content, version, created_at, updated_at, scope, relationship_id, tier, state, source_conversation_id, source_message_ids, source_refs, expires_at, confidence, superseded_by_id, person_id';
export interface MemoryRow {
  id: string;
  kind: string;
  title: string;
  content: string;
  version: number;
  created_at: number;
  updated_at: number;
  scope: string;
  relationship_id: string | null;
  tier: string;
  state: string;
  source_conversation_id: string | null;
  source_message_ids: string;
  source_refs: string;
  expires_at: number | null;
  confidence: number | null;
  superseded_by_id: string | null;
  person_id: string | null;
}
export function memoryView(row: MemoryRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    scope: row.scope,
    relationshipId: row.relationship_id,
    tier: row.tier,
    state: row.state,
    effectiveState: row.superseded_by_id === null ? row.state : 'superseded',
    sourceConversationId: row.source_conversation_id,
    sourceMessageIds: JSON.parse(row.source_message_ids) as string[],
    sourceRefs: JSON.parse(row.source_refs) as Array<{ conversationId: string; messageId: string }>,
    expiresAt: row.expires_at,
    confidence: row.confidence,
    supersededById: row.superseded_by_id,
    personId: row.person_id,
  };
}
