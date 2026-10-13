import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { groupAiDeviceAccess } from '@0xnullai/settings';
import { RoomAgentDialog } from './RoomAgentDialog';
import { MAX_ROOM_AGENT_PERSONA, type WireRoomAgent } from '../../worker/wire';

const library = vi.hoisted(() => ({
  scenes: [
    { id: 'kitty', name: '小猫', prompt: '温柔的猫', kind: 'character' },
    { id: 'huge', name: '长篇', prompt: '人'.repeat(5000), kind: 'character' },
    { id: 'cafe', name: '咖啡馆', prompt: '一个场景', kind: 'scene' },
  ],
  hiddenBuiltinIds: [] as string[],
}));
vi.mock('@0xnullai/scenes', () => ({
  loadScenes: () => library,
  subscribeScenes: () => () => {},
  savedPromptKind: (scene: { kind?: string }) => scene.kind ?? 'scene',
}));
afterEach(cleanup);

const agent = (owner: string, ownerName: string, id = `ai-${owner}`): WireRoomAgent => ({
  id,
  name: `${ownerName}的猫`,
  persona: '',
  owner,
  ownerName,
  dailyCap: null,
});

function open(agents: WireRoomAgent[], canRemoveAny = false) {
  const props = {
    onAdd: vi.fn(async () => true),
    onSetDailyCap: vi.fn(),
    onRemove: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <RoomAgentDialog
      agents={agents}
      groupId="g1"
      selfAccountId="me"
      canRemoveAny={canRemoveAny}
      {...props}
    />,
  );
  return props;
}

it('offers only my characters that fit, and brings one in without editing it', () => {
  const props = open([]);
  expect(screen.queryByText('咖啡馆')).toBeNull();
  const huge = screen.getByRole('button', { name: /长篇/ }) as HTMLButtonElement;
  expect(huge.disabled).toBe(true);
  expect(huge.textContent).toContain('人设过长');
  expect('人'.repeat(5000).length).toBeGreaterThan(MAX_ROOM_AGENT_PERSONA);
  fireEvent.click(screen.getByRole('button', { name: /小猫/ }));
  expect(props.onAdd).toHaveBeenCalledWith({ id: 'kitty', name: '小猫', persona: '温柔的猫' });
});

it('labels each AI with its owner and lets me cap or withdraw only my own', () => {
  const props = open([agent('me', 'Me'), agent('bob', 'Bob')]);
  expect(screen.getByText(/我的 AI/)).toBeTruthy();
  expect(screen.getByText(/Bob的 AI/)).toBeTruthy();
  expect(screen.getAllByRole('button', { name: /撤出|移出/ })).toHaveLength(1);
  expect(screen.queryByRole('region', { name: '带我的角色进群' })).toBeNull();
  const cap = screen.getByLabelText('每日 Credit 上限');
  fireEvent.change(cap, { target: { value: '20' } });
  fireEvent.blur(cap);
  expect(props.onSetDailyCap).toHaveBeenCalledWith('ai-me', 20);
  fireEvent.change(cap, { target: { value: '' } });
  fireEvent.blur(cap);
  expect(props.onSetDailyCap).toHaveBeenLastCalledWith('ai-me', null);
  fireEvent.click(screen.getByRole('button', { name: /撤出/ }));
  expect(props.onRemove).toHaveBeenCalledWith('ai-me');
});

it('lets the group owner remove anyone, and stops new AIs at the group limit', () => {
  const props = open([agent('a', 'A'), agent('b', 'B'), agent('c', 'C')], true);
  expect(screen.getByText(/本群已有 3 个 AI/)).toBeTruthy();
  const remove = screen.getAllByRole('button', { name: /移出/ });
  expect(remove).toHaveLength(3);
  fireEvent.click(remove[1]!);
  expect(props.onRemove).toHaveBeenCalledWith('ai-b');
});

it('lets me allow each AI to control my device on its own, off by default', () => {
  localStorage.clear();
  open([agent('me', 'Me'), agent('bob', 'Bob')]);
  const toggles = screen.getAllByRole('checkbox', { name: '允许它控制我的设备' });
  expect(toggles).toHaveLength(2);
  expect(toggles.map((toggle) => (toggle as HTMLInputElement).checked)).toEqual([false, false]);
  fireEvent.click(toggles[1]!);
  expect(groupAiDeviceAccess('me', 'g1', 'ai-bob')).toBe(true);
  expect(groupAiDeviceAccess('me', 'g1', 'ai-me')).toBe(false);
  expect((toggles[1] as HTMLInputElement).checked).toBe(true);
  fireEvent.click(toggles[1]!);
  expect(groupAiDeviceAccess('me', 'g1', 'ai-bob')).toBe(false);
});
