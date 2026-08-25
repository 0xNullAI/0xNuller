# 0xNuller Video

Video 是主站中的短时视觉解释模块，使用「软件设置 → AI → 文本模型」中的现有配置。

## 行为

- 用户显式开启前置或后置摄像头，页面提供实时本地预览。
- 可手动采集，或以 10、15、30 秒间隔自动采样。
- 一次解释会话最多 3 步、90 秒，请求之间至少间隔 10 秒。
- 仅允许一个模型请求在途；期间的新帧会替换待处理旧帧。
- 切换模块、隐藏页面、卸载或刷新会关闭摄像头并停止会话。
- 模型工具列表为空，不能连接或控制设备。
- 图片不写入存储、同步、导出、对话历史或日志；说明文字也只存在于当前页面内存。

摄像头在网页中需要 HTTPS 或 localhost。Android 壳继续通过原生桥请求 `CAMERA` 权限。

## 结构

```text
src/App.tsx                         Video 界面与只读 LLM 调用
src/hooks/use-camera-preview.ts     浏览器采集和生命周期
src/services/camera-frame.ts        单帧压缩与大小限制
src/services/visual-session.ts      有界调度、暂停与丢帧策略
apps/web/src/modules/video.tsx      统一外壳入口
```

Video 不依赖任何产品 app；模型输入合同与 provider 适配位于 `packages/agent`。
