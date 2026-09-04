# 维护者文档索引

本目录只保留当前规范。修改代码时以根 `AGENTS.md`、本索引和目标包 README 为准。

## 当前规范

| 主题           | 文档                                           | 何时阅读                             |
| -------------- | ---------------------------------------------- | ------------------------------------ |
| 代码分层与归属 | [architecture.md](architecture.md)             | 新增共享逻辑、移动模块、评审依赖方向 |
| 测试分层       | [testing.md](testing.md)                       | 本地迭代、PR affected、主干全量验证  |
| 部署           | [deploy.md](deploy.md)                         | Worker、D1/R2/DO、回滚和生产前检查   |
| Product 发布   | [platform-release.md](platform-release.md)     | `dev -> main`、版本与 Release        |
| Android 发布   | [android-release.md](android-release.md)       | APK、签名和产物验证                  |
| 桌面版本       | [desktop.md](desktop.md)                       | Windows/macOS 构建、蓝牙、权限及验收 |
| Agent 架构     | [agent-architecture.md](agent-architecture.md) | Runtime、Provider、工具和浏览器组合  |

用户操作放在产品内置帮助和对应 app README；版本说明位于 `docs/releases/`。迁移、运维和发布
约束直接维护在对应的现行文档中，不再另建过程记录。

## 文档维护规则

- 行为、命令或责任边界变化时，同一提交更新对应当前文档和最近的包 README。
- 可执行约束优先落入 lint、架构检查、测试或发布脚本；文档解释原因和使用方式。
- 新文档必须从本索引或相关包 README 可达，避免形成无人发现的孤立说明。
- 过时过程文档直接删除；需要追溯时使用 Git 历史，不在当前文档树保留快照。
