# 安全策略与漏洞披露

> 定位:GoTry 仓库的漏洞上报通道、triage 纪律、安全相关进出事件的历史记录。外部 PR(含自动化扫描机器人)的 triage / 裁定规则在 [`external-pr-workflow.md`](external-pr-workflow.md),本文档引用而非复制。
> 状态:living
> 上游:[`AGENTS.md`](../../AGENTS.md)(仓库合同)、[`external-pr-workflow.md`](external-pr-workflow.md)(T0-T5)、[`tokens.md`](../tokens.md)(npm 2FA / 发布机制)
> 下游:外部安全研究员、自动化扫描器(semgrep 系列等)、处理安全 PR 的维护者、CHANGELOG / release-notes 人写决策面
> 最后更新:2026-09-11

## 1. 漏洞上报

- **首选通道**:Danceiny/gotry 仓库的 GitHub Security Advisories(私密披露;维护者与 triage agent 在公开 issue 不可见细节的情况下被通知)。
- **需附内容**:最小可复现片段或 commit 引用;受影响的版本(用 `npm view @danceiny/gotry versions` 输出或对应 `git rev-parse HEAD`);期望 vs 实际行为;影响评估。不泄露私有用户数据的日志、会话轨迹与截图欢迎附上。
- **应排除**:任何用户 `gotry-state/` 目录下的真实用户数据;任何上游(FlyAI、hbcli、dida、OpenAI 兼容中转)的现役凭证;可能携带上报者个人数据的自动化扫描器私密告警原文。上报者应在分享前做脱敏。

## 2. Triage 纪律

[`external-pr-workflow.md` §1-§6](external-pr-workflow.md) 的 T0-T5 阶段同时适用于进站安全报告与进站安全 PR。具体:

- **T0 来源分类**——人类、自动化扫描机器人(semgrep 系列、Dependabot、AI agent 生成)、疑似垃圾各带默认立场。机器人报告不视作普通贡献:T2 阶段先按源码逐行证伪或确认其结论,再考虑代码改动。
- **T1 供应链预检(硬闸)**——任何触动 `.github/`、依赖清单、构建/发布链,或引入新网络出口/子进程执行的 diff,直接一票否决。
- **T2 声明核实**——安全声明按源码逐行证伪或确认。[`external-pr-workflow.md` §3](external-pr-workflow.md) §3 收录的"已确认为误报"模式是常驻参考。
- **T3 评审与测试**——维护者代跑外部贡献者拿不出的本地证据。纯文档改按 PR 模板 N/A + burden-of-proof 处理。
- **T4 裁定**——三选项:merge / request changes / close。founder 拍板可覆盖默认结论(例 #250——见 §3.1)。
- **T5 归档**——裁定记录在 PR 评论;本文档仅在新误报模式或新预检规则出现时更新对应条目。

## 3. 安全事件历史(append-only)

本节 append-only;条目按时间倒序追加。每条记录 issue / PR、声明、核实结论、裁定。已记录条目不再修改。

### 3.1 — #250 SQL 注入模板字面量误报(2026-09-08,自动化扫描)

- **来源**:外部 PR 由 `anupamme` 提交,由 OrbisAI Security(自动化机器人)生成。
- **声明**:`ts/src/state-ledger.ts` 的 `readEvents()` 与 `deleteEvents()` 经模板字面量把动态值拼入 SQL——被标 `utils.custom.sql-injection-template-literal`。
- **T2 核实**:`readEvents()` 的拼接是**编译期常量分支选择器**(`WHERE tenant_id = ? AND kind = ?` vs `WHERE tenant_id = ?`);所有动态值通过 better-sqlite3 的 `prepare().all()/run()` 走 `?` 占位符绑定。`deleteEvents()` 的拼接是 `IN (${placeholders})`,其中 `placeholders = s.kinds.map(() => '?').join(',')`——这是标准的参数化绑定形式,本身就是该规则应当推荐的注入防御。两种模式均收入 [`external-pr-workflow.md` §3](external-pr-workflow.md) §3 作为常驻误报参考。
- **T4 裁定**:founder 拍板按"防御性加固"合入而非关闭(默认是关闭)。改动把 `readEvents()` 的静态分支拆为两次显式 `prepare(...).all(...)` 调用,把 `deleteEvents()` 的占位符拼接改写为 `+` 字符串拼接(注释等价)。两次编辑与原代码功能完全一致;合入记录了"误报裁定",作为本条的依据。
- **状态**:2026-09-09 通过 `028ddaa7`("Merge pull request #250")合入 `main`。本裁定对相同扫描器模式对相同目标建立了常驻规则:**未来再次出现同模式直接关闭,并引用本 PR 号**。
- **审计线索**:PR #250(评论)、commit `028ddaa`、原始 commit `700b963`。未申请 CVE(误报);未发布 security advisory。

### 3.2 — Dependabot qs 升级(2026-09-09)

- **来源**:Dependabot 例行升级。`qs` 6.16.0 经 `pnpm-lock.yaml` + `ts/dsh-runtime/pnpm-lock.yaml`。
- **T2 核实**:已读上游 `qs` changelog;semver 兼容;`engines` 约束不变。
- **T4 裁定**:作为例行依赖维护合入。在 `CHANGELOG.md` 0.0.1-rc.21 段有记录。

## 4. 已披露漏洞

截至 2026-09-11,本仓库无 CVE 申请或 security-advisory 披露的漏洞。§3 已记录事件均为误报确认或例行依赖升级。

## 5. 出站安全责任

- **npm 发布 2FA**:每个发布版本均经 GitHub 或 npm 侧 2FA 闸;founder 在发布时浏览器 approve。按 [`tokens.md`](../tokens.md) §2 文档化的 npm 403/405 行为,**显式规避** granular bypass token。无任何已发布版本绕过此闸。
- **Web Store 上架**:Session Bridge 扩展的隐私姿态见 [`extension-privacy.md`](extension-privacy.md)。上架机制见 [`extension-webstore-submission.md`](extension-webstore-submission.md)。
- **外部 PR 工作流**:任何安全相关的外部 PR 一律走 [`external-pr-workflow.md`](external-pr-workflow.md) T0-T5 阶段;无捷径。
