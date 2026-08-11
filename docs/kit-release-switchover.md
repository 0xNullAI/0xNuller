# Kit 发布切换：从旧 DG-Kit 仓切到本仓

一次性操作。做完之后 `@dg-kit/*` 的发布权唯一地属于本仓。

## 现状

- npm 上六个包是 1.13.0，与本仓一致；`@dg-kit/safety` 从未发布（changeset 已备好）
- 本仓 `release.yml` 处于解除武装状态（仅 workflow_dispatch）
- **旧 DG-Kit 仓的 release.yml 仍然武装**——push 即 npm publish。两边同时能发会撞车，
  所以必须先关旧的，再开新的，顺序不能反

## 你要做的（按顺序）

1. **关旧仓自动化**：旧 DG-Kit 仓 → Settings → Actions → Disable actions。
   （或者删掉它的 `.github/workflows/release.yml`——但 Disable 可逆，优先。）
2. **确认 npm token**：本仓 Secrets 里的 `NPM_TOKEN` 必须是 **Automation** 类型
   （不是 Publish 类型——那种会因为要 OTP 而报 EOTP；E404 则说明 token 失效要轮换）。
3. **跑一次发布**：本仓 → Actions → Release → Run workflow（分支选 `dev`）。
   changesets 会开一个 "Version Packages" PR，合并它到 dev、再 sync 到 main，
   main 上的 run 执行真正的 `changeset publish`。
4. **验证**：`npm view @dg-kit/safety version` 出现 1.14.0（或 changesets 算出的号）。
   注意 release job 可能因 E409 registry 竞态**标红但实际全部发布成功**——
   先 `npm view` 核实再考虑重跑。

## 之后

- 恢复 `release.yml` 里被注释的 push 触发（文件里有标注），发布回到全自动
- 这是九个旧仓下线的第一步；其余仓照 `docs/deploy.md` 的下线顺序走
