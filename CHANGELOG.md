# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1-rc.17] - 2026-09-02

### Added

- harden copilot runtime identity… (#92)
- add embedded copilot contract and runtime proofs… (15147f9)
- freeze cadence admission policy… (91342f7)
- establish deterministic evaluation contracts… (4db8c8f)
- 安装指引 GitHub Releases 优先(needs-extension/wizard/setup/README 双语)… (#80)
- add auditable static golden provider (#67)… (#81)
- 扩展产物分发双通道(GitHub Releases 下载通道 + Web Store 上架材料… (#72)

### Fixed

- GoTry Session Bridge Chrome Web Store 上架后扩展安装 UX 职责返交(wizard 缩为 2 步纯 Node,needs-extension 走 verdict.installUrl 接入 dsh UI… (e5f7021)
- isolate benchmark startup composition… (#95)
- add a fail-closed benchmark environment bridge… (#89)
- close timeout budget and error boundaries… (de3d727)
- use monotonic weather budgets and calendar guards… (da4ee92)
- close weather input and budget edge cases… (541eb90)
- close release peer and session smoke gates… (3cb5f59)
- classify benchmark terminal failures safely… (c61600b)
- keep the root pnpm closure coherent… (26a445b)
- freeze the full DSH prerelease closure… (752e54c)
- make bound-turn runtime releasable… (ecc1370)
- make benchmark headless failures deterministic… (a1563d4)
- bind v2 offer versions and replay… (6ef8aff)
- isolate benchmark startup composition… (5ebddb2)
- harden v2 ingress replay boundary… (bee9114)
- enforce benchmark agent output conformance… (4285296)
- isolate benchmark agents to the exact bridge… (ab725ef)
- spawn stdout 改临时文件重定向,修掉 ~7.6KB 截断… (#91)
- align plugin smoke with dsh alpha runtime… (96d7ccb)
- close dsh runtime peer closure… (bfb7664)
- close canonical and alpha dependency gates… (72b96ee)
- enforce benchmark visible-output contracts… (db8e34c)
- add a fail-closed benchmark environment bridge… (2816d4b)
- bound tool loops to preserve planner liveness… (0f22f91)
- LLM_MODEL 接通 dsh 会话面——严格中转型端点不再落空… (#83)
- npm 形态自定义 OpenAI 兼容端点——bin env 映射补 LLM_BASE_URL → DEEPSEEK_BASE_URL… (#75)
- 打包脚本 store zip 变体剥离 manifest key——商店首传实测拒绝 key(商店自派 ID),tar.gz 保留 key 保 GitHub 通道固定 ID 不变量;§43 加防漂移断言(delete m.key 必须在场)… (#74)
- bootstrap 测试 8 去掉 --auto——GitHub Actions 里 AUTO+CI=true 触发 postinstall 跳过路径… (#73)
- TAG 脚枪根治——publish-npm.sh 未传 dist-tag 即拒发(rc.5 陈旧默认退役,验收①);rc.15 网页批准发布实录固化 tokens.md + AGENTS.md 发布闸(一次浏览器 approve=标准动作/… (#71)

### Documentation

- ② 收口——rc dist-tag 迁至 rc.16、杂散别名自洽(DELETE 403 留痕… (2abbbf3)
- bind round 6 frozen treatment evidence… (ec24976)
- approve Phase 0 foundation plan… (176d603)
- define multi-benchmark optimization program… (4c0c918)
- 现状与历史分离——architecture §1 从 11962 字降到 399… (#85)
- add GoTry Archify system architecture map… (#79)

### Tests

- harden weather timeout and payload guards… (f186b80)
- make weather regression deterministic… (7c1bbb4)
- close offline root proof wiring… (90f2c25)
- stabilize the expanded clean consumer proof… (8fb208a)
- preserve host routing in bridge e2e… (924fecb)
- block optional calendar plugin in bridge e2e… (7f61694)
- isolate benchmark bridge runtime config… (ff19217)
- prove packed dsh core closure… (fa23d24)
- verify tool budget from a clean package install… (542c61c)

### Other

- evaluation: boot a minimal benchmark kernel… (#101)
- fix CI to validate the clean benchmark package… (90591c7)
- v0.0.1-rc.16 publish 后修复:changelog 闸 + gh release target… (#76)
- Issue 21 onboarding ux… (#69)

## [0.0.1-rc.16] - 2026-08-30

### Added

- 价表 provider-aware v2 + 价格漂移长机制(ADR-20)… (#68)
- 会话扩展 onboarding UX 闭环(点点点 + 装完零重跑)… (#66)
- 可下单事实单一数据源 + 产物事实闸(ADR-19)… (#53)
- 传输层定案扩展桥(issue #21 方案 C)——Chrome 144+ 逐连接 CDP 权限框实测不可产品化(founder「授权太频繁根本无法使用」;chrome-devtools-mcp #825:每连接必弹、无持久化批准),自研… (#52)
- staicli 全流程接入收口 + 端到端测试(run-all §7d)——全链路真打 UAT:官方脚本装 staicli→hotel-be 种子沙箱账号(hotelbyte_api_demo,predefined_user_demo.go… (#51)
- 效应解译器 effect_interpreter.v1——外部依赖隔离(issue #16 采纳… (#47)

### Fixed

- dirty 检查排除未跟踪文件(防止 worktree symlink 干扰)… (d8f8db1)
- changelog 闸自动 commit CHANGELOG.md + 排除自身污染… (3c30de3)

### Documentation

- 自动生成 v0.0.1-rc.16 段… (ce881b3)

### Other

- v0.0.1-rc.16: 价表 v2 + 价格漂移监测(CHANGELOG 机制首发)… (#70)

## [0.0.1-rc.16] - 2026-08-30

### Added

- 价表 provider-aware v2 + 价格漂移长机制(ADR-20)… (#68)
- 会话扩展 onboarding UX 闭环(点点点 + 装完零重跑)… (#66)
- 可下单事实单一数据源 + 产物事实闸(ADR-19)… (#53)
- 传输层定案扩展桥(issue #21 方案 C)——Chrome 144+ 逐连接 CDP 权限框实测不可产品化(founder「授权太频繁根本无法使用」;chrome-devtools-mcp #825:每连接必弹、无持久化批准),自研… (#52)
- staicli 全流程接入收口 + 端到端测试(run-all §7d)——全链路真打 UAT:官方脚本装 staicli→hotel-be 种子沙箱账号(hotelbyte_api_demo,predefined_user_demo.go… (#51)
- 效应解译器 effect_interpreter.v1——外部依赖隔离(issue #16 采纳… (#47)

### Fixed

- dirty 检查排除未跟踪文件(防止 worktree symlink 干扰)… (d8f8db1)
- changelog 闸自动 commit CHANGELOG.md + 排除自身污染… (3c30de3)

### Other

- v0.0.1-rc.16: 价表 v2 + 价格漂移监测(CHANGELOG 机制首发)… (#70)

## [0.0.1-rc.16] - 2026-08-30

### Added

- 价表 provider-aware v2 + 价格漂移长机制(ADR-20)… (#68)
- 会话扩展 onboarding UX 闭环(点点点 + 装完零重跑)… (#66)
- 可下单事实单一数据源 + 产物事实闸(ADR-19)… (#53)
- 传输层定案扩展桥(issue #21 方案 C)——Chrome 144+ 逐连接 CDP 权限框实测不可产品化(founder「授权太频繁根本无法使用」;chrome-devtools-mcp #825:每连接必弹、无持久化批准),自研… (#52)
- staicli 全流程接入收口 + 端到端测试(run-all §7d)——全链路真打 UAT:官方脚本装 staicli→hotel-be 种子沙箱账号(hotelbyte_api_demo,predefined_user_demo.go… (#51)
- 效应解译器 effect_interpreter.v1——外部依赖隔离(issue #16 采纳… (#47)

### Fixed

- changelog 闸自动 commit CHANGELOG.md + 排除自身污染… (3c30de3)

### Other

- v0.0.1-rc.16: 价表 v2 + 价格漂移监测(CHANGELOG 机制首发)… (#70)

## [0.0.1-rc.16] - 2026-08-30

### Added

- 价表 provider-aware v2 + 价格漂移长机制(ADR-20)… (#68)
- 会话扩展 onboarding UX 闭环(点点点 + 装完零重跑)… (#66)
- 可下单事实单一数据源 + 产物事实闸(ADR-19)… (#53)
- 传输层定案扩展桥(issue #21 方案 C)——Chrome 144+ 逐连接 CDP 权限框实测不可产品化(founder「授权太频繁根本无法使用」;chrome-devtools-mcp #825:每连接必弹、无持久化批准),自研… (#52)
- staicli 全流程接入收口 + 端到端测试(run-all §7d)——全链路真打 UAT:官方脚本装 staicli→hotel-be 种子沙箱账号(hotelbyte_api_demo,predefined_user_demo.go… (#51)
- 效应解译器 effect_interpreter.v1——外部依赖隔离(issue #16 采纳… (#47)

### Other

- v0.0.1-rc.16: 价表 v2 + 价格漂移监测(CHANGELOG 机制首发)… (#70)

## [0.0.1-rc.16] - 2026-08-30

### Added

- 价表 provider-aware v2 + 价格漂移长机制(ADR-20)… (#68)
- 会话扩展 onboarding UX 闭环(点点点 + 装完零重跑)… (#66)
- 可下单事实单一数据源 + 产物事实闸(ADR-19)… (#53)
- 传输层定案扩展桥(issue #21 方案 C)——Chrome 144+ 逐连接 CDP 权限框实测不可产品化(founder「授权太频繁根本无法使用」;chrome-devtools-mcp #825:每连接必弹、无持久化批准),自研… (#52)
- staicli 全流程接入收口 + 端到端测试(run-all §7d)——全链路真打 UAT:官方脚本装 staicli→hotel-be 种子沙箱账号(hotelbyte_api_demo,predefined_user_demo.go… (#51)
- 效应解译器 effect_interpreter.v1——外部依赖隔离(issue #16 采纳… (#47)
