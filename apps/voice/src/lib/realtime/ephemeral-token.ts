/**
 * Mints a short-lived realtime session token via `fetch` (which, unlike a
 * WebSocket handshake, CAN carry an `Authorization`/`api-key` header from the
 * browser) so the long-lived BYO key never touches the WebSocket URL or
 * subprotocol string directly.
 *
 * Endpoint paths + CORS were verified by live probes (all three return a
 * proper auth error to a bad key and send `Access-Control-Allow-Origin: *`,
 * so a browser fetch works). xAI is confirmed working end-to-end. OpenAI and
 * Azure use the GA `/v1/realtime/client_secrets` shape (flat `value` in the
 * response). If a mint call fails at runtime, `resolveCredential` in
 * `openai-realtime-session.ts` falls back to using `settings.apiKey` directly
 * as the WebSocket subprotocol credential.
 */
import type { RealtimeProviderSettings } from './providers.js';
import { applyHttpProxy } from '@0xnullai/settings';

export interface EphemeralToken {
  value: string;
  expiresAt: number;
}

export async function mintOpenAiRealtimeEphemeralToken(
  settings: RealtimeProviderSettings,
): Promise<EphemeralToken> {
  const response = await fetch(
    applyHttpProxy('https://api.openai.com/v1/realtime/client_secrets'),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ session: { type: 'realtime', model: settings.model } }),
    },
  );
  if (!response.ok) {
    throw new Error(`OpenAI 换票失败（${response.status}）：${await safeText(response)}`);
  }
  const data = (await response.json()) as { value: string; expires_at: number };
  return { value: data.value, expiresAt: data.expires_at * 1000 };
}

export async function mintXaiRealtimeEphemeralToken(
  settings: RealtimeProviderSettings,
): Promise<EphemeralToken> {
  const response = await fetch(applyHttpProxy('https://api.x.ai/v1/realtime/client_secrets'), {
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
  // GA endpoint: /openai/v1/realtime/client_secrets (no api-version param).
  // We previously used the DEPRECATED preview path
  // /openai/realtimeapi/sessions?api-version=2025-04-01-preview and parsed a
  // `client_secret.value` field — GA returns the token as a flat `value`,
  // same as OpenAI. Both were wrong. (learn.microsoft.com Azure OpenAI
  // realtime GA migration notes.)
  const url = `${settings.baseUrl}/openai/v1/realtime/client_secrets`;
  const response = await fetch(applyHttpProxy(url), {
    method: 'POST',
    headers: {
      'api-key': settings.apiKey,
      'Content-Type': 'application/json',
    },
    // On Azure `session.model` is the model DEPLOYMENT name.
    body: JSON.stringify({
      session: { type: 'realtime', model: settings.deployment || settings.model },
    }),
  });
  if (!response.ok) {
    throw new Error(`Azure 换票失败（${response.status}）：${await safeText(response)}`);
  }
  const data = (await response.json()) as { value: string; expires_at: number };
  return { value: data.value, expiresAt: data.expires_at * 1000 };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '(无法读取响应体)';
  }
}
