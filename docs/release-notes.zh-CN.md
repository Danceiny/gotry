[English](release-notes.md) | [简体中文](release-notes.zh-CN.md)

# GoTry 发版记录

> 给用户和开发者看的更新日志。Latest 在最上面。

---

## Unreleased

---

## v0.2.0-rc.30 · 2026-10-06

**为什么发这一版。** 深度规划达到本轮截止时间时，可能拒绝探索稿写入、仅保存一个 open handoff 工单，但最终答复仍承诺文件已创建且后台规划已启动（[#647](https://github.com/Danceiny/gotry/issues/647)）。本版让这些承诺跟随真实写入结果和原生任务生命周期，并提供探索稿与最终交付物的打开入口。版本号继续与扩展 manifest 配对（`0.2.0.30`，由 `extension-tests` 强制）；扩展行为未改。

### 新增（自 rc.29 起）

**修复**

- **截止交接保留探索稿的真实结果**——待执行的探索稿写入在本轮收尾前执行一次。写入失败仍按失败处理；原生 `present` 工具可展示实际创建的文件。
- **后台规划拥有原生归属任务**——持久宿主启动会话归属任务并记录编号；一次性调用或没有执行器的场景保持排队。规划器保留原工作目录、用户回答和有界证据，重复交接复用工单。启动失败、执行失败、超时、取消与完成均持久结算。结算等待完整受管进程范围退出；清理观察出错时明确报告尚未确认清理。stderr 不作为成功规划交付物。
- **探索稿与结果可打开、可再次检索**——原生文件卡片及侧栏预览展示真实文件，最终结果可在 GoTry artifacts 中按工单编号列出和读取。

**发布工具链（不在 npm 包内）**

- **OIDC 以文件路径发布 tarball（[#645](https://github.com/Danceiny/gotry/pull/645)）**——向 npm 传入显式相对文件路径，避免裸路径在身份换票前被当成 git 简写。
- **回拉收据保留发布路线（[#644](https://github.com/Danceiny/gotry/pull/644)）**——由工作流发布时，后续文档记录对应工作流和运行链接。

### 安装

运行 `npx @danceiny/gotry@0.2.0-rc.30 web`（Node ≥ 22.15）。`latest` 指向本版后，`npx @danceiny/gotry web` 等价；registry 镜像滞后时请钉住确切版本。

### 验收边界

handoff 回归与隔离浏览器检查使用合成模型和 planner 响应，实际执行原生任务、受管进程、通知与文件展示。#647 的安装后真实会话验收仍需加载修复；原未执行工单保持未执行。

---

## v0.2.0-rc.29 · 2026-10-06

**为什么发这一版。** rc.28 让求解器崩溃以显式的 `solver_error` 上报，而不再被说成「你的行程不可行」（[#620](https://github.com/Danceiny/gotry/issues/620)）。这使随包的云南数据包仍以 `solver_error` 收场、给不出方案：它的 `yn0` 段（8.4 落地后昆明→丽江的衔接）没有校准过的缓冲与接驳分钟数，而这些只有 founder 能提供（[#635](https://github.com/Danceiny/gotry/issues/635)）。现在该包在它挂接的四段上求解，`yn0` 作为 advisory 保留。本版同时在产品内为 Chrome 应用商店的更名收尾：`doctor`、setup 与 wizard 文案、工具描述统一写 Stai Travel Bridge——即该 listing 自 2026-10-04 上线起使用的名字。版本号继续与扩展 manifest 配对（`0.2.0.29`，由 `extension-tests` 强制）；扩展行为未改。

### 新增（自 rc.28 起）

**修复**

- **随包的云南数据包重新可解（[#635](https://github.com/Danceiny/gotry/issues/635)）** — `yn0` 从 `legs` 移入 `data/yunnan-pack.json` 新增的 `advisory_legs` 段，并写明原因：它的缓冲、出发地接驳与目的地接驳分钟数是只有 founder 能校准的现实事实，不替它们编造数字。没有任何读取方消费 `advisory_legs`，所以解析器、求解器与内核钉死文件零改动。此前对该包调用 `solveUnified` 返回 `solver_error`（`solver_input_not_integer`）；产品自己的纯 TypeScript 入口 `solveChoiceSegment` 从未受影响。三个分钟数一旦到位，把 `yn0` 放回 `legs` 就是全部改动。现在有测试审计每个随包数据包的三个整数字段，persona 演练里云南一行为 `feasible`。
- **扩展只剩一个名字：Stai Travel Bridge（#637）** — listing 改名之后，setup 与 wizard 的提示行、需要扩展的摘要、`doctor` 条目标签以及通道与工具描述仍写着「GoTry Session Bridge」。现在统一为 Chrome 应用商店展示的名字。商店链接与扩展身份不变。按旧 `doctor` 标签文字匹配的脚本需改用新标签。

**发布工具链（不在 npm 包内）**

- **npm 发布收成一条经过校验的命令（#641）** — `scripts/publish-npm.sh` 的预检会在第一次批准点击之前列出全部阻塞项。「已发布」以 registry 回拉回执为闸，GitHub Release 与文档后续步骤都读该回执。CI 可以在 tag 上手动触发，所以 push 运行被取消的 tag 提交也能带上自己的证明。流程见 `docs/ops/npm-release-runbook.md`。
- **面向 npm Trusted Publishing 的发布工作流（#642）** — `.github/workflows/npm-publish.yml` 只能手动触发且默认演练。它能让一次发布不需要批准点击、也不持有任何 npm 凭证，持有身份的作业在 checkout 之后不运行任何已安装的东西。使用前需要在 npmjs.com 做一次性的 Trusted Publisher 设置；在真实运行通过之前，上面那条命令仍是备案路径。

**整理**

- **又有五个追踪单按「推迟」关闭（#20、#136、#137、#142、#272）** — 2026-10-05 按 *not planned* 关闭：M4–M6 暂不是产品的核心能力，Booking Copilot 的验收则要等一个已登录的 Dida 浏览器窗口和一次获授权的 UAT 部署。关闭不等于验收：所有闸门仍未满足，权威文档承载每一条恢复触发条件与顺延的验收（#639）。
- **README、用户指南与路线图的基线随 rc.28 更新（#640）** — rc.28 记为已发布，并已从 registry 回拉校验。

### 安装

运行 `npx @danceiny/gotry@0.2.0-rc.29 web`（Node ≥ 22.15）。待 `latest` 指向本版后，`npx @danceiny/gotry web` 等价；镜像滞后时请钉精确版本。

### 已发布

2026-10-06 以 `TAG=latest ./scripts/publish-npm.sh`（dist-tag 显式传入，#50①）发布 `@danceiny/gotry@0.2.0-rc.29`，并从 registry 回拉校验：`npm view` 显示 `latest` → `0.2.0-rc.29`（shasum `7edbfe609b42bcb3482984c5fe4e139b898e7568`，543 个文件），与发布前由已打 tag 的源码树经 `npm pack --dry-run` 预测的 shasum 一致，下载的 tarball 字节哈希同样吻合。在干净机器上（全新 HOME 与 npm 缓存、仅官方 registry、无 LLM key）`npx @danceiny/gotry@0.2.0-rc.29` 端到端通过：`doctor` 打印报告，dist 入口能加载 `gotry-tools` 插件，`web` 可启动（带 token 的 URL 303 → 200，无 token 为 401），无凭证的一次性任务以宿主的缺凭证提示失败，而不是抛出堆栈。GitHub Release：[v0.2.0-rc.29](https://github.com/Danceiny/gotry/releases/tag/v0.2.0-rc.29)。兼容用 `rc` tag 仍指向 `0.0.1-rc.20`。

---

## v0.2.0-rc.28 · 2026-10-05

**为什么发这一版。** rc.27 的回拉校验与模拟触发演练暴露了真实缺陷。`npx @danceiny/gotry doctor` 会把没有凭证的 hbcli 报成「凭证有效」，装了 hbcli 的机器无一幸免（[#623](https://github.com/Danceiny/gotry/issues/623)）；接驳路径上，供应商的原始错误文本可能不经清洗进入工具结果，而与自己的模式或解析起终点相矛盾的路线供应商仍会被绑定成机场接驳（#429）；求解器崩溃可能以「你的行程不可行」的样子走到旅行者面前（[#620](https://github.com/Danceiny/gotry/issues/620)）；租户账本还会把裸 SQLite 争用错误漏给调用方（[#619](https://github.com/Danceiny/gotry/issues/619)）。这些在本版全部修复。本版同时落地会话双区记忆（默认关闭）与 M3 采集及 persona 模拟 harness（仅 synthetic）。版本号继续与扩展 manifest 配对（`0.2.0.28`，由 `extension-tests` 强制）；扩展本身未改。

### 新增（自 rc.27 起）

**修复**

- **`gotry doctor` 不再把没有凭证的 hbcli 报成「凭证有效」（[#623](https://github.com/Danceiny/gotry/issues/623)）** — CLI 此前按 `hbcli auth whoami` 的退出码判定，而它在什么都没配置时也退 0，所以装了 hbcli 的机器都会看到假的「有效」（已发布的 rc.27 上 14 次实测 14 次）。现改为与工具层 doctor 完全一致地解析三档 `whoami` JSON，探测在 `close` 结算，并加了对拍测试：同一份假 hbcli 同时喂给两份实现，二者不得再漂移。
- **`doctor` 不再偶发地把没有凭证的 hbcli 报成 `ok`** — 凭证探测在子进程 `exit` 事件结算，此时 stdout 可能还没读完；读到空串便落入「输出不可解析视为有效」分支。现改为在 `close` 结算，并用确定性回归测试注入一个先退出、数据后到的子进程。这同时消除了 Node 22 CI 任务的偶发红灯。
- **供应商故障详情进入工具结果前先被清洗（#429）** — 接驳供应商的错误文本（标记、凭据形状字符串）不再原样流入 `transfer_evidence`；固定的 `GROUND_TRANSFER_*` 文案按字节原样通过。
- **与自己的请求相矛盾的路线供应商，现在被拒绝而不再被绑定（#429 GAP-429-1／2）** — 自述模式不是驾车，或解析出的起终点与请求点对相差约 11 米以上（或无法解析），都回落到静态接驳估算并保留原价格标签，且不写缓存；当前接线的驾车工具两者都不声明，行为不变。
- **求解器崩溃不再被当成「行程不可行」上报（[#620](https://github.com/Danceiny/gotry/issues/620)）** — `solveUnified` 在进 Z3 之前校验每一个整数输入，并以显式的 `solver_error`（`solver_input_not_integer`／`solver_runtime_error`）返回，不再伪造 `unsat_core:['wasm_runtime_error']`；面向旅行者的文案说的是「求解器出错了」，而不是「行程不可能」。云南包上的根因是数据缺口（`yn0` 段没有缓冲与接驳分钟数），不是线程竞态，所以该包在分钟数校准之前会报 `solver_error`（[#635](https://github.com/Danceiny/gotry/issues/635)）。
- **租户账本不再把裸 SQLite 争用错误漏给调用方（[#619](https://github.com/Danceiny/gotry/issues/619)）** — `openDb` 把 `busy_timeout` 装在 WAL 切换之前，建表与迁移在 `BEGIN IMMEDIATE` 下完成；全部先读后写的账本事务改为开头就取写锁；争用预算耗尽时抛类型化的 `LedgerBusyError`，而不是裸 `SQLITE_BUSY`／`SQLITE_BUSY_SNAPSHOT`（D-15 演练缺陷 D15-1／D15-2）。存储数据、schema、幂等键、事件形状与单写者行为均未改变。内核清单已在 founder 批准下为 `state-ledger.ts` 与 `unified.ts` 重钉。
- **卡住的 LLM provider 不再让真实 LLM 运行无限挂起（[#618](https://github.com/Danceiny/gotry/issues/618)）** — `chat()` 现在会在 `GOTRY_LLM_TIMEOUT_MS`（默认 300 秒）内未完整应答、或调用方 `AbortSignal` 触发时，以类型化的 `LlmRequestError`（`timeout`／`aborted`）结束请求，而不是无限等待；usage 累计与缺 usage 即 fail-closed 的规则不变。
- **实时 `hbcli` 通道的离线开关（[#617](https://github.com/Danceiny/gotry/issues/617)）** — `GOTRY_HBCLI_LIVE=0`（亦可写 `false`／`off`）时，`anythingSearch` 不再启动 `hbcli`，并以 `[实时API:hbcli-anything@offline@…]` 降级；未设置或其他取值行为不变（`hbcli` 可用即 live）。`nightly-evidence.ts --dry-run`、`persona-sim.ts`、`replay.ts`、`replay-async.ts`、`time-eval-tests.ts` 现缺省置 `0`（显式取值照常生效），mock 与 dry-run 路径不再带着开发机已存凭据连到真实后端。
- **发布脚本以 `--verify-tag` 创建 GitHub Release** — `scripts/publish-npm.sh` 把 tag 名传给 `gh release create --target`，GitHub 以 HTTP 422（`target_commitish is invalid`）拒收：rc.27 在 npm 上发布成功，但 Release 步骤失败、只能手动补建。`--verify-tag` 在远端缺 tag 时直接中止，而不是悄悄在 `main` 上新建一个 tag。
- **测试加固** — warmer-proof 的闸标记改为原子发布（此前 Node 24 上偶发失败）；boot-budget 证明对 10 秒握手期限允许 50 毫秒的提前触发容差（一次 Node 22 运行量到 9999 毫秒）。

**新增（默认关闭或仅 synthetic）**

- **会话双区记忆机制（#255，默认关闭）** — 在既有 `events` 表上新增六个日志类事件（零新表；内核钉死的 `state-ledger.ts` 零改动）、捕获缝、按 scope 绑定的读回变量 `session_zone_brief`、经既有 motivation/timeline/companion 闸路由的 owner 确认晋升、`state-cli export` 新增 `hot-context.jsonl` 与 `notebook.json` 视图，以及 opt-in 观测面和三个阈值在见数据前冻结的指标。`sessionZones` 开关默认 `off`，关闭时惰性；价值声明仍关闭（尚无真实使用），出厂 persona 在 founder 决定前不引用新变量。
- **M3 种子 cohort 采集 CLI 与 LLM persona 模拟 harness（#22，仅 synthetic）** — 面向受邀且已同意的种子参与者、由操作者驱动的采集路径，写出评分器的 `gotry_m3_cohort_record_v1`（这类记录的首个生产者）；以及在离线或真实 LLM（带预算闸）下预演漏斗的 persona 模拟 harness。模拟运行标记为 `synthetic_fixture`、以 `test_or_staff` 登记，绝不计入 M3/M4 证据；M3 闸不变（仍需经准入的 50–200 名真实种子用户）。
- **休眠触发式追踪单的模拟触发演练（#82、#275、#422、#340、#339、#429；夹具层面；这些追踪单后来已按「推迟」关闭）** — 为成交结果↔规划估算投影（#340）、城市×场景分级（注册表为空，#339）与路线供应商合规闸（#429）新增默认关闭、零调用方的契约机制；为惰性的 W2A sensor 路径（#82）、租户账本上的并发写者／崩溃重开／在线备份（#275）以及 `0.2.0-rc.2` 上的 dsh SDK 后代清理再基线（#422，缺口得到确认）新增演练套件；并为外部 Anything 路径（#276／#345）新增 opt-in 的只读测量探针。所有结果都标注为 `simulated_trigger_drill` 或 `fixture_contract`，没有一项满足任何触发条件。

**整理**

- **八个休眠的触发式追踪单按「推迟」关闭（#82、#275、#422、#340、#339、#429、#276、#345）** — 它们的触发条件都没有出现，模拟触发演练也不满足其中任何一个；把它们作为常设积压挂着并不健康。按 *not planned* 而不是「完成」关闭：各触发条件现在写在对应的权威文档里（architecture 的 D-15／§10／D-39、`decisions-needed`、`memory-design` §2、`data-sources`），真实触发出现时另开 issue。

### 安装

运行 `npx @danceiny/gotry@0.2.0-rc.28 web`（Node ≥ 22.15）。待 `latest` 指向本版后，`npx @danceiny/gotry web` 等价；镜像滞后时请钉精确版本。

### 已发布

2026-10-05 以 `TAG=latest ./scripts/publish-npm.sh`（dist-tag 显式传入，#50①）发布 `@danceiny/gotry@0.2.0-rc.28`，并从 registry 回拉校验：`npm view` 显示 `latest` → `0.2.0-rc.28`（shasum `62631ba3fd0c8d2e73227abc7d968e313e4283f3`，543 个文件），与发布前由已打 tag 的源码树经 `npm pack --dry-run` 预测的 shasum 一致，下载的 tarball 字节哈希同样吻合。在干净机器上（全新 HOME 与 npm 缓存、仅官方 registry、无 LLM key）`npx @danceiny/gotry@0.2.0-rc.28` 端到端通过：`doctor` 打印报告，且不再把没有凭证的 hbcli 报成「凭证有效」（[#623](https://github.com/Danceiny/gotry/issues/623) 的修复），dist 入口能加载 `gotry-tools` 插件，`web` 可启动（带 token 的 URL 303 → 200，无 token 为 401），无凭证的一次性任务以宿主的缺凭证提示失败，而不是抛出堆栈。GitHub Release：[v0.2.0-rc.28](https://github.com/Danceiny/gotry/releases/tag/v0.2.0-rc.28)。兼容用 `rc` tag 仍指向 `0.0.1-rc.20`；挪动它每个 tag 都需要一次单独的网页批准（#50③）。

---

## v0.2.0-rc.27 · 2026-10-04

**为什么发这一版。** 已发布的 `latest`（`0.0.1-rc.24`）在干净机器上无法启动 `gotry web`：其钉死的 DSH 运行时（`0.1.5-rc.1`）启动即报 `user patch-layer watching requires the Cordis HMR service`（[#600](https://github.com/Danceiny/gotry/issues/600)）。本版把整个 DSH 家族升到 `0.2.0-rc.2`（279 个包，[#610](https://github.com/Danceiny/gotry/pull/610)），该启动路径已不复存在。founder 于 2026-10-04 确认发版。版本号继续与 Stai Travel Bridge 扩展版本 `0.2.0.27` 配对（扩展版本不变量）。

### 新增（自 rc.24 起）

- **首启修复** — 干净机器上的 `npx @danceiny/gotry web` 在 `0.2.0-rc.2` DSH 闭包上重新可以启动；此前的闭包在干净机器上运行 web 配置时启动即崩。
- **行程产物** — deck 渲染器与带真实二维码矩阵的静态导出包、产品入口 `gotry_itinerary_deck_render` 与 `gotry_itinerary_render`（HTML）、宿主持有的 Lavish 审阅工具、产物列表分页与字面元数据搜索、分享契约层与一键深链契约（契约层，默认关闭）。
- **实时与会话检索** — FlyAI：覆盖全部公开检索类型、安全的配置检查、有界进程清理、回包畸形或进程被终止时 fail-closed；相互独立的检索现在带有界取消并行执行。Dida：按城市＋日期的查询链路、目的地驱动、门户投递一次性登录代填、英文房型名。会话桥：登录检查与检索绑定同一个扩展客户端、扩展作业失败不再误报 `needs-login`、用于漂移诊断的脱敏传输形状、作业账本与事件上行。
- **嵌入式 Booking Copilot planner** — 类型化决策与权限加固、搜索失效回执、可部署的回合期限、预热与停滞预算；planner 自建进程的启动有了独立的紧预算与错误类型，启动失败不再被报成模型超时。
- **记忆与召回** — 召回 tick 调度器与 why-now 卡；租户账本修复控制面（带回执的 apply 与 rollback）；会话双区记忆分区契约（P4-1，惰性、默认关闭）。
- **可观测性** — 服务运行时补充结构化 verdict 日志与 planner／backend 启动阶段标记；启动诊断保留按序的阶段记录（[#511](https://github.com/Danceiny/gotry/issues/511)）。
- **能力上手** — 通道（如 `hbcli`）缺失时给出人话化的失败原因、首次接触提示写明影响面、双语上手文档。
- **hbcli** — 客户邮箱验证码两步登录工具面。
- **惰性、默认关闭的契约** — 外部事件（W2A）接缝、Money/FX 事实契约、离线行政区划 atlas 加载器；均不激活任何活体路径。
- **Stai Travel Bridge 已在 Chrome 应用商店上线（0.2.0.27，#346／#537）** — 0.2.0.26 于 2026-09-26 因上架元数据与实际功能不符被拒；上架名改为 Stai Travel Bridge 后于 2026-09-30 重提 0.2.0.27。公开商店页与商店更新接口均已分发 0.2.0.27（2026-10-04 回拉）。已安装扩展侧的验收——桌面连接、员工门户 join 与 Dida 登录——仍在 #346 下待做。

### 此前排队的条目（沿用原 Unreleased 清单）
- **持久默认出发地（#338,2026-09-10）** — `gotry_motivation_save` 接受 typed `homeCity` 与 optional/explicit exact `homeCityEvidence` 绑定（单条非空 evidence 可省略，多条须显式）；账本持久化 `homeCityPreference { value, evidence, updated_at }`，并通过 `{{motivation_brief}}` 作为软默认读回。显式当轮出发地优先，显式 null 清除活跃默认。
- **产物视图进入 M4 队列（issue #285,2026-09-10）** — `gotry_artifacts_list/read` 在 Host 层持久化标准 `presentationMeta` 并输出 `SearchPathsResultView`/`ReadResultView` 所需字段与 `FileLocation`；**公开 `./client` adapter 通过 `window.__ModuleLoader__.load` 在 DSH Web 中按 runtime `block` 渲染自定义 list/read keyed cards**（wire name `tool.call.toolview`，key = `gotry_artifacts_list` / `gotry_artifacts_read`，见 `client/client.js`），路径可点击、首行显示 source + 完整 path + 行号预览 + source identity + content version；workspace/sidebar 文件树保留为**额外**预览面。读范围白名单 = stateRoot 根 + 会话 dsh 工作目录（排除 node_modules/.git），扩展名白名单 = 文本类；跨 root / symlink 越界 / 缺失文件 / 超大文件（>2MB）统一返回 ok:false + error + hint。本层只读，WriteGate 红线不涉及。验收证据 = `scripts/artifacts-capability-tests.ts` 12 项隔离 fixture proof + `scripts/dsh-artifact-web-e2e.ts` fresh-profile Web list→select/open→read→edit→updated-read proof（覆盖改写后正确 preview 的 changed-file notice 与 reload 后更新可见）+ smoke §15/§15b。已通过 PR #305 交付 / destination `48c794c58b02d543be01f3bec98a056447dfeb85`。
- **M4→M6 公开交付与债务台账（#270）** — 架构债务行统一指向公开 tracker 或具体触发条件，D-12/D-16/D-24 归档；issue→Draft PR→exact-head review→merge/destination 回执成为通用公开交付契约。本地/fixture 证据仍不构成 #20/#136/#137 的真实准入。
- **DSH runtime closure 迁移到 0.1.5-alpha.1（#268）** — 把 root-pinned DSH 运行时依赖从 `0.1.2-alpha.3`（216 包闭包）精确迁到 `0.1.5-alpha.1`（230 包闭包）。精确钉死目标版本，绝不跟随可变 `alpha` dist-tag（当前指向 `0.1.5-alpha.2`）。230 = 15 新增（`dsh-api-workspace-files`/`dsh-client-file-upload`/`dsh-client-resources`/`dsh-client-ui-open-in-app`/`dsh-client-ui-sidebar-files`/`dsh-client-ui-sidebar-right`/`dsh-client-ui-sidebar-textpreview`/`dsh-host-open-in-app`/`dsh-http-proxy`/`dsh-package-manifest`/`dsh-session-format`/`dsh-session-format-catalog`/`dsh-session-format-v0-to-v1`/`dsh-session-format-v1-to-v2`/`dsh-session-format-v2-to-v3`）+ 移除 `dsh-tool-subagent-report`；增减集由重新生成的 npm 与 pnpm 锁文件确认。`ts/package.json` overrides 由 14 扩到 230，把完整 peer 闭包钉在 `0.1.5-alpha.1`，阻止 `^0.1.5-alpha.1` 插入符号把传递 peer 漂到 `0.1.5-alpha.2`。新增失败前置条件契约测试 `dsh-target-closure-proof.ts`（读仓库实态，起始 216/alpha.3 闭包上必败，迁移后必过），接入 run-all §23b。API 审计（`tsc --noEmit` + smoke + map-tools clean-tarball proof）未重现任何目标不兼容：`SettingsProvider.prototype.installSection` 接缝、7 个 `map_*` 工具、settings watch/reload/dispose、Session V3 单向迁移、agent/session/inbox/steer 接缝在 `0.1.5-alpha.1` 均存活，无行为改动。历史 `0.1.2-alpha.3` 证据在 §9/roadmap/stage1/release-notes 旧条目中保留，不批量替换；设置行为不变。这些确定性证明不构成 M5/M6 准入。（后续已被取代：闭包现为 `0.2.0-rc.2`。）
- **TS 严格安装闭环（#202）** — 在 rc.20 已随包交付 MIT `dsh-map-tools` 的基础上，补齐 alpha.3 peer closure 的精确 overrides，使 `ts/` 裸 `npm ci` 不再依赖 `--legacy-peer-deps`；新增 clean tarball fail-closed 证明。

### 安装

运行 `npx @danceiny/gotry@0.2.0-rc.27 web`（Node ≥ 22.15）。待 `latest` 指向本版后，`npx @danceiny/gotry web` 等价；镜像滞后时请钉精确版本。

### 已发布

2026-10-05 以 `TAG=latest ./scripts/publish-npm.sh`（dist-tag 显式传入，#50①）发布 `@danceiny/gotry@0.2.0-rc.27`，并从 registry 回拉校验：`npm view` 显示 `latest` → `0.2.0-rc.27`（shasum `f0889a78cd817bb33028630b9087177cc81c3ed2`，517 个文件）。在干净机器上（全新 HOME 与 npm 缓存、仅官方 registry、无 LLM key）`npx @danceiny/gotry@latest web` 可以启动并提供界面——`Cordis HMR service` 启动崩溃已消失——`doctor` 能输出报告，没有凭证的一次性任务以宿主的缺凭证提示失败而不是抛堆栈。GitHub Release：[v0.2.0-rc.27](https://github.com/Danceiny/gotry/releases/tag/v0.2.0-rc.27)。兼容用 `rc` tag 仍停在 `0.0.1-rc.20`；挪动它需要另一次网页授权（#50③）。

本版已知问题：`npx @danceiny/gotry doctor` 会把没有凭证的 hbcli 报成「凭证有效」——CLI 仍按 `hbcli auth whoami` 的退出码判定，而工具层 doctor 已改为解析其 JSON（[#623](https://github.com/Danceiny/gotry/issues/623)）。

---

## v0.0.1-rc.24 · 2026-09-11

**Source-only bump。founder 在 docs/audit-sync-2026-09-11 批次收口后授权 `npm publish 0.0.1-rc.24`；bump 同时推进 `package.json` 与 `extension/manifest.json`。覆盖此版本的 source commits：**

- `6e85d36` feat(session): execute in admin browser extension, kill server-side chrome (#380) — founder 2026-09-11：执行环境 = 浏览器客户端（GoTry Session Bridge），服务端零 Chrome。`ts/capabilities/session/extension-bridge.ts` 抽出传输无关的 `createBridgeJobQueue`；`handleMountedRequest` 挂载 gotry-backend `/v1/session/bridge/{health,status,jobs,results}` 鉴权面。`ts/capabilities/session-search.ts` 引入 `multiCollect` 给 dida 推荐流车道（`hotels` + `recommendPrices` 双齐即结算）。`ts/src/backend/modules/session-search.ts` 移除 CDP/transport 依赖、仅暴露桥端点；`login/open` 让扩展把 dida 登录页置前台。founder 拍板「hide all config from employees; portal dispatches join ticket」将 hotelbyte 产品的 `join ticket` 派单迁出 CLI 面。§38 扩展合同测试 36/36。
- `25502e9` feat(state-ledger): authorized tenant repair apply/rollback with receipt protocol (#254) (#378) — `ts/src/ledger-repair-apply.ts` 扩展 owner-gated `apply` / `rollback` 路径，与 `docs/ops/ledger-tenant-repair.md` 的回执协议配对。dry-run 仍默认；生产 apply 需显式 owner-only `GOTRY_REPAIR_AUTHORIZE` env token，完成时落私有回执。
- `3168c0f` chore(deps): DSH runtime 闭包升级到 0.1.5-rc.1（232 包）(#379) — `ts/package.json` overrides 由 14 扩到 232，把完整 peer 闭包钉在 `0.1.5-rc.1`。新增含 `dsh-client-ui-sidebar-files`/`dsh-client-ui-sidebar-right`/`dsh-client-ui-sidebar-textpreview`；移除 `dsh-tool-subagent-report`。CI 显式严格 `npm ci --strict-peer-deps`。
- `c28d6be` fix(ci): backfill version field for native binary placeholders in lockfile — `node_modules/@deepseek-ai/node-addon-system/` 下 3 个 `node-addon-system-*` 占位条目没有 `version` 字段，导致 npm 11.19.0 上 `npm ci --strict-peer-deps` 抛 `Invalid Version:`。回填 `0.1.2` 与父包 `optionalDependencies` 对齐，解锁了纯文档 PR（#383 + audit-sync 后续）的 CI 红。

### What's New（同期入库的架构面增量）

这些 commit 在 rc.20 与 rc.24 之间已合 `main`，但本批次 owner 选择把它们挂在 rc.24 段而不是单开 rc 段：

- **Web 启动交互式 onboarding（#258/#267）** — `npx @danceiny/gotry web` 在交互式 TTY 上可能**只问一次**"现在配置可选能力吗？(y/N)"，先于 detached doctor 摘要。`y` 复用 `doctor --fix` 幂等安装器（`setupHbcli` / `setupReach` / `setupSidebar`）；`n` 直接进 web。三态结果（`installed` / `needs-user-action` / `unavailable`）。CI / benchmark / 非 TTY / `GOTRY_SETUP_SKIP=1` / `GOTRY_ONBOARDING_SKIP=1` / `--no-onboarding` 均跳过 prompt。**M4 UX 证明**；不计入 #20 真实 `observed_private` cohort Exit。
- **Booking Copilot planner 共享源派生（#263, 8 commit）** — `time-anchor.ts` 导出 `formatUtcOffsetLabel`，固定 `UTC±HH:MM` 零填充；`validation.ts` 导出 canonical schema 字节；planner persona 的 `SearchCriteriaPatch` 字段名列表自 `bookingSurfaceSchema.$defs.SearchCriteriaPatch.properties` 派生——不再维护手写第二份。数字键数组（`{"0": {...}}`）在 must-be-array 修复步被识别。planner LLM 跟随 `DEEPSEEK_MODEL` / `LLM_MODEL`；MiniMax-M2 nested decision envelopes 自动解包；planner token budget 上调适配推理模型。
- **Booking planner 纠偏批量（#212 / #278）** — `#212` factRef alias 碰撞防护（保留 `modelref:` 命名空间 + 原 UTF-8 SHA-256）；`#278` schema 拒绝反馈环把具体拒绝回放进同 session（而非盲重试 IDENTICAL prompt——MiniMax-M3 复现器）；occupancy 项无 `adults` 即丢弃。`#282` 的前置切片。
- **Dida 供应商门户适配器 v2（#372）** — 识别加载态推荐流（`HotelRecommendAPI/SearchHomepageRecommendHotels` + `SearchHomepageRecommendPrices`），外加 `PopularDestinationAPI/SearchHotels` + `SearchHotelPrices`。UAT 实测页面自发的是该流。CDP 车道窗口式多响应收集。
- **Booking-executor 观察面（#377, M1 第 1 切片）** — 仅 `POST /v1/booking/observe`：CDP 打开供应商页面，读取预订入口按钮文本，截图存证。刻意不含 fill/submit 原语（那些属于后续 M5 WriteGate 红线之后的受控执行器）。
- **gotry-backend 发布构建脚本（#367）** — `scripts/build-booking-copilot-release.mjs` + `scripts/build-gotry-backend-release.mjs` 把 kernel + booking-copilot + session-search 模块打包成 `bin/gotry-backend.js` 的发布制品。

### For Developers

- 所有新行为复用 `doctor --fix` 幂等安装器面；无新全局态、无新配置路径。
- Booking-copilot planner prompts 现与 booking.surface typed 合同共享 canonical schema；planner 示例与线形状的漂移是编译错误而非运行时 mismatch。
- `c28d6be` 是 6 行修复；若你用 `npm install` 重新生成 `package-lock.json`，同样三个占位条目仍会无 `version` 复现。`c28d6be` 作者计划加 `prepublish` lint 拒空 version 条目；纳入下批次 audit。

### 安装

- 无改动 — `npx @danceiny/gotry@0.0.1-rc.24 web`。首次交互式启动跑一次 #258/#267 onboarding prompt；`--no-onboarding` 或 `GOTRY_ONBOARDING_SKIP=1` 跳过。

### dist-tag 计划

`npm dist-tag add 0.0.1-rc.24 latest` 与 `npm dist-tag add 0.0.1-rc.24 rc` 在同一授权窗口内（owner 拍板：dist-tag c，`latest` 与 `rc` 双指）。granular token DELETE 按 [`docs/tokens.md`](../tokens.md) 文档化行为返回 403/405；冗余 `rc` 别名仍挂在 rc.20——owner 决定保留历史 `rc` 挂点还是让其自然消亡。

---

## v0.0.1-rc.20 · 2026-09-08

### What's New

- **修好 `npx @danceiny/gotry doctor --fix` 的整个安装链** — rc.19 实测三红一误报，根因各不相同：
  - **sidebar「1 项补装失败」是误报**：pnpm 11 的严格构建脚本策略让 dsh 安装器 exit 1，但 167 个包其实已完整落盘（复检本来就是绿的）。现在安装器按落盘状态判成功，并明示 node-pty（侧栏内嵌终端）的构建脚本被 pnpm 跳过、需要时用 `pnpm approve-builds` 补。
  - **地图/路线/POI 工具这次真的可用了（npm 安装形态）**：rc.19 说「正式进依赖」实际只对源码布局生效——npm 布局从未装上。依赖这条路被上游堵死：dsh-map-tools 的 peer 要求 `>=0.1.2-rc.1` 的 dsh 家族，而 gotry 锁定 `0.1.2-alpha.3`（semver 上 alpha < rc），npm 严格 peer 解析直接拒装，硬上会弄坏 `npx @danceiny/gotry` 主安装路径。rc.20 改为**随包内置分发**——装 gotry 即得地图工具，零 API key（OSM/OSRM）。
  - **ask-user 的 ❌ 是体检误报**：依赖一直在（npm 的提升布局里，运行时正常），体检的检查路径没覆盖该布局。现在体检与运行时解析同口径，说真话了。
- **`gotry help` 不再打印合并冲突标记**（rc.19 带入的脏文本，顺带清偿）。

### For Developers

- **CI 双层修复（main 自 #197 起全红）**：①runner npm 升级后裸 `npm ci` 强制校验 peer，而 ts 的 lockfile 一直是 `--legacy-peer-deps` 模式生成——CI 与 CONTRIBUTING 显式带该旗标，并移除 dsh-map-tools 冗余依赖；②turn-deadline 的 5 个 tsc 错误 = 类型面隐性依赖 peer 意外物化（`session/event` 声明在 dsh-session 的 cordis Events augmentation 里，pnpm 隔离布局下 root 侧的 augmentation 合并进另一个 cordis 实例）——显式 `import type` + dsh-session@0.1.2-alpha.3 进 ts 依赖面，overrides 把 peer 闭包钉在 alpha.3 防 rc.1 混版本，ts lock 全量 resolved 指回 registry.npmjs.org。
- doctor 两面（CLI + 会话工具）改 createRequire 解析链，覆盖 npm/npx 提升布局；map-tools 解析 vendor 优先。
- 新增回归锚：doctor-tests §5b/5c（提升布局解析/vendor 布局）+ bootstrap-tests §11（安装器 exit 非 0 但落盘 = 按状态判成功）。

### 安装

- 没变化，跑 `npx @danceiny/gotry web`。rc.19 用户跑一次 `npx @danceiny/gotry doctor` 复检——地图/ask-user 两项应转绿。

---

## v0.0.1-rc.19 · 2026-09-07

### What's New

- **修了 rc18 的 `invalid skill name "gotry_motivation_save"` 硬错误** — 在「查余额 + 规划旅行」的交界场景里，模型会把 gotry 的工具名当成宿主 skill 传给 skill 加载器，当场报错。现在人格契约写死了表层规则：gotry 的全部能力一律是工具调用（gotry_ 前缀），绝不进 skill 加载器；skill 调用报 invalid/unknown 就改回工具调用。
- **地图/路线/POI 工具上线** — `dsh-map-tools` 正式进依赖（零 API key，走 OSM/OSRM 开放源）。此前这个插件一直被启动流程静默丢弃；现在 doctor 体检（对话内 `gotry_doctor` 与终端 `npx @danceiny/gotry doctor`）都会如实告诉你它是否就位。
- **外部事件接缝（前两段）** — 新增只读通道探针 tick：站点断/上游不可达这类「带外事实」现在会写进通道健康面，检索改道建议与 doctor 即时受益，不用等用户撞上失败；愿望池召回也会否证「依赖通道当前不可用」的憧憬——不再硬推当下走不通的行程。
- **booking planner 连续加固** — factRef 指针清洗泛化、截断 finalResponse 恢复、UI 预载 offers 容忍、surface-policy 违规重试等一组修复（#172-#188）。
- **doctor 两面同口径** — 终端 CLI 与会话工具面现在报同一份体检清单（此前 CLI 缺 map-tools/ask-user 两项）。

### For Developers

- 通道健康面新增 `'ok'` 恢复事件语义（latest-wins 超越 down）；外部事件接缝设计 `docs/design/external-event-seam.md` 三段中前两段落地，第三段（world2agent 远程桥）待 D-31 拍板。
- run-all 新增 §52（通道探针）/§53（愿望池否证）/§54（persona 表层护栏）；行为契约仍 22 条（（16） 内部澄清）。
- Node 下界仍为 22.15（低于此版本启动即拒）。

### 安装

- 没变化，跑 `npx @danceiny/gotry web`。

---

---

## v0.0.1-rc.18 · 2026-09-02

### What's New

- **修了一个让你卡死在终端的 bug** — 之前 `gotry web` 启动时如果没设 LLM key，CLI 会直接打一段「缺少 LLM API key」然后退出，根本进不了 dsh。但 key 是 dsh 那边管的事，不该 gotry 来挡。现在启动期只剩静默委托 dsh。
- **`gotry setup` 不再替你管别的依赖** — 之前它会顺手装 hbcli / agent-reach / dsh-better-sidebar 一堆与 gotry 无关的工具，现在它只检查一件事：浏览器扩展装好了吗。其他事归各自的宿主生态。
- **文档同步卸 key 引导** — README 中英、`user-guide.md` 不再让你「在 .env 里写 LLM_API_KEY」。

### For Developers

- 这一版主要是「让 gotry 在 CLI 层更像个插件」—— 它不再假装自己是入口，也不再要求用户配它本不该管的事。

### 安装

- 没变化，跑 `npx @danceiny/gotry web`，dsh 那边该弹什么弹什么。

---

## v0.0.1-rc.17 · 2026-09-02

### What's New

- **GoTry Session Bridge 上架 [Chrome Web Store](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd)** — 浏览器扩展已通过 Google 审核发布，一键装、自动更新、零系统弹窗。
- **插件安装回到浏览器的事** — 之前 gotry 在终端里既开浏览器又动剪贴板又弹原生面板，让安装体验变得很糟糕。现在直接打开浏览器商店点「添加至 Chrome」就完成了。`gotry session` 工具在会话检索里碰到扩展未装的状态，会把商店链接直接呈现给你，点一下就到。
- **携程会话面安装少踩坑** — 之前如果没装扩展就调用携程会话检索会卡住；现在扩展一装好，对话会立刻自动继续。
- **GitHub Releases 通道保留** — 想自己控制更新节奏、或不想通过商店审核，照样可以在终端用 `npx @danceiny/gotry setup --extension-from=github` 拉取最新版本。

### For Developers

- **扩展安装提示做了无缝衔接** — 之前需要装扩展时让用户在终端跑一长串命令，现在 gotry 的工具返回结果里直接带上 Chrome 商店链接，你做的客户端界面可以直接渲染成可点的链接。
- **Chrome 商店版与本地加载版完全互通** — 双通道用的是同一个扩展、同一个数据桥，所以即使中途从开发者模式加载版换到商店版，或者反过来，会话都不会断。

### 安装

- 推荐：浏览器打开 [chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd) → 「添加至 Chrome」。
- 安装完毕后启动 gotry，工具首次调用如果还需要扩展，会自动检测到，不用重启。

---

## v0.0.1-rc.16 · 2026-08-30

### What's New

- **新接入 MiniMax 模型家族的费率** — 之前费率表只覆盖一家供应商；现在 MiniMax 的几款模型也都接入了，会更准确地把每次对话的真实成本算给你看。模型升级时也会自动按新费率结算。
- **自动监控几大供应商的定价变更** — DeepSeek、MiniMax、OpenAI、Anthropic 四家主流供应商的定价被周期性扫描。如果你在用之前可能会自动重新核价，但**永远不会自动改你的配置** —— 这件事仍然需要人来确认。
- **更新日志从此机器化** — 这次的更新日志还有不少人工痕迹，从下一版开始会从代码提交记录自动生成。你看到的「What's New」会是开发过程中的真实变更，而不是事后整理。
- **修复了一个让你重新跑出错的扩展问题** — 之前某些情况下连续跑 gotry 会让端口占用冲突、得手动重启几次才能复现；现在不会了。

### For Developers

- **发布流程变的稳** — 现在每次发版前会自动跑全量测试、检查更新日志、跑干净安装确认无误；这些以前都是手工，容易漏。

---

## v0.0.1-rc.15 · 2026-08-29

### What's New

- **预订流程的状态机开始有了正式的词表** — 当 gotry 在做预订相关的多步操作时（比如改签、取消、确认），它现在只会用一套预先定义好的动作。这是为了之后让多步操作可以被完整回放、被安全审计，不会出现「它到底跑到哪一步了」的模糊地带。

### For Developers

- 这一版主要是给下一代「可下单」能力打地基，对终端用户来说没有可见变化。

---

## v0.0.1-rc.14 · 2026-08-29

### What's New

- **文档有了中英文分开版本** — 仓库根的 README 现在一份英文、一份中文，看你自己熟悉的语言。npm 主页展示英文。

---

## v0.0.1-rc.13 · 2026-08-29

### What's New

- **登录自动检测** — `gotry session` 工具每次需要复用你已经登录好的携程账号前，现在会先默默读一下「是否已登录」这个事实。如果已经登了，直接就能搜，不用每次都弹登录。如果没登，才会打开登录页让你登。
- **登录页态度更明确** — 之前登录页有时会开在你看不见的位置；现在它一定会把你的浏览器焦点切到你登录页上，登录完你知道在哪。
- **绝不主动开浏览器** — gotry 的自检流程再也不会因为跑测试就把你的浏览器闪退或反复打开了一堆窗口；除非你显式开 live 模式。
- **README 重排成普通人能看懂的版本** — 顶部推荐 30 秒上手，分组成「搜什么、用什么、怎么用」三段，关于账号授权与隐私的四条硬规则被单独拎出来强调。

---

## v0.0.1-rc.12 · 2026-08-29

### What's New

- **酒店搜索接到了 OTA（飞猪官方）** — 之前查酒店只能用 gotry 自己的内部数据；现在它可以直接搜到携程、飞猪上的实时报价。这是只读搜索，零凭证，不会替你下单。
- **OTA 工具面扁平** — 不再有「这是主路径、这是降级」这种内部概念区分；从前端看上去就是一堆并排的工具，每个都能用。
- **动用你账号的工具会先弹确认卡** — 任何用到「你在携程的账号」的工具，第一次在每个会话里调用时都会先和你打个招呼——批准后才能用、本会话内记住；如果你拒绝了，这个会话就不再弹、也就不再执行。
- **登录现在是一个工具** — 之前要登录会跳到命令行，现在 gotry 里直接调 `gotry_session_login`，它会在你自己的浏览器里开登录入口页面，登录你正常做完就行。**登录永远发生在携程官网，gotry 不会接触你的密码、验证码、cookie 值** —— 它只会看一眼「登没登录」这个布尔事实。

---

## v0.0.1-rc.11 · 2026-08-29

### What's New

- **Z3 计算引擎的并发竞态根治** — 之前在某些压力场景下，会出现反复求解失败、需要重试一次的隐藏问题；现在彻底修好了，可以并发跑。
- **实时票价可选开启** — 默认是关的。如果你的型号或场景需要用到实时报价，可以在环境里打开 `GOTRY_REALTIME_PRICING=1`，gotry 会去飞猪官方核实航班实际价格覆写进答案；找不到精确票价时会退回静态包，不会假装实时。
- **英文输出** — 现在 gotry 的中文/英文界面切换已经全部落地，`GOTRY_LOCALE=en` 切换。
- **README 之前四条「已知限制」清完了两条** — 实时票价的桥和英文界面都在这一版完成。

---

## v0.0.1-rc.10 · 2026-08-28

### What's New

- **Web 与本地一套账本语义** — 如果你之后想把 gotry 部署成供多人用的 Web 服务，它和你自己本地用同一套数据底座；用户是谁会在账本里有一等列，但单用户阶段你看不到区别。
- **一句话播报** — 上一版安装后首次启动的「装上了跑不起」问题，现在会引向 npm 完整安装流程而不是把崩溃栈糊你脸上。

### For Developers

- **rc.9 装的扩展跑不动的根治** — rc.9 装上的扩展有一个隐蔽 bug 让 npm 形态装完不能加载扩展；rc.10 同时根治并把这个检查固化进了发布前必跑的预验证脚本里。
- **依赖面补齐** — 包内多带了 SQLite（账本）、puppeteer-core（浏览器调试）、DeepSeek dsh 系列几个被 peer 钉住的版本依赖。

---

## v0.0.1-rc.9 · 2026-08-28

### What's New

- **17 个工具** — 记忆域（动机画像、旅行时间线、同行人、时间窗衰减）、事务化状态基座、会话面（携程官方 + 你自己的账号交叉验证）合流；这是开发主线 30 个 commit 一次性合入。
- **你现在去哪里过，过去去过的地方不再被推** — 动机画像和旅行历史开始进入推荐扣分。
- **节假日锚点扩到 2031** — 春节、中秋、国庆这些长假的「时间锚点」现在不会被预设漏掉了。

---

## 之前版本（rc.8 及更早）

rc.8 是首次带「记忆域 + 时间感硬化」骨架的发布；rc.7 是在真实用户对话数据上完成 7 题对账的终局版本；更早（rc.1 到 rc.6）属于内部迭代。如果你正在从更早跳上来，关键变化是：

- 当前推荐装法：`npx -y @danceiny/gotry@latest`（或 `@rc`）
- 携程会话检索需装浏览器扩展 —— 见上面 rc.17 那段
- 一切外部依赖安装统一收口到 `npx @danceiny/gotry setup`

---

## 还没解决的（仍可能影响你）

- **真实用户样本证据还没收完** — M3（内部里程碑代号，「产品基本可用」）要算真正完成，需要跨多个真实种子用户跑出来的定稿率、NPS、地理问答幻觉率；当前为 0。
- **会话面只覆盖携程（机/酒/火）** — 美团本地仍是盲区（匿名 403，登录态是硬前置）。
- **英文界面还存在小尾巴** — 切换到英文后，还有极少数角落的中文没有翻译完。
- **实时价格默认是关的** —— 打开后端到端比静态包慢一点；不在意的就开着。
