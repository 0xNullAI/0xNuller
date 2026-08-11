import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RoomAgentDialog } from './RoomAgentDialog';

afterEach(cleanup);

describe('房间 AI 弹窗', () => {
  it('提供对话框语义，并通过共享 Overlay 响应 Esc', () => {
    const onClose = vi.fn();
    render(<RoomAgentDialog agent={null} onSave={vi.fn()} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: '房间 AI' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
  });
});
