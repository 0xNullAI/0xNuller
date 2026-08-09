import { useEffect, useState } from 'react';
import { SafetyNotice, stopAllDevices } from '@0xnullai/ui';
import {
  allConnectedDevices,
  isSafetyNoticeAccepted,
  rememberSafetyNoticeAccepted,
} from '@dg-kit/safety';

/**
 * Safety notice shown the first time a device connects.
 *
 * The startup dialog is gone — it interrupted people who only wanted to browse the
 * market or read the docs, and those people never come near the risk. The moment
 * the notice actually needs to be seen is **the moment the device goes on the
 * body**, which is also the moment it is most likely to be read carefully.
 *
 * The user agreement in the registration flow is the other landing spot (see
 * AccountDialog), but accounts are optional, so putting it only there means people
 * who never register never see it. Both places use the same body text.
 *
 * When the user declines instead of confirming, **actively stop the output**:
 * getting this far means a device is already connected, and the user has explicitly
 * said they do not accept the risk yet. Better to stop once too often here.
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
        // A device is connected and the user does not accept the risk — stop, then close.
        void stopAllDevices();
        setDismissed(true);
        setShow(false);
      }}
    />
  );
}
