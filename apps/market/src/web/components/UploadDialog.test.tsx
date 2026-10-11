// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { UploadDialog } from './UploadDialog';

afterEach(cleanup);

it('publishes only waveforms and directs prompt cards to the page editor', () => {
  render(<UploadDialog onClose={() => {}} onUploaded={() => {}} onChanged={() => {}} />);
  expect(screen.getByText('可上传单条或最多 50 条波形；角色与场景请在发现页创建。')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '多人场景' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: '手动填写一条' }));
  expect(screen.getByText('波形数据 *')).toBeTruthy();
  expect(screen.queryByText('世界观 / 背景 *')).toBeNull();
});
