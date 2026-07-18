---
"@dg-kit/protocol": patch
---

Fix Coyote V3 devices failing to respond after an official-app firmware update. Devices now receive the same connect-time handshake the official app sends (init packet on the write characteristic, best-effort subscription to legacy/OTA notify channels, MTU bump to 140) before normal B0/BF control writes begin. Adds an optional `requestMTU` hook to `BluetoothRemoteGATTServerLike` for transports that support MTU negotiation.
