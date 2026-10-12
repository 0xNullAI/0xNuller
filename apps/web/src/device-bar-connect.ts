export interface DeviceBarConnectInput {
  narrow: boolean;
  /** A phone-width conversation page (Agent or Chat) is open. */
  conversationDetail: boolean;
  /** The module that currently holds the device lease, or null when none does. */
  leaseModuleId: string | null;
}

/**
 * Decides whether the shell device bar shows the active module's "connect" button.
 *
 * Every module shares the app's one DG-Lab registry: a Coyote connected on 设备 is
 * the same device the AI chat, games and rooms see, and any module's connect opens
 * the same picker. Inside the shell an AI chat has no in-module connect button, so
 * an Agent lease always gets this one; that keeps "connect a device for this chat"
 * one tap away without a trip to 设备.
 *
 * Elsewhere the button stays a phone-only shortcut: on wide screens the 设备
 * entry is one click away, and an otherwise empty row would cost every page.
 * This only exposes the user's explicit connect action; execution still goes
 * through the lease, conversation grant and safety chain. Disconnect is not
 * decided here: only the 设备 page offers it (see DeviceBar).
 */
export function shouldShowDeviceBarConnect({
  narrow,
  conversationDetail,
  leaseModuleId,
}: DeviceBarConnectInput): boolean {
  if (leaseModuleId === null || leaseModuleId === 'control') return false;
  if (leaseModuleId === 'agent') return true;
  return narrow && !conversationDetail;
}
