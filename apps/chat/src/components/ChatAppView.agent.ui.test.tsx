import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ChatAppView, type ChatAppViewProps } from './ChatAppView';

const panel = vi.hoisted(() => ({ visible: undefined as unknown }));
vi.mock('./ChatPanel', () => ({
  ChatPanel: (props: { onMessageVisible?: unknown }) => {
    panel.visible = props.onMessageVisible;
    return null;
  },
}));
vi.mock('./ControlPanel', () => ({ ControlPanel: () => null }));
vi.mock('./ShellRoomList', () => ({ ShellRoomList: () => null }));
vi.mock('./ShellDmList', () => ({ ShellDmList: () => null }));
vi.mock('@0xnullai/scenes', () => ({
  loadScenes: () => ({
    scenes: [{ id: 'kitty', name: '小雨', prompt: '温和的读书伙伴', kind: 'character' }],
    hiddenBuiltinIds: [],
  }),
  subscribeScenes: () => () => {},
  savedPromptKind: (scene: { kind?: string }) => scene.kind ?? 'scene',
}));
vi.mock('@0xnullai/auth', () => ({ currentAuthUserId: () => 'me' }));
afterEach(cleanup);

function ShellRoom({ canManage = true, isDm = false, add = vi.fn(async () => true) }) {
  const [agentOpen, setAgentOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'chat' | 'control'>('chat');
  const props = {
    inShell: true,
    agentOpen,
    setAgentOpen,
    activeTab,
    setActiveTab,
    conversationDeviceEnabled: false,
    onSetConversationDeviceEnabled: vi.fn(),
    peerRoom: {
      roomId: 'room',
      canManageGroup: canManage,
      isDm,
      peers: [],
      members: new Map(),
      messages: [],
      agents: [],
      addMyAgent: add,
    },
    device: {},
    waveforms: {},
  } as unknown as ChatAppViewProps;
  return <ChatAppView {...props} />;
}

it.each([{ canManage: true }, { canManage: false }])(
  'lets any group member bring their own character in from chat settings: %j',
  (props) => {
    const add = vi.fn(async () => true);
    render(<ShellRoom {...props} add={add} />);
    fireEvent.click(screen.getByRole('button', { name: '聊天设置' }));
    fireEvent.click(screen.getByRole('button', { name: '群 AI' }));
    fireEvent.click(screen.getByRole('button', { name: /小雨/ }));
    expect(add).toHaveBeenCalledWith({ id: 'kitty', name: '小雨', persona: '温和的读书伙伴' });
  },
);

it('keeps the group AI entry out of private conversations', () => {
  render(<ShellRoom isDm />);
  fireEvent.click(screen.getByRole('button', { name: '聊天设置' }));
  expect(screen.queryByRole('button', { name: '群 AI' })).toBeNull();
});

it('keeps the shell conversation on one chat surface and opens per-chat device access in settings', () => {
  render(<ShellRoom isDm />);
  expect(screen.queryByRole('button', { name: '⚡ 控制' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '聊天设置' }));
  const access = screen.getByLabelText(/允许此聊天控制我的设备/);
  expect(access.closest('.hidden')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '返回聊天' }));
  expect(access.closest('.hidden')).toBeTruthy();
});

it('offers no memory sharing entry in a human conversation', () => {
  const props = {
    inShell: true,
    signedIn: true,
    activeTab: 'control',
    peerRoom: {
      roomId: 'group-room',
      isDm: false,
      peers: [],
      members: new Map(),
      messages: [],
      agents: [],
    },
    device: {},
    waveforms: {},
  } as unknown as ChatAppViewProps;
  render(<ChatAppView {...props} />);
  expect(screen.queryByRole('button', { name: '记忆共享' })).toBeNull();
});

it('enables group automatic reading only in the actual chat pane', () => {
  const acknowledge = vi.fn(async () => {});
  function Test() {
    const [activeTab, setActiveTab] = useState<'chat' | 'control'>('chat');
    const props = {
      inShell: true,
      activeTab,
      setActiveTab,
      onGroupMessageVisible: acknowledge,
      peerRoom: {
        roomId: 'group',
        isDm: false,
        isOwner: false,
        peers: [],
        members: new Map(),
        messages: [],
        agents: [],
      },
      device: {},
      waveforms: {},
    } as unknown as ChatAppViewProps;
    return <ChatAppView {...props} />;
  }
  render(<Test />);
  expect(panel.visible).toBe(acknowledge);
  fireEvent.click(screen.getByRole('button', { name: '聊天设置' }));
  expect(panel.visible).toBeUndefined();
  fireEvent.click(screen.getByRole('button', { name: '返回聊天' }));
  expect(panel.visible).toBe(acknowledge);
});

it('has one device consent per chat and no separate group-AI switch', () => {
  const onSetConversationDeviceEnabled = vi.fn();
  const props = {
    inShell: true,
    activeTab: 'control',
    conversationDeviceEnabled: false,
    onSetConversationDeviceEnabled,
    peerRoom: {
      roomId: 'group',
      isDm: false,
      peers: [],
      members: new Map(),
      messages: [],
      agents: [],
    },
    device: {},
    waveforms: {},
  } as unknown as ChatAppViewProps;
  render(<ChatAppView {...props} />);
  const group = screen.getByRole('group', { name: '设备授权' });
  expect(group.querySelectorAll('input[type=checkbox]')).toHaveLength(1);
  expect(screen.queryByLabelText(/群 AI 控制/)).toBeNull();
  fireEvent.click(screen.getByLabelText(/允许此聊天控制我的设备/));
  expect(onSetConversationDeviceEnabled).toHaveBeenCalledWith(true);
});
