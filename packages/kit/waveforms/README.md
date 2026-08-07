# @dg-kit/waveforms

Runtime-agnostic waveform helpers for DG-Lab Coyote.

## What's inside

- **`createBasicWaveformLibrary()`** — six built-in waveforms (`breath`, `tide`, `pulse_low`, `pulse_mid`, `pulse_high`, `tap`) implementing the `WaveformLibrary` interface.
- **`compileWaveformDesign(segments)`** — takes a list of `ramp` / `hold` / `pulse` / `silence` segments and produces a `WaveFrame[]` on a 25 ms grid. Used by the `design_wave` LLM tool.
- **`parsePulseText(content)`** — parses a single `.pulse` file (DG-Lab's "Dungeonlab+pulse:" text format) and returns frames + the embedded display name.

This package has zero browser/Node-only dependencies. Storage (IndexedDB on the web, JSON file on Node) lives in consumer-specific packages — this one only deals with the in-memory shape.

## Frame grid

Every `WaveFrame` represents 25 ms. The Coyote 3.0 protocol packs four frames into each 100 ms BLE write; the Coyote 2.0 protocol consumes one frame per 100 ms tick (with precision loss). Designing on a 25 ms grid keeps the data lossless and lets the protocol layer pick the right packing.
