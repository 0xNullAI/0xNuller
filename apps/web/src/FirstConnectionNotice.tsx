import { useEffect, useState } from 'react';
import { SafetyNotice } from '@0xnullai/ui';
import {
  allConnectedDevices,
  isSafetyNoticeAccepted,
  rememberSafetyNoticeAccepted,
  stopAllSafetySessions,
} from '@dg-kit/safety';

/**
 * 首次连上设备时的安全须知。
 *
 * 开场弹窗已经去掉——它打扰了只想逛市场或看文档的人，而这些人根本不会碰到风险。
 * 真正需要看到须知的时刻是**设备接到身上那一刻**，那也是它最可能被认真读的时刻。
 *
 * 注册流程里的用户协议是另一个落点（见 AccountDialog），但账号是可选的，只放在
 * 那里等于让从不注册的人永远看不到。两处用的是同一份正文。
 *
 * 未确认就选择退出时**主动停掉输出**：能走到这一步说明设备已经连上，而用户明确
 * 表示还不接受风险。这里宁可多停一次。
 */

const POLL_MS = 1000;

export function FirstConnectionNotice() {
  const [show, setShow] = useState(false);
  const [dismissed, setDismissed] = useState(() => isSafetyNoticeAccepted());

  useEffect(() => {
    if (dismissed) return;
    const check = () => {
      if (allConnectedDevices().length > 0) setShow(true);
    };
    check();
    const timer = window.setInterval(check, POLL_MS);
    return () => window.clearInterval(timer);
  }, [dismissed]);

  if (!show || dismissed) return null;

  return (
    <SafetyNotice
      onAccept={({ dontShowAgain }) => {
        if (dontShowAgain) rememberSafetyNoticeAccepted();
        setDismissed(true);
        setShow(false);
      }}
      onDecline={() => {
        // 设备已连上而用户不接受风险——停掉再关。
        void stopAllSafetySessions().catch(() => undefined);
        setDismissed(true);
        setShow(false);
      }}
    />
  );
}
