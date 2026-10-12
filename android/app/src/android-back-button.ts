import { onBackButtonPress, type OnBackButtonPressPayload } from '@tauri-apps/api/app';

interface BackButtonListener {
  unregister(): Promise<void>;
}

export interface BackButtonDeps {
  register?: (handler: (payload: OnBackButtonPressPayload) => void) => Promise<BackButtonListener>;
  back?: () => void;
  notify: (text: string) => void;
  schedule?: (run: () => void, ms: number) => unknown;
}

/** How long the button stays released after the exit hint. */
export const EXIT_WINDOW_MS = 2000;

/**
 * Android hardware back, and only that: in-app history changes (route
 * changes, synthetic popstate, notification taps) never reach this handler.
 *
 * Tauri reports whether the WebView can go back. If it can, take one history
 * step — exactly what the browser back button does, so the shell's navigation
 * guard and routes see an ordinary traversal. At the root, show the exit hint
 * and release the button for EXIT_WINDOW_MS: with no listener, Android's own
 * handling runs and the next press closes the activity.
 *
 * If registration fails, Android's default (go back, or close at the root)
 * still applies, so back never gets stuck.
 */
export function installBackButton({
  register = onBackButtonPress,
  back = () => history.back(),
  notify,
  schedule = setTimeout,
}: BackButtonDeps): Promise<void> {
  let listener: BackButtonListener | null = null;
  const attach = async (): Promise<void> => {
    listener = await register(({ canGoBack }) => {
      if (canGoBack) {
        back();
        return;
      }
      notify('再按一次退出');
      const released = listener;
      listener = null;
      void released?.unregister();
      schedule(() => void attach().catch(() => {}), EXIT_WINDOW_MS);
    });
  };
  return attach().catch(() => {});
}
