import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROXY, applyHttpProxy, loadProxy, saveProxy } from './proxy';

beforeEach(() => localStorage.clear());

describe('代理设置', () => {
  it('默认不启用', () => {
    expect(loadProxy()).toEqual(DEFAULT_PROXY);
  });

  it('存储被污染时按直连处理', () => {
    localStorage.setItem('0xnullai.proxy', '{不是 JSON');
    // Failing this way never sends requests somewhere unexpected.
    expect(loadProxy().enabled).toBe(false);
  });

  describe('HTTP 反代地址改写', () => {
    it('未启用时原样返回', () => {
      saveProxy({ ...DEFAULT_PROXY, httpBaseUrl: 'http://127.0.0.1:8080' });
      expect(applyHttpProxy('https://api.x.ai/v1/chat')).toBe('https://api.x.ai/v1/chat');
    });

    it('启用且配置了地址时改写', () => {
      saveProxy({ enabled: true, httpBaseUrl: 'http://127.0.0.1:8080' });
      expect(applyHttpProxy('https://api.x.ai/v1/chat?a=1')).toBe(
        'http://127.0.0.1:8080/api.x.ai/v1/chat?a=1',
      );
    });

    it('反代地址带路径前缀时保留前缀', () => {
      saveProxy({ enabled: true, httpBaseUrl: 'http://127.0.0.1:8080/proxy/' });
      expect(applyHttpProxy('https://api.x.ai/v1')).toBe('http://127.0.0.1:8080/proxy/api.x.ai/v1');
    });

    it('反代地址不合法时原样返回，不是拼出一个坏地址', () => {
      saveProxy({ enabled: true, httpBaseUrl: '这不是地址' });
      // A broken config should look like "proxy not used", never like
      // requests going to a mistyped destination — the latter makes the
      // user believe the proxy is working.
      expect(applyHttpProxy('https://api.x.ai/v1')).toBe('https://api.x.ai/v1');
    });

    it('上游地址不合法时也原样返回', () => {
      saveProxy({ enabled: true, httpBaseUrl: 'http://127.0.0.1:8080' });
      expect(applyHttpProxy('not-a-url')).toBe('not-a-url');
    });
  });

});
