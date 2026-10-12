// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  allowGuardedNavigation,
  installHistoryNavigationGuard,
  registerNavigationGuard,
} from './navigation-guard';
afterEach(() => vi.restoreAllMocks());
it('allows saved drafts and account revocation without prompting, unregisters cleanly', () => {
  let dirty = true;
  let currentOwner = true;
  const remove = registerNavigationGuard(() => (dirty && currentOwner ? '未保存' : null));
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  expect(allowGuardedNavigation('/chat')).toBe(false);
  dirty = false;
  expect(allowGuardedNavigation('/chat')).toBe(true);
  dirty = true;
  currentOwner = false;
  expect(allowGuardedNavigation('/chat')).toBe(true);
  expect(confirm).toHaveBeenCalledOnce();
  remove();
  expect(allowGuardedNavigation('/chat')).toBe(true);
});
it('cancels back and forward before feature listeners, restores original entries and preserves state', () => {
  const originalReplace = window.history.replaceState.bind(window.history);
  window.history.replaceState({ feature: 'initial' }, '', '/market?editor=new');
  const uninstall = installHistoryNavigationGuard();
  const firstState = window.history.state;
  window.history.pushState({ feature: 'second' }, '', '/market?editor=card');
  const secondState = window.history.state;
  const remove = registerNavigationGuard((_to, from) =>
    from.pathname === '/market' ? '未保存' : null,
  );
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
  const consumer = vi.fn();
  window.addEventListener('popstate', consumer);
  originalReplace(firstState, '', '/market?editor=new');
  window.dispatchEvent(new PopStateEvent('popstate', { state: firstState }));
  expect(go).toHaveBeenLastCalledWith(1);
  expect(consumer).not.toHaveBeenCalled();
  originalReplace(secondState, '', '/market?editor=card');
  window.dispatchEvent(new PopStateEvent('popstate', { state: secondState }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(consumer).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  originalReplace(firstState, '', '/market?editor=new');
  window.dispatchEvent(new PopStateEvent('popstate', { state: firstState }));
  expect(consumer).toHaveBeenCalledOnce();
  confirm.mockReturnValue(false);
  originalReplace(secondState, '', '/market?editor=card');
  window.dispatchEvent(new PopStateEvent('popstate', { state: secondState }));
  expect(go).toHaveBeenLastCalledWith(-1);
  expect(consumer).toHaveBeenCalledOnce();
  originalReplace(firstState, '', '/market?editor=new');
  window.dispatchEvent(new PopStateEvent('popstate', { state: firstState }));
  expect(window.history.state.feature).toBe('initial');
  window.removeEventListener('popstate', consumer);
  remove();
  uninstall();
});
it('ignores a synthetic state-less popstate a feature sends after its own pushState', () => {
  const originalReplace = window.history.replaceState.bind(window.history);
  window.history.replaceState(null, '', '/people');
  const uninstall = installHistoryNavigationGuard();
  const people = window.history.state;
  window.history.pushState(null, '', '/chat');
  // A DM intent announces the route change itself.
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.history.pushState(null, '', '/market');
  const remove = registerNavigationGuard((_to, from) =>
    from.pathname === '/market' ? '未保存' : null,
  );
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
  // Back twice lands on /people, two entries behind /market.
  originalReplace(people, '', '/people');
  window.dispatchEvent(new PopStateEvent('popstate', { state: people }));
  expect(go).toHaveBeenLastCalledWith(2);
  remove();
  uninstall();
});
