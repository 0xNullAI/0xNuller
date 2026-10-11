/**
 * Voices offered by 猫愿语音, the only realtime voice service. The browser
 * talks only to our Worker (`/api/realtime`); the Worker owns the upstream
 * provider and its key. These ids must match the voices that upstream speaks,
 * so change this list together with the Worker's upstream.
 */
export const MANAGED_VOICES = ['eve', 'ara', 'leo', 'rex', 'sal'] as const;

export const DEFAULT_MANAGED_VOICE: string = MANAGED_VOICES[0];

function isManagedVoice(voice: string): boolean {
  return (MANAGED_VOICES as readonly string[]).includes(voice);
}

/** A stored or relationship voice the service can speak, or null for the account default. */
export function managedVoiceFor(voice: string): string | null {
  const chosen = voice.trim();
  return isManagedVoice(chosen) ? chosen : null;
}

/** The account default voice, falling back to the service default for an unknown id. */
export function normalizeManagedVoice(voice: unknown): string {
  return (typeof voice === 'string' && managedVoiceFor(voice)) || DEFAULT_MANAGED_VOICE;
}
