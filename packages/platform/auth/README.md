# @0xnullai/auth

统一账户客户端，支持注册、登录、邮箱验证、找回密码、资料、头像/相册、联系人、私聊票据、
房间同步、AI 用量和管理员汇总。

```ts
import { login, me, subscribeAuthChanges } from '@0xnullai/auth';
```

网页使用 HttpOnly Cookie，Android 使用 Bearer Token；本包不提供任何设备控制接口。
