# 维护者文档索引

本目录分为“当前规范”和“历史快照”。修改代码时只以当前规范、根 `AGENTS.md` 和目标包内
README 为准；`docs/legacy` 只用于考古，不能覆盖现行行为。

## 当前规范

| 主题           | 文档                                                         | 何时阅读                             |
| -------------- | ------------------------------------------------------------ | ------------------------------------ |
| 代码分层与归属 | [architecture.md](architecture.md)                           | 新增共享逻辑、移动模块、评审依赖方向 |
| 测试分层       | [testing.md](testing.md)                                     | 本地迭代、PR affected、主干全量验证  |
| 部署           | [deploy.md](deploy.md)                                       | Worker、D1/R2/DO、回滚和生产前检查   |
| 平台运维       | [platform-operations-audit.md](platform-operations-audit.md) | 邮箱、观测、smoke 与 npm 发布状态    |
| Product 发布   | [platform-release.md](platform-release.md)                   | `dev -> main`、版本与 Release        |
| Android 发布   | [android-release.md](android-release.md)                     | APK、签名和产物验证                  |
| Agent 架构     | [agent-architecture.md](agent-architecture.md)               | Runtime、Provider、工具和浏览器组合  |

发布切换记录与数据迁移文档描述仍在运行的兼容约束，但不是日常代码归属规范。版本说明位于
`docs/releases/`。

## 文档维护规则

- 行为、命令或责任边界变化时，同一提交更新对应当前文档和最近的包 README。
- 可执行约束优先落入 lint、架构检查、测试或发布脚本；文档解释原因和使用方式。
- 新文档必须从本索引或相关包 README 可达，避免形成无人发现的孤立说明。
- 历史内容保留在 [`legacy/`](legacy/README.md)，不在功能改动中修补或重新解释。
