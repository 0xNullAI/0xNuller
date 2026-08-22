---
'@dg-kit/protocol': patch
---

⚠️ **Bug fix — Coyote V2 byte order.**

The Coyote 2.0 (D-LAB ESTIM) wire format is little-endian for the 3-byte
strength packet (1504) and the 3-byte waveform packets (1505/1506), but the
adapters previously emitted big-endian bytes. On real hardware a single
channel read as effectively silent while dual-channel output spiked near full
power — neither matches the requested strength.

Both encoders now send least-significant byte first, and strength
notifications are parsed with the same little-endian layout. If you were
working around the old byte order, remove that workaround after upgrading:
the wire bytes now match the device. Verified on a real Coyote 2.0 device.
