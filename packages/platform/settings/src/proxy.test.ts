import { afterEach, describe, expect, it } from 'vitest';
import {
  applyHttpProxy,
  applyWebSocketProxy,
  isUsableEndpointUrl,
  onlyHttpsEndpointsAllowed,
} from './proxy';

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
});

describe('endpoint addresses', () => {
  it('accepts http and https on the web', () => {
    expect(onlyHttpsEndpointsAllowed()).toBe(false);
    expect(isUsableEndpointUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isUsableEndpointUrl('https://proxy.example.com')).toBe(true);
    expect(isUsableEndpointUrl('socks5://127.0.0.1:1080')).toBe(false);
    expect(isUsableEndpointUrl('not a url')).toBe(false);
  });

  it('accepts only https in the Android shell, whose CSP and cleartext ban block http', () => {
    (window as TauriWindow).__TAURI_INTERNALS__ = {};
    expect(onlyHttpsEndpointsAllowed()).toBe(true);
    expect(isUsableEndpointUrl('http://127.0.0.1:8080')).toBe(false);
    expect(isUsableEndpointUrl('https://proxy.example.com')).toBe(true);
  });
});

describe('reverse proxy rewriting', () => {
  const proxy = (httpBaseUrl: string) => ({ enabled: true, httpBaseUrl });

  it('mounts the upstream host under the proxy path', () => {
    expect(applyHttpProxy('https://api.x.ai/v1/chat?a=1', proxy('http://127.0.0.1:8080/p/'))).toBe(
      'http://127.0.0.1:8080/p/api.x.ai/v1/chat?a=1',
    );
    expect(applyWebSocketProxy('wss://0xnullai.com/ws', proxy('https://proxy.example.com'))).toBe(
      'wss://proxy.example.com/0xnullai.com/ws',
    );
  });

  it('connects directly instead of through an http proxy the Android shell would block', () => {
    (window as TauriWindow).__TAURI_INTERNALS__ = {};
    expect(applyHttpProxy('https://api.x.ai/v1', proxy('http://127.0.0.1:8080'))).toBe(
      'https://api.x.ai/v1',
    );
    expect(applyHttpProxy('https://api.x.ai/v1', proxy('https://proxy.example.com'))).toBe(
      'https://proxy.example.com/api.x.ai/v1',
    );
  });
});
