---
"@dg-kit/protocol": patch
---

Clamp the 47L12x-family indicator LED color byte to the documented 0-7 discrete enum (0=off, 1=yellow, 2=red, 3=purple, 4=blue, 5=cyan, 6=green, 7=white) in `paw-prints.setLedSolid`/`setLedBlink`, `civet-edging.setIndicatorColor`/`startPressureReporting`/`stopPressureReporting`, and `opossum.setLed`. Previously these accepted any 0-255 byte with no defined meaning past 7, which let a naive 0-255 color picker (or a malformed remote-control message) send an undefined value to real hardware.
