import { describe, expect, it } from 'vitest';
import { buildVisibleRooms } from './ShellRoomList';

const publicRooms = [
  { code: 'public-a', name: '公开 A', count: 3 },
  { code: 'joined-b', name: '已改名 B', count: 1 },
];

describe('Chat 房间列表投影', () => {
  it('有成员房间时侧栏只显示实际加入的房间，并采用目录中的实时信息', () => {
    expect(
      buildVisibleRooms(
        [
          { code: 'joined-b', name: '旧名称' },
          { code: 'private-c', name: '私密 C' },
        ],
        publicRooms,
        'memberships',
      ),
    ).toEqual([
      { code: 'joined-b', name: '已改名 B', count: 1 },
      { code: 'private-c', name: '私密 C', count: 0 },
    ]);
  });

  it('尚未加入任何房间时展示公开目录，但不伪造成成员关系', () => {
    expect(buildVisibleRooms([], publicRooms, 'memberships')).toEqual(publicRooms);
  });

  it('公开目录模式始终只显示公开房间', () => {
    expect(
      buildVisibleRooms([{ code: 'private-c', name: '私密 C' }], publicRooms, 'directory'),
    ).toEqual(publicRooms);
  });
});
