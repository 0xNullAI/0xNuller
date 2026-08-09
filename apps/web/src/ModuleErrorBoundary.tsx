import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { stopAllDevices } from '@0xnullai/ui';

/**
 * Keeps a module's crash contained inside that module.
 *
 * Without it, a throw during any module's render makes React unmount the entire
 * tree — the shell's top bar goes with it, the page still looks present (leftover
 * DOM) but nothing responds to clicks. **That includes the global emergency stop
 * button.** If a module crashes while a device is running, the user loses the stop
 * entry point that is supposed to be one action away.
 *
 * So this is not just an error page: the first thing it does on catch is stop every
 * registered device session. A crashed module can no longer be trusted, and its own
 * stop logic may not run anymore either — better to stop a few idle ones too.
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
    // A device may still be running when the crash happens, and this module's stop
    // button has already gone down with it.
    // A failure here must not let the boundary itself throw — that would escalate the
    // crash into an unmount of the whole tree, exactly what this is here to prevent.
    void stopAllDevices();
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
        <pre className="max-w-full overflow-x-auto rounded-[var(--radius-ctl)] bg-[var(--bg-soft)] px-3 py-2 text-left text-xs text-[var(--text-faint)]">
          {error.message}
        </pre>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="rounded-[var(--radius-ctl)] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--button-text)]"
        >
          重试
        </button>
      </div>
    );
  }
}
