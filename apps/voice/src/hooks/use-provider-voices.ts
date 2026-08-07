import { useEffect, useState } from 'react';
import { fetchXaiVoices } from '@voice/lib/realtime/voice-catalog';
import type { RealtimeProviderId } from '@voice/lib/realtime/providers';

const DEBOUNCE_MS = 500;

/**
 * Only xAI is `voiceSource: 'api'` — every other provider's voice list is a
 * small fixed set, returned immediately from `staticVoices`. For xAI, fetch
 * the live list once an API key is present (debounced so typing a key
 * doesn't fire a request per keystroke), falling back to the static legacy
 * list while loading or on any failure — a stale-but-safe fallback beats a
 * broken dropdown.
 */
export function useProviderVoices(
  providerId: RealtimeProviderId,
  apiKey: string,
  staticVoices: string[],
): { voices: string[]; loading: boolean; error: string | null } {
  const [fetchedVoices, setFetchedVoices] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isXai = providerId === 'xai' && apiKey.trim().length > 0;

  useEffect(() => {
    if (!isXai) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      fetchXaiVoices(apiKey.trim())
        .then((fetched) => {
          if (!cancelled) setFetchedVoices(fetched);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setFetchedVoices(null);
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isXai, apiKey]);

  return {
    voices: isXai && fetchedVoices ? fetchedVoices : staticVoices,
    loading: isXai && loading,
    error: isXai ? error : null,
  };
}
