/**
 * Mints a short-lived realtime session token via `fetch` (which, unlike a
 * WebSocket handshake, CAN carry an `Authorization`/`api-key` header from the
 * browser) so the long-lived BYO key never touches the WebSocket URL or
 * subprotocol string directly.
 *
 * NOT LIVE-VERIFIED: the exact endpoint path and request/response shape for
 * xAI and Azure are transcribed from public docs at write time, not
 * exercised against a real account (no API key was available in this
 * session). OpenAI's shape is the one most likely to be exactly right. If a
 * provider's mint call 404s or CORS-fails in practice, the fallback is to
 * skip minting and use `settings.apiKey` directly as the WebSocket
 * subprotocol credential (see `buildAuthSubprotocol` in
 * `openai-realtime-session.ts`) — the plan this was scaffolded from
 * documents that as the intended retreat.
 */
import type { RealtimeProviderSettings } from './providers.js';

export interface EphemeralToken {
  value: string;
  expiresAt: number;
}

export async function mintOpenAiRealtimeEphemeralToken(
  settings: RealtimeProviderSettings,
): Promise<EphemeralToken> {
  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session: { type: 'realtime', model: settings.model } }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI 换票失败（${response.status}）：${await safeText(response)}`);
  }
  const data = (await response.json()) as { value: string; expires_at: number };
  return { value: data.value, expiresAt: data.expires_at * 1000 };
}

export async function mintXaiRealtimeEphemeralToken(
  settings: RealtimeProviderSettings,
): Promise<EphemeralToken> {
  const response = await fetch('https://api.x.ai/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session: { model: settings.model } }),
  });
  if (!response.ok) {
    throw new Error(`xAI 换票失败（${response.status}）：${await safeText(response)}`);
  }
  const data = (await response.json()) as { value: string; expires_at: number };
  return { value: data.value, expiresAt: data.expires_at * 1000 };
}

export async function mintAzureRealtimeEphemeralToken(
  settings: RealtimeProviderSettings,
): Promise<EphemeralToken> {
  if (!settings.baseUrl) {
    throw new Error('Azure 需要先填写资源地址');
  }
  const url = `${settings.baseUrl}/openai/realtimeapi/sessions?api-version=2025-04-01-preview`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'api-key': settings.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: settings.deployment || settings.model }),
  });
  if (!response.ok) {
    throw new Error(`Azure 换票失败（${response.status}）：${await safeText(response)}`);
  }
  const data = (await response.json()) as {
    client_secret: { value: string; expires_at: number };
  };
  return { value: data.client_secret.value, expiresAt: data.client_secret.expires_at * 1000 };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '(无法读取响应体)';
  }
}
