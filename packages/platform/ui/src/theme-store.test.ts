import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadThemeMode, setThemeMode, subscribeThemeMode } from './theme-store';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => vi.restoreAllMocks());

describe('共享主题 store', () => {
  it('没有任何记录时跟随系统', () => {
    expect(loadThemeMode()).toBe('auto');
  });

  it('写入后同时落到存储与 DOM', () => {
    setThemeMode('dark');
    expect(loadThemeMode()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  describe('从合并前的六个来源迁移', () => {
    it('外壳的键优先级最高', () => {
      localStorage.setItem('0xnullai-theme', 'light');
      localStorage.setItem('dg-wiki:theme', 'dark');
      // 用户最近一次明确的选择最可能发生在外壳上。
      expect(loadThemeMode()).toBe('light');
    });

    it('认 Wiki 的键', () => {
      localStorage.setItem('dg-wiki:theme', 'light');
      expect(loadThemeMode()).toBe('light');
    });

    it('认 Market 的键', () => {
      localStorage.setItem('dg-market.theme', 'dark');
      expect(loadThemeMode()).toBe('dark');
    });

    it('认 Agent 设置对象里的嵌套字段', () => {
      localStorage.setItem(
        'dg-agent.browser-settings',
        JSON.stringify({ themeMode: 'light', backgroundBehavior: 'stop' }),
      );
      expect(loadThemeMode()).toBe('light');
    });

    it('认 Voice 设置对象里的嵌套字段', () => {
      localStorage.setItem('dg-voice-settings', JSON.stringify({ theme: 'dark' }));
      expect(loadThemeMode()).toBe('dark');
    });

    it('迁移只发生一次，之后旧键改了也不再回头读', () => {
      localStorage.setItem('dg-wiki:theme', 'light');
      expect(loadThemeMode()).toBe('light');
      localStorage.setItem('dg-wiki:theme', 'dark');
      // 迁移时已写入自己的键，旧键从此无关——否则老模块的遗留写入会持续干扰。
      expect(loadThemeMode()).toBe('light');
    });

    it('设置对象是坏 JSON 时跳过它而不是崩掉', () => {
      localStorage.setItem('dg-agent.browser-settings', '{不是 JSON');
      localStorage.setItem('dg-voice-settings', JSON.stringify({ theme: 'dark' }));
      expect(loadThemeMode()).toBe('dark');
    });

    it('Market 用「删键」表示 auto，不会被误读', () => {
      // Market 存 auto 的方式是 removeItem，所以读到 null 必须落回 auto。
      expect(loadThemeMode()).toBe('auto');
    });
  });

  describe('订阅', () => {
    it('同文档内的改动会通知订阅者', () => {
      const seen: string[] = [];
      const stop = subscribeThemeMode((m) => seen.push(m));
      setThemeMode('dark');
      setThemeMode('light');
      stop();
      setThemeMode('dark');
      expect(seen).toEqual(['dark', 'light']);
    });

    it('跨标签页的改动既通知也施加到 DOM', () => {
      const seen: string[] = [];
      const stop = subscribeThemeMode((m) => seen.push(m));
      window.dispatchEvent(
        new StorageEvent('storage', { key: '0xnullai.theme', newValue: 'dark' }),
      );
      stop();
      // 只通知不施加的话，另一个标签页切了主题，这个标签页的 React 状态变了但页面没变。
      expect(seen).toEqual(['dark']);
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('无关键的 storage 事件不触发', () => {
      const seen: string[] = [];
      const stop = subscribeThemeMode((m) => seen.push(m));
      window.dispatchEvent(new StorageEvent('storage', { key: 'dg-chat-allow-ai', newValue: '1' }));
      stop();
      expect(seen).toEqual([]);
    });
  });

  it('存储不可写时仍然生效于本次会话', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    // 隐私模式下存不下，但页面必须照样变色——不能因为存不下就整个抛出去。
    expect(() => setThemeMode('dark')).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
