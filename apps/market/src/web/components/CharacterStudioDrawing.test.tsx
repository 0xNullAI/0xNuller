// @vitest-environment jsdom
import { cleanup, act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CharacterStudioDrawing } from './CharacterStudioDrawing';
const context = {
  fillRect: vi.fn(),
  getImageData: vi.fn(() => ({})),
  putImageData: vi.fn(),
  beginPath: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 0,
  lineCap: '',
  lineJoin: '',
};
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 256,
    height: 256,
  } as DOMRect);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
    callback(new Blob(['png'], { type: 'image/png' })),
  );
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:drawing');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId = 1;
    },
  );
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe('draw a public character avatar', () => {
  it('requires drawing, preview and explicit confirmation before upload', async () => {
    const save = vi.fn(async () => {});
    const close = vi.fn();
    const view = render(
      <CharacterStudioDrawing onDirtyChange={vi.fn()} onSave={save} onClose={close} />,
    );
    expect((screen.getByRole('button', { name: '预览头像' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    const canvas = screen.getByLabelText('头像画板');
    fireEvent.pointerDown(canvas, { clientX: 20, clientY: 30, button: 0 });
    fireEvent.pointerMove(canvas, { clientX: 25, clientY: 35 });
    fireEvent.pointerUp(canvas);
    expect(context.moveTo).toHaveBeenCalledWith(40, 60);
    expect(context.lineTo).toHaveBeenCalledWith(50, 70);
    fireEvent.click(screen.getByRole('button', { name: '预览头像' }));
    expect(screen.getByAltText('待确认的手绘头像')).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认上传到公开角色草稿' }));
    });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/png' }));
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:drawing');
  });
  it('supports eraser/clear and discards cancelled drawing without saving', () => {
    const save = vi.fn();
    const close = vi.fn();
    render(<CharacterStudioDrawing onDirtyChange={vi.fn()} onSave={save} onClose={close} />);
    fireEvent.click(screen.getByRole('button', { name: '橡皮' }));
    fireEvent.pointerDown(screen.getByLabelText('头像画板'), {
      clientX: 10,
      clientY: 10,
      button: 0,
    });
    expect(context.strokeStyle).toBe('#ffffff');
    fireEvent.click(screen.getByRole('button', { name: '清空画板' }));
    expect((screen.getByRole('button', { name: '预览头像' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: '取消绘制' }));
    expect(close).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });
  it('provides upload fallback when canvas is unsupported', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    render(<CharacterStudioDrawing onDirtyChange={vi.fn()} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('不支持画板');
  });
});

it('undoes a stroke and keeps failed uploads open for retry', async () => {
  const dirty = vi.fn();
  const save = vi.fn().mockRejectedValue(new Error('网络失败'));
  const close = vi.fn();
  render(<CharacterStudioDrawing onDirtyChange={dirty} onSave={save} onClose={close} />);
  const canvas = screen.getByLabelText('头像画板');
  fireEvent.pointerDown(canvas, { clientX: 20, clientY: 30, button: 0 });
  fireEvent.pointerUp(canvas);
  expect(dirty).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByText('撤销一笔'));
  expect(context.putImageData).toHaveBeenCalled();
  expect(dirty).toHaveBeenLastCalledWith(false);
  fireEvent.pointerDown(canvas, { clientX: 20, clientY: 30, button: 0 });
  fireEvent.pointerUp(canvas);
  fireEvent.click(screen.getByText('预览头像'));
  await act(async () => fireEvent.click(screen.getByText('确认上传到公开角色草稿')));
  expect(screen.getByRole('alert').textContent).toContain('网络失败');
  expect(screen.getByAltText('待确认的手绘头像')).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.click(screen.getByText('取消绘制'));
  expect(close).not.toHaveBeenCalled();
});
it('handles export failure without losing the drawing or uploading', () => {
  const save = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(() => {
    throw new Error('unavailable');
  });
  render(<CharacterStudioDrawing onDirtyChange={vi.fn()} onSave={save} onClose={vi.fn()} />);
  fireEvent.pointerDown(screen.getByLabelText('头像画板'), { clientX: 20, clientY: 30, button: 0 });
  fireEvent.pointerUp(screen.getByLabelText('头像画板'));
  fireEvent.click(screen.getByText('预览头像'));
  expect(screen.getByRole('alert').textContent).toContain('无法导出');
  expect((screen.getByText('预览头像') as HTMLButtonElement).disabled).toBe(false);
  expect(save).not.toHaveBeenCalled();
});
