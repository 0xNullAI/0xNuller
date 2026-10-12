# 维护者文档索引

本目录只保留当前规范。修改代码时以根 `AGENTS.md`、本索引和目标包 README 为准。

## 当前规范

| 主题           | 文档                                           | 何时阅读                             |
| -------------- | ---------------------------------------------- | ------------------------------------ |
| 代码分层与归属 | [architecture.md](architecture.md)             | 新增共享逻辑、移动模块、评审依赖方向 |
| 测试分层       | [testing.md](testing.md)                       | 本地迭代、PR affected、主干全量验证  |
| 部署           | [deploy.md](deploy.md)                         | Worker、D1/R2/DO、回滚和生产前检查   |
| 聊天备份       | [chat-backup.md](chat-backup.md)               | 加密导出与校验基础设施、完整备份缺口 |
| Product 发布   | [platform-release.md](platform-release.md)     | `dev -> main`、版本与 Release        |
| Android 发布   | [android-release.md](android-release.md)       | APK、签名和产物验证                  |
| Agent 架构     | [agent-architecture.md](agent-architecture.md) | Runtime、Provider、工具和浏览器组合  |
| LLM 与 Credit  | [llm-credit-plan.md](llm-credit-plan.md)       | 官方模型、BYOK、计费与破坏性升级     |

用户操作放在产品内置帮助和对应 app README；版本说明位于 `docs/releases/`。迁移、运维和发布
约束直接维护在对应的现行文档中，不再另建过程记录。

## 待实施提案

- [陪伴平台重构 Handoff](companion-handoff.md)：当前工作树、已知验证、代码整理、阶段提交与剩余验收的接手入口。
- [跨平台、多窗口 App 重构计划](cross-platform-app-redesign-plan.md)：新版外壳、全站页面层级、自适应窗口、多窗口状态和分阶段验收。
- [网站统一聊天与角色平台执行计划](companion-platform-final-plan.md)：以最新确定的产品边界为准，列出全部需求、分批交付和验收门槛。
- [AI 陪伴与角色社区重构提案](companion-platform-plan.md)：角色、关系记忆、统一聊天、主动消息、社区与商业化的总体路线，以及 develop 首批增量；不替代上方现行规范。
- [媒体与计费整合审计](media-integration-audit.md)：Voice、Video、模型代理与 Credit 的现有调用链、故障边界和整合顺序。
- [统一聊天、视频与媒体交付设计](unified-conversation-video-design.md)：共享时间线、附件、摄像头/实时语音/视频任务的状态与并行验收。
- [角色卡研究与首批实现](character-card-research.md)：外部卡片格式、许可筛选、原创模板和私人记忆边界。
- [角色卡与在线编辑器设计](character-editor-design.md)：共享卡、个人实体、在线创作、外部导入、记忆分层与分批验收。
- [真人社群整合审计](community-integration-audit.md)：复用 Chat、Market 和管理入口，逐步加入角色、记忆和多模态能力。
- [私人记忆检索评测](memory-evaluation.md)：匿名中文跨会话问题、D1 基线、隔离/删除验证与 Mem0 选型门槛。

## 文档维护规则

- 行为、命令或责任边界变化时，同一提交更新对应当前文档和最近的包 README。
- 可执行约束优先落入 lint、架构检查、测试或发布脚本；文档解释原因和使用方式。
- 新文档必须从本索引或相关包 README 可达，避免形成无人发现的孤立说明。
- 过时过程文档直接删除；需要追溯时使用 Git 历史，不在当前文档树保留快照。
