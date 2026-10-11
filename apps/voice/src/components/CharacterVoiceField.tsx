import { useEffect, useState } from 'react';
import {
  listCharacterRelationships,
  saveCharacterRelationship,
  type CharacterRelationship,
} from '@0xnullai/auth';
import { SettingSelect } from '@0xnullai/ui';
import { MANAGED_VOICES, managedVoiceFor } from '@voice/lib/realtime/managed-voices';

const DEFAULT = '__default__';

/**
 * The voice this AI speaks with, saved on the account's private relationship.
 * "跟随默认" uses the voice chosen under 我的 → AI. A voice saved for the previous
 * provider shows as the catalog voice it maps to; one the service cannot speak shows
 * as the default, since the call will use it. Nothing is rewritten until the user picks.
 */
export function CharacterVoiceField({ characterId }: { characterId: string }) {
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
  const current = managedVoiceFor(relationship.voice ?? '') ?? DEFAULT;
  const options = [
    { value: DEFAULT, label: '跟随默认' },
    ...MANAGED_VOICES.map((voice) => ({ value: voice.id, label: voice.label })),
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
