# Android third-party notices

The default-off experimental embedded device backend adds the following locked dependencies.
Only the btleplug hardware manager is compiled; websocket, serial, HID, XInput, and remote-service
managers are not included. Versions and checksums are authoritative in
[`src-tauri/Cargo.lock`](./src-tauri/Cargo.lock).

| Component                                                                  | Locked version | License                           | Source                                   |
| -------------------------------------------------------------------------- | -------------: | --------------------------------- | ---------------------------------------- |
| Buttplug client, core, in-process client, server, and BLE hardware manager |         10.0.3 | BSD-3-Clause                      | <https://github.com/buttplugio/buttplug> |
| Buttplug server device configuration                                       |         10.1.0 | BSD-3-Clause                      | <https://github.com/buttplugio/buttplug> |
| btleplug, including its vendored Android Java/jni-utils sources            |         0.12.0 | MIT OR Apache-2.0 OR BSD-3-Clause | <https://github.com/deviceplug/btleplug> |

## Buttplug BSD-3-Clause notice

Copyright 2016-2026 Nonpolynomial Labs LLC. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted
provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions
   and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of
   conditions and the following disclaimer in the documentation and/or other materials provided
   with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse
   or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS “AS IS” AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER
IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT
OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## btleplug notice

Copyright 2020-2021 Nonpolynomial. All rights reserved.

btleplug is distributed under MIT, Apache-2.0, and BSD-3-Clause terms. Its complete license text is
included at [`licenses/btleplug-0.12.0-LICENSE.md`](./licenses/btleplug-0.12.0-LICENSE.md) and copied
into the APK assets together with this notice. The Android preparation step copies only the locked
package's Java source tree; it does not download or substitute Java artifacts from Maven.
