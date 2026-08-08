import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { stopAllSafetySessions } from '@dg-kit/safety';

/**
 * 把模块的崩溃关在模块里。
 *
 * 没有它的时候，任何一个模块在渲染期抛错都会让 React 卸载整棵树——外壳顶栏跟着消失，
 * 页面看上去还在（DOM 残留），但什么都点不动。**其中包括全局急停按钮。**
 * 设备正在输出时模块崩掉，用户就失去了那个「一个动作可达」的停止入口。
 *
 * 所以这里不只是显示一个错误页：捕获的第一件事是停掉所有已注册的设备会话。崩溃的
 * 模块已经不可信了，它自己的停止逻辑也未必还能跑，宁可多停几个空的。
 */

interface Props {
  moduleId: string;
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ModuleErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 崩溃时设备可能仍在输出，而这个模块的停止按钮已经随它一起消失了。
    // 失败也不能让边界本身再抛——那会把崩溃升级成整棵树卸载，正是要防的事。
    void stopAllSafetySessions().catch(() => undefined);
    console.error(`[shell] 模块 ${this.props.moduleId} 渲染失败`, error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div>
          <h2 className="text-lg font-semibold">{this.props.label} 加载失败</h2>
          <p className="mt-2 max-w-md text-sm text-[var(--text-soft)]">
            这个模块出错了，其余模块不受影响。为安全起见，所有设备输出已经停止。
          </p>
        </div>
        <pre className="max-w-full overflow-x-auto rounded-[10px] bg-[var(--bg-soft)] px-3 py-2 text-left text-xs text-[var(--text-faint)]">
          {error.message}
        </pre>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="rounded-[10px] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--button-text)]"
        >
          重试
        </button>
      </div>
    );
  }
}
