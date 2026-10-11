---
'@dg-kit/protocol': patch
'@dg-kit/transport-webbluetooth': patch
---

Read the Coyote/47L12x battery level from the standard Battery Service (0x180F/0x2A19) or, when that is absent, the 0x180A/0x1500 pair from DG-Lab's V3 protocol document; both services are requested for Web Bluetooth. A level that cannot be read stays unknown instead of showing 0%.
