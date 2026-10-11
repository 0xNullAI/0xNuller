import { useEffect, useState } from 'react';
import {
  listCharacterRelationships,
  saveCharacterRelationship,
  type CharacterRelationship,
} from '@0xnullai/auth';
import { SettingSelect } from '@0xnullai/ui';
import { useProviderVoices } from '@voice/hooks/use-provider-voices';
import {
  getRealtimeProviderDefinition,
  relationshipVoiceFor,
  type RealtimeProviderId,
} from '@voice/lib/realtime/providers';

const DEFAULT = '__default__';

/**
 * The voice this AI speaks with, saved on the account's private relationship.
 * "跟随默认" uses the voice chosen under 我的 → AI. A saved voice the active
 * provider cannot speak is shown as the default, since the call will use it.
 */
export function CharacterVoiceField({
  characterId,
  providerId,
  apiKey,
}: {
  characterId: string;
  providerId: RealtimeProviderId;
  apiKey: string;
}) {
  const definition = getRealtimeProviderDefinition(providerId);
  const { voices } = useProviderVoices(providerId, apiKey, definition?.staticVoices ?? []);
  // Keyed by character so switching chats never shows the previous AI's voice.
  const [loaded, setLoaded] = useState<{
    characterId: string;
    relationship: CharacterRelationship | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const relationship = loaded?.characterId === characterId ? loaded.relationship : null;
  const setRelationship = (next: CharacterRelationship | null) =>
    setLoaded({ characterId, relationship: next });

  useEffect(() => {
    if (!characterId) return;
    let active = true;
    void listCharacterRelationships(characterId)
      .then(({ items }) => {
        if (active) setLoaded({ characterId, relationship: items[0] ?? null });
      })
      .catch(() => {
        if (active) setLoaded({ characterId, relationship: null });
      });
    return () => {
      active = false;
    };
  }, [characterId]);

  if (!relationship) return null;
  const current = relationshipVoiceFor(providerId, relationship.voice ?? '') ?? DEFAULT;
  const options = [
    { value: DEFAULT, label: '跟随默认' },
    ...voices.map((voice) => ({ value: voice, label: voice })),
  ];

  async function choose(value: string) {
    if (!relationship) return;
    setBusy(true);
    setError(null);
    try {
      const { item } = await saveCharacterRelationship({
        id: relationship.id,
        characterId: relationship.characterId,
        aiNickname: relationship.aiNickname,
        userPreferredName: relationship.userPreferredName,
        relationshipType: relationship.relationshipType,
        notes: relationship.notes,
        version: relationship.version,
        voice: value === DEFAULT ? '' : value,
      });
      setRelationship(item);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="mb-3 flex flex-col gap-1.5">
      <span className="text-xs text-[var(--text-soft)]">此角色的音色</span>
      <SettingSelect
        value={current}
        onValueChange={(value) => {
          if (!busy) void choose(value);
        }}
        options={options}
      />
      {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
    </label>
  );
}
