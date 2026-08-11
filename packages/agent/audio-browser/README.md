# @dg-agent/audio-browser

浏览器语音识别与语音合成适配器，支持浏览器原生能力和 DashScope 代理模式，并提供空实现供
不支持音频的环境安全降级。

```ts
import { createSpeechSynthesizer } from '@dg-agent/audio-browser';
```

API Key 由调用方提供，本包不负责账户、UI 或设备控制。
