import type { DiscoveredDevice } from '@dg-kit/transport-tauri-blec';
import './DevicePicker.css';

interface Props {
  open: boolean;
  devices: DiscoveredDevice[];
  scanning: boolean;
  onSelect: (address: string) => void;
  onCancel: () => void;
}

export function DevicePicker({ open, devices, scanning, onSelect, onCancel }: Props) {
  if (!open) return null;
  return (
    <div
      className="dgaa-picker-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dgaa-picker-title"
    >
      <div className="dgaa-picker-panel">
        <header className="dgaa-picker-header">
          <span className="dgaa-picker-mark" aria-hidden="true">
            ⌁
          </span>
          <span className="dgaa-picker-heading">
            <strong id="dgaa-picker-title">连接设备</strong>
            <small>{scanning ? '正在搜索附近的 DG-Lab 设备' : '选择设备并建立蓝牙连接'}</small>
          </span>
          <button className="dgaa-picker-close" type="button" aria-label="关闭" onClick={onCancel}>
            ×
          </button>
        </header>
        <ul className="dgaa-picker-list">
          {devices.length === 0 ? (
            <li className="dgaa-picker-empty" aria-live="polite">
              {scanning
                ? '正在扫描…'
                : '没有发现可连接设备。请确认设备未连接其他手机或电脑，并已进入配对状态。'}
            </li>
          ) : (
            devices.map((d) => (
              <li className="dgaa-picker-row" key={d.address}>
                <span className="dgaa-picker-info">
                  <span className="dgaa-picker-name">{d.name || 'DG-Lab 设备'}</span>
                  <span className="dgaa-picker-meta">
                    {d.address} · RSSI {d.rssi}
                  </span>
                </span>
                <button
                  className="dgaa-picker-connect"
                  type="button"
                  onClick={() => onSelect(d.address)}
                >
                  连接
                </button>
              </li>
            ))
          )}
        </ul>
        <footer className="dgaa-picker-footer">
          <span className="dgaa-picker-hint">仅显示 0xNuller 支持的设备</span>
          <button className="dgaa-picker-cancel" type="button" onClick={onCancel}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
