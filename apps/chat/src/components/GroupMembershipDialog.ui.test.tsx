import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@0xnullai/auth', () => ({ currentAuthUserId: () => 'owner' }));
import { GroupMembershipDialog } from './GroupMembershipDialog';
afterEach(cleanup);
it('owner controls target stable account IDs and exposes restore without claiming old anonymous users', () => {
  const action = vi.fn();
  render(
    <GroupMembershipDialog
      members={[
        { account_id: 'alice', name: 'Alice', state: 'active', version: 1, updated_at: 1 },
        { account_id: 'bob', name: 'Bob', state: 'banned', version: 2, updated_at: 1 },
      ]}
      onAction={action}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '封禁' }));
  expect(action).toHaveBeenCalledWith('ban', 'alice');
  fireEvent.click(screen.getByRole('button', { name: '恢复加入' }));
  expect(action).toHaveBeenCalledWith('restore', 'bob');
});
