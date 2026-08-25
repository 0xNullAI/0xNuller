# 0xNuller Control

[中文](README.md) | English

Direct control for connected DG-Lab devices without a room, voice session, or AI in the loop.

## Features

- One top device bar for Coyote, paw-prints, civet-edging, and Opossum devices.
- Independent selection and control of multiple Coyotes.
- Strength, waveform, Opossum feedback, indicator color, and emergency stop controls.
- Shared custom waveforms, playback queues, and Market waveform import.
- A collapsed momentary-fire section that stays out of the primary controls until needed.

Control reuses the shared device session, command queue, and application-wide safety settings. Moving
to another module stops output and transfers the device lease without silently dropping Bluetooth.

## Develop

```bash
npm install
npm run dev -w @0xnullai/web
npm test
npm run typecheck
npm run build -w @0xnullai/web
```

## Layout

```text
src/App.tsx                 device session, lease, and screen composition
src/components/            Coyote, waveform, Opossum, and sensor UI
src/hooks/                 playback and momentary-fire behavior
@0xnullai/device-runtime    shared state contracts and summaries for the global device bar
```

## License

[MIT](../../LICENSE)
