import { beforeEach, describe, expect, it } from 'vitest';
import { forgetGroup, loadKnownGroups, rememberGroup, saveOwnerKey } from './groups';

beforeEach(() => localStorage.clear());

describe('房间列表', () => {
  it('可以从本机列表删除房间并清除房主凭据', () => {
    rememberGroup('room-a', '测试房间');
    saveOwnerKey('room-a', 'owner-secret');

    forgetGroup('room-a');

    expect(loadKnownGroups()).toEqual([]);
    expect(localStorage.getItem('dg-chat-owner-key:room-a')).toBeNull();
  });

  it('任何普通房间都能从自己的列表删除', () => {
    rememberGroup('room-b', '普通房间');
    forgetGroup('room-b');
    expect(loadKnownGroups()).toEqual([]);
  });
});
