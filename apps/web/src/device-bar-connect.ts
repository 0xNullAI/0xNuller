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
 * Every module owns its own BLE connection: a Coyote connected on 设备 belongs to
 * the Control session, and the Agent runtime cannot see or drive it. Inside the
 * shell this bar is the only place an AI chat can connect its own device (the
 * Agent panel hides its in-module connect buttons there). Hiding it in AI chats
 * left the AI with no device tools at all, so an Agent lease always gets it.
 *
 * Elsewhere the button stays a phone-only shortcut: on wide screens the 设备
 * entry is one click away, and an otherwise empty row would cost every page.
 * This only exposes the user's explicit connect action; execution still goes
 * through the lease, conversation grant and safety chain.
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
