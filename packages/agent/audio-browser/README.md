# @dg-agent/audio-browser

浏览器原生（Web Speech）语音识别与语音合成适配器，并提供空实现供不支持音频的环境安全降级。
自带 API Key 的用户只使用文字；托管语音服务不在本包内。

```ts
import { createSpeechSynthesizer } from '@dg-agent/audio-browser';
```

本包不负责账户、UI 或设备控制。
