import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RoomAgentDialog } from './RoomAgentDialog';
import { MAX_ROOM_AGENT_NAME, MAX_ROOM_AGENT_PERSONA } from '../../worker/wire';

const scene = vi.hoisted(() => ({
  id: 'imported',
  name: '长'.repeat(60),
  prompt: '人'.repeat(5000),
}));
vi.mock('@0xnullai/scenes', () => ({
  loadScenes: () => ({ scenes: [scene], hiddenBuiltinIds: [] }),
  subscribeScenes: () => () => {},
}));
afterEach(cleanup);

it('preserves an oversized imported scene and requires editing before saving the room copy', () => {
  const onSave = vi.fn();
  render(<RoomAgentDialog agent={null} onSave={onSave} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: scene.name }));
  const name = screen.getByLabelText('名字') as HTMLInputElement;
  const persona = screen.getByLabelText('人设（可留空）') as HTMLTextAreaElement;
  const save = screen.getByRole('button', { name: '加入房间' }) as HTMLButtonElement;
  expect(name.value).toBe(scene.name);
  expect(persona.value).toBe(scene.prompt);
  expect(screen.getByRole('alert').textContent).toContain('完整内容已保留');
  expect(save.disabled).toBe(true);
  fireEvent.click(save);
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.change(name, { target: { value: '名字'.slice(0, MAX_ROOM_AGENT_NAME) } });
  expect(save.disabled).toBe(true);
  const shortened = scene.prompt.slice(0, MAX_ROOM_AGENT_PERSONA);
  fireEvent.change(persona, { target: { value: shortened } });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  expect(onSave).toHaveBeenCalledWith({ name: '名字', persona: shortened });
  expect(scene.prompt.length).toBe(5000);
});

it('edits the sole AI while preserving its stable identity', () => {
  const agents = [{ id: 'room', name: '原角色', persona: '原文' }];
  const onSaveAgents = vi.fn();
  render(
    <RoomAgentDialog
      agent={agents[0]!}
      agents={agents}
      onSaveAgents={onSaveAgents}
      onSave={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: /添加角色/ })).toBeNull();
  fireEvent.change(screen.getByLabelText('名字'), { target: { value: '新角色' } });
  fireEvent.change(screen.getByLabelText('人设（可留空）'), { target: { value: '新的人设' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(onSaveAgents).toHaveBeenCalledWith([{ id: 'room', name: '新角色', persona: '新的人设' }]);
});
