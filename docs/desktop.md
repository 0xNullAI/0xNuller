# Windows / macOS 独立版本

Windows x64 安装器与 macOS universal（Apple Silicon + Intel）安装包共用 `android/app`
中的 Tauri 原生宿主和七个模块。目录保留原名是为了保持 Android 构建、签名和升级身份稳定；
不复制 shell、设备协议或权限规则。桌面配置覆盖层为 `tauri.desktop.conf.json`，独立标识为
`ai.nullai.desktop`；Android 仍为 `ai.nullai.dgagent`。

## 系统要求

| 平台    | 要求                                                   | 蓝牙实现                                            |
| ------- | ------------------------------------------------------ | --------------------------------------------------- |
| Windows | Windows 10/11 x64、WebView2 111+、可用 BLE 适配器/驱动 | btleplug → WinRT                                    |
| macOS   | macOS 13.3+；Apple Silicon 或 Intel                    | btleplug → CoreBluetooth                            |
| Android | Android 8+，Android System WebView 111+                | 现有 Tauri Android BLE/JNI                          |
| Web     | Chrome/Edge 111+、Safari 16.4+、Firefox 128+           | 有 Web Bluetooth 的环境可直接连接；否则使用原生版本 |

浏览器能渲染界面不代表支持 Web Bluetooth。应用在启动模块之前检测必要的运行时能力；
过旧环境显示升级提示，不让启动异常留下空白页。共享媒体查询订阅仍保留旧 EventTarget 回退。

## 构建

安装 Node 22.19+、npm 11.6.2 和 Rust 1.88+。Windows 需要 MSVC C++ Build Tools，macOS
需要 Xcode Command Line Tools。应用不在开发启动时自动扫描桌面蓝牙。

```bash
npm ci
npm run desktop:dev

# 在 macOS 上构建本机架构 .app
npm run desktop:build -- --bundles app

# 在 macOS 上构建 Intel + Apple Silicon 通用 DMG
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run desktop:build -- --target universal-apple-darwin --bundles dmg

# 在 Windows 上构建 x64 安装器
npm run desktop:build -- --target x86_64-pc-windows-msvc --bundles nsis
```

前端输出到 `android/app/dist-desktop`，不覆盖 Android 的 `dist`。安装包位于
`android/app/src-tauri/target/<target>/release/bundle/`；未指定 target 时没有 `<target>` 层。
Windows NSIS 安装时检查/安装 WebView2。桌面版本继承产品版本，不拥有独立版本号。

统一 `.github/workflows/ci.yml` 在 product 变更时使用 Windows/macOS runner 构建、运行 Rust
测试并上传安装器。macOS 产物是 universal，Windows 为 x64。PR/dev 仅产生候选制品，不发布。
`Release · 0xNuller` 只取同一成功 CI、同一 main SHA 的两个安装器，在部署前验证文件齐备，
然后附到产品 Release：

- `0xnuller-vX.Y.Z-windows-x64.exe`
- `0xnuller-vX.Y.Z-macos-universal.dmg`

当前构建未配置 Windows Authenticode 或 Apple Developer ID/公证凭据；产物不能宣称为已签名、
已公证的公共发行版。正式对外分发前应配置相应平台签名，并在目标系统检查安装体验。
不得为安装而关闭系统安全保护。Android 原有签名门禁保持不变。

## 蓝牙、权限与关闭

所有桌面模块注入现有 Tauri transport，仍按设备身份区分连接、队列、lease 和安全上限。
macOS 的 Info.plist 包含蓝牙、摄像头与麦克风用途声明；蓝牙权限被拒绝时给出系统设置路径。
Windows 使用系统蓝牙，不请求 Android 定位权限。通用设备仍由“设置 → 关于”本机开关控制，
未启用时不启动 Buttplug；原生扫描互斥继续由 ScanCoordinator 管理。

窗口失去焦点时撤销设备控制权并请求停止；返回不会自动恢复 lease 或输出，需要用户继续操作。
关闭/退出请求先被原生侧拦截，前端等待所有设备停止确认，再请求原生端确认 Buttplug 停止和
扫描结束后退出。失败时保留窗口和停止失败反馈。强制杀进程、系统断电等不可拦截事件不在此保证内。

桌面 API 使用既有 native Bearer 认证。后端允许列表明确增加 `tauri://localhost` 和
`https://tauri.localhost`，保留 Android 的 `http://tauri.localhost`；账户、票据、权限和额度检查
没有绕过。新允许列表要随正常后端发布生效，本地改动不会自动改变线上配置。

## 验收

构建成功与真实设备验证分别报告：

1. 两个平台各验证安装、启动、账户登录、模块切换与窗口缩放。
2. 验证蓝牙关闭、无适配器、拒绝授权、撤销授权后重新尝试的反馈。
3. 验证每种受支持设备的选择、连接、通知、停止、断连及多设备隔离。
4. 验证切后台、最小化、锁屏、正常退出；模拟停止失败时窗口不能宣称成功或自动退出。
5. 单独启用通用设备开关，验证 scanner 互斥及关闭开关后的撤销。
6. 验证摄像头、麦克风仅在用户启动对应功能时请求权限。

在开发机器上完成构建和模拟测试，不能替代 Windows/macOS 实机蓝牙与锁屏验收。
