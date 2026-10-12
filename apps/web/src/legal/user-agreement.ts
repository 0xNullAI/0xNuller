import { SAFETY_NOTICE_SECTIONS } from '@dg-kit/safety';
import { LEGAL_TERMS_VERSION } from '@0xnullai/auth/legal';

/**
 * 用户协议 — deliberately short: the shared device-safety notice plus a few rules of use. The
 * safety sections come from @dg-kit/safety so the agreement and the in-app notice never drift.
 * Bump LEGAL_TERMS_VERSION on any substantive change.
 *
 * Format: the small Markdown subset rendered by legal-markdown.tsx.
 */
const safety = SAFETY_NOTICE_SECTIONS.map(
  (section) => `## ${section.title}\n\n${section.items.map((item) => `- ${item}`).join('\n')}`,
).join('\n\n');

export const USER_AGREEMENT_MARKDOWN = `版本：${LEGAL_TERMS_VERSION}

**注册即表示你已年满 18 周岁，并同意以下内容。** 猫愿会控制对人体产生真实输出的设备，请认真阅读。

${safety}

## 设备与 AI

- 本服务及连接的设备不是医疗器械，不能用于任何医疗用途。
- AI 不是安全控制器。模型、蓝牙、网络和远程连接都可能出错或断开，请始终能立刻停止输出、断开设备。
- AI 角色不是真人，回复由人工智能生成，可能不准确，不构成任何专业建议。

## 使用规范

- 仅限成年人使用。对他人使用设备前，必须取得对方事先明确、自愿的同意，对方可随时撤回。
- 不得发布或生成涉及未成年人、违法、骚扰他人或侵犯他人隐私的内容。
- 违反以上规定的，我们可以删除内容、限制功能或终止账户。
- 你可以随时在「我的 → 账户」注销账户。
`;
