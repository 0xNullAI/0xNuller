import {
  RegistryCoyoteClient,
  RegistryOpossumClient,
  type DgLabConnectionRegistry,
  type DgLabModuleHandle,
} from '@0xnullai/device-runtime';
import {
  createBrowserVideoControl,
  type BrowserVideoControlOptions,
  type BrowserVideoControlService,
} from '@dg-agent/agent-browser';

/** The lease id the shell grants while Video is the visible module. */
export const VIDEO_DGLAB_MODULE_ID = 'video';

export type RegistryVideoControlOptions = Omit<
  BrowserVideoControlOptions,
  'device' | 'opossum' | 'connectOutputDevice'
>;

export interface RegistryVideoControl {
  readonly service: BrowserVideoControlService;
  readonly handle: DgLabModuleHandle;
}

export interface RegistryVideoControlEvents {
  /** The connected Coyote/Opossum set changed. The runtime grant is already revoked. */
  onTopologyChange: () => void;
  /** Video lost the lease. The registry has already stopped every output. */
  onRevoked: () => void;
  /** The device-loss stop of the authorized target could not be confirmed. */
  onStopError?: (error: unknown) => void;
}

/**
 * Video's control service on the shared DG-Lab registry.
 *
 * Video holds no BLE link of its own: a Coyote or Opossum connected by any module is a Video
 * target, and every write goes through the registry handle, so the lease fence and the holder
 * re-clamp apply to it.
 */
export function createRegistryVideoControl(
  registry: Pick<DgLabConnectionRegistry, 'forModule'>,
  options: RegistryVideoControlOptions,
): RegistryVideoControl {
  const handle = registry.forModule(VIDEO_DGLAB_MODULE_ID);
  const service = createBrowserVideoControl({
    ...options,
    device: new RegistryCoyoteClient(handle),
    opossum: new RegistryOpossumClient(handle),
    connectOutputDevice: () => handle.connect(),
  });
  return { service, handle };
}

/**
 * Revoke Video's grant when the output target set changes, and forward lease loss.
 *
 * Another module can connect or drop a shared device at any time. A grant issued against the
 * old set must not survive it, so any added or removed output id revokes it. State-only updates
 * (strength, battery) do not. When no grant is active nothing is stopped here: stops are not
 * lease-gated, and Video must not zero a device that another module is driving.
 */
export function bindRegistryVideoControl(
  { service, handle }: RegistryVideoControl,
  events: RegistryVideoControlEvents,
): () => void {
  let targetSet = outputTargetSet(handle);
  const unsubscribeTopology = handle.subscribe(() => {
    const next = outputTargetSet(handle);
    if (next === targetSet) return;
    targetSet = next;
    const grant = service.getGrant();
    if (grant && !grant.revoked) {
      void service.stop('device-loss').catch((error: unknown) => events.onStopError?.(error));
    }
    events.onTopologyChange();
  });
  const unsubscribeRevoked = handle.onRevoked(() => events.onRevoked());
  return () => {
    unsubscribeTopology();
    unsubscribeRevoked();
  };
}

function outputTargetSet(handle: DgLabModuleHandle): string {
  return handle
    .list()
    .filter((device) => device.connected && (device.kind === 'coyote' || device.kind === 'opossum'))
    .map((device) => device.id)
    .sort()
    .join('\n');
}
