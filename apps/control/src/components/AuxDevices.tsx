import { OpossumControl } from '../../../chat/src/components/OpossumControl';
import { SensorCard } from '../../../chat/src/components/SensorCard';
import type { OpossumSummary, SensorSummary } from '../../../chat/src/lib/bluetooth';

interface AuxDevicesProps {
  sensor: SensorSummary | null;
  opossum: OpossumSummary | null;
  /**
   * The Opossum's own caps (maxIntensityA/B from device-safety), not the
   * Coyote's. `setOpossumIntensity` clamps against exactly these, so showing
   * the Coyote's numbers here would put a limit on screen that is not the limit
   * being enforced — the ring would fill to a maximum the device never reaches.
   */
  opossumLimitA: number;
  opossumLimitB: number;
  onOpossumAdjust: (channel: 'A' | 'B', delta: number) => void;
  onOpossumBurst: (channel: 'A' | 'B', strength: number, durationMs: number) => void;
  onOpossumStop: () => void;
  onSetLedColor: (target: 'sensor' | 'opossum', color: number) => void;
}

/**
 * Section three: everything that is not the Coyote.
 *
 * It renders nothing at all when neither is attached — an empty "auxiliary
 * devices" heading on a screen designed for one-handed use is a row of pixels
 * pushing the controls that matter further down.
 *
 * The sensor stays read-only. Letting a sensor reading drive an output is a
 * separate feature that needs a consent UI which does not exist yet; showing
 * the telemetry is useful on its own, quietly wiring it to the Coyote would
 * not be.
 */
export function AuxDevices({
  sensor,
  opossum,
  opossumLimitA,
  opossumLimitB,
  onOpossumAdjust,
  onOpossumBurst,
  onOpossumStop,
  onSetLedColor,
}: AuxDevicesProps) {
  if (!sensor?.connected && !opossum?.connected) return null;

  return (
    <section>
      <h2 className="mb-1 text-xs font-medium tracking-wide text-[var(--text-faint)]">其他设备</h2>

      {sensor && (
        <SensorCard
          kind={sensor.kind}
          connected={sensor.connected}
          battery={sensor.battery}
          lastEvent={sensor.lastEvent}
          lastValue={sensor.lastValue}
          lastEventAt={sensor.lastEventAt}
          onPickLedColor={(color) => onSetLedColor('sensor', color)}
        />
      )}

      {opossum && (
        <OpossumControl
          connected={opossum.connected}
          battery={opossum.battery}
          intensityA={opossum.intensityA}
          intensityB={opossum.intensityB}
          limitA={opossumLimitA}
          limitB={opossumLimitB}
          onAdjust={onOpossumAdjust}
          onBurst={onOpossumBurst}
          onStop={onOpossumStop}
          onPickLedColor={(color) => onSetLedColor('opossum', color)}
        />
      )}
    </section>
  );
}
