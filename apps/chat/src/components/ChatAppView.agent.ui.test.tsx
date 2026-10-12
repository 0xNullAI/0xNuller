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
  loadScenes: () => ({ scenes: [], hiddenBuiltinIds: [] }),
  subscribeScenes: () => () => {},
}));
afterEach(cleanup);

function ShellRoom({ canManage = true, isDm = false, save = vi.fn() }) {
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
      agent: null,
      setAgent: save,
    },
    device: {},
    waveforms: {},
  } as unknown as ChatAppViewProps;
  return <ChatAppView {...props} />;
}

it('lets a room owner add a named AI from the unified website header', () => {
  const save = vi.fn();
  render(<ShellRoom save={save} />);
  fireEvent.click(screen.getByRole('button', { name: '聊天设置' }));
  fireEvent.click(screen.getByRole('button', { name: '群 AI' }));
  fireEvent.change(screen.getByLabelText('名字'), { target: { value: '小雨' } });
  fireEvent.change(screen.getByLabelText('人设（可留空）'), {
    target: { value: '温和的读书伙伴' },
  });
  fireEvent.click(screen.getByRole('button', { name: '加入群聊' }));
  expect(save).toHaveBeenCalledWith({ name: '小雨', persona: '温和的读书伙伴' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it.each([{ canManage: false }, { isDm: true }])(
  'keeps the agent action out of non-owner and private conversations: %j',
  (props) => {
    render(<ShellRoom {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '聊天设置' }));
    expect(screen.queryByRole('button', { name: '群 AI' })).toBeNull();
  },
);

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
        agent: null,
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

it('groups the chat consent and the room-AI consent, and the AI one needs the chat one', () => {
  const setAllowAi = vi.fn();
  const onSetConversationDeviceEnabled = vi.fn();
  const props = {
    inShell: true,
    activeTab: 'control',
    allowAi: false,
    setAllowAi,
    conversationDeviceEnabled: false,
    onSetConversationDeviceEnabled,
    peerRoom: { roomId: 'group', isDm: false, peers: [], members: new Map(), messages: [] },
    device: {},
    waveforms: {},
  } as unknown as ChatAppViewProps;
  const view = render(<ChatAppView {...props} />);
  const group = screen.getByRole('group', { name: '设备授权' });
  const ai = screen.getByLabelText(/也允许群 AI 控制/) as HTMLInputElement;
  expect(group.contains(ai)).toBe(true);
  expect(ai.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/允许此聊天控制我的设备/));
  expect(onSetConversationDeviceEnabled).toHaveBeenCalledWith(true);
  view.rerender(<ChatAppView {...props} conversationDeviceEnabled />);
  fireEvent.click(screen.getByLabelText(/也允许群 AI 控制/));
  expect(setAllowAi).toHaveBeenCalledWith(true);
  view.rerender(<ChatAppView {...props} peerRoom={{ ...props.peerRoom, isDm: true }} />);
  expect(screen.queryByLabelText(/也允许群 AI 控制/)).toBeNull();
});
