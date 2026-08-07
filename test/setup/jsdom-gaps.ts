/**
 * Node 26 起，`localStorage` 是一个内置全局：不传 `--localstorage-file` 时它是
 * `undefined`，并且会**遮蔽 jsdom 自己的实现**。结果是 jsdom 环境下
 * `localStorage` / `window.localStorage` 全部取不到，任何碰它的测试直接
 * `TypeError: Cannot read properties of undefined`。
 *
 * 这不是本仓引入的问题——合并前各仓在 Node 26 上跑同样会失败；CI 用 Node 20
 * 则不受影响。所以修法不能依赖 node 参数（`--localstorage-file` 是实验性标志，
 * 而且它是文件持久化的，会让测试之间互相串状态）。
 *
 * 这里在检测到 localStorage 不可用时装一个纯内存实现：Node 20 上 jsdom 的真实
 * 现有实现会被保留，Node 26 上则拿到一个每个测试进程独立、语义一致的替代品。
 */

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.store.set(String(key), String(value));
  }
}

function install(name: 'localStorage' | 'sessionStorage'): void {
  const existing = (globalThis as Record<string, unknown>)[name];
  // 已经有可用实现（Node 20 + jsdom）就不动它。
  if (existing && typeof (existing as Storage).getItem === 'function') return;

  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, name, {
    value: storage,
    writable: true,
    configurable: true,
  });
  // jsdom 环境里 window 就是 globalThis，但显式写一遍以防环境实现有差异。
  if (typeof window !== 'undefined' && window !== (globalThis as unknown)) {
    Object.defineProperty(window, name, { value: storage, writable: true, configurable: true });
  }
}

install('localStorage');
install('sessionStorage');

/**
 * jsdom 不实现 `window.matchMedia`。任何走「跟随系统配色」分支的代码在测试里都会
 * 直接抛 TypeError——和上面的 localStorage 是同一类环境缺口，所以放在一起处理。
 *
 * 默认回答「不匹配」，也就是浅色。需要测深色的用例可以自行 mock 覆盖。
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}
