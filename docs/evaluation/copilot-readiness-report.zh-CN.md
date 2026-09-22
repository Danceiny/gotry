[English](copilot-readiness-report.md) | [简体中文](copilot-readiness-report.zh-CN.md)

# Booking Copilot 就绪与进程清理测试报告

> 定位：验证 #506、#508、#509 的运行时就绪、模型停滞计时和进程归属。
> 状态：2026-09-19 本地验证通过；#511 的归因见下文。
> 上游：[架构](../architecture.zh-CN.md)、[#506](https://github.com/Danceiny/gotry/issues/506)、[#508](https://github.com/Danceiny/gotry/issues/508)、[#509](https://github.com/Danceiny/gotry/issues/509)。
> 下游：Booking Copilot 维护者与 PR 审查者。

## 证据边界

成功链路使用已安装的 dsh SDK、托管 worker、真实 dsh CLI、GoTry 插件和本地 HTTP／SSE 模型夹具，覆盖就绪、超时到进程树清理。#508 通过已安装的子进程运行时驱动可控 worker 夹具，证明等待者拒绝和进程归属，不覆盖 dsh SDK 模型链路。其他失败场景使用可控 CLI 进程。这是本地运行时端到端测试，不代表浏览器 UAT、真实模型质量、真实供应商验收或生产延迟保证。测试使用隔离状态和 HOME，不写入创始人的产品数据。

## 诊断与改动

原 Node 22 CI 在 1053 ms 后报错 `real stalled provider was not reached`。唯一一次重跑在 1066 ms 后出现相同断言，模型步骤数为零。见[首次执行](https://github.com/Danceiny/gotry/actions/runs/35432681703/job/105869943674)与[重跑](https://github.com/Danceiny/gotry/actions/runs/35432681703/job/105872459772)。原夹具把启动与模型停滞放进同一计时窗口，模型请求尚未发出就可能耗尽软停滞时限。

`DeepSeekHarness` 构造是惰性的。原预热只确认对象创建，没有等待 `start()` 和 initialize 握手。现在预热等待握手完成。模型停滞测试先预热同一个 port，再启动轮次计时；独立冷启动用例保留原有期限。另一条一次性后台预热进程不能证明任务 port 已就绪。该发现不证明 Node 22 独有的 SDK 缺陷，也不代表生产冷启动延迟已修好。

同时修复两处生命周期问题：等待者存于 `Map`，必须通过 `Map.values()` 逐一拒绝；任务 port 关闭时必须一起关闭后台预热进程，再删除共享临时目录。默认预热清理有独立的真实进程验证。

## 验证记录

实现提交：`e037c7458f9901d28ab3dacadae3d56386de7e84`；基线：`00c76fb5cce84a7e3ad0c27af1f2da47c688d859`。最终完整回归期间源码摘要保持一致。报告提交跟随实现提交。

环境：macOS 26.6.2、arm64；两个包根目录均按锁文件安装；dsh 0.1.5-rc.1、TypeScript 5.9.3、tsx 4.23.13。最终验证时间：2026-09-19T10:34:44.767968+00:00。负向对照使用 Node 24.10.0，仅恢复待验证的旧行为。

| 检查 | 结果 |
|---|---|
| 旧就绪行为与可控启动门 | 预期退出码 1：真实运行时尚未启动并初始化，预热已错误报告就绪。 |
| 旧等待者行为 | 在隔离源码副本中独立复现，预期退出码 1：worker 退出后，请求仍未结束。 |
| 旧后台预热行为 | 保留真实预热，仅恢复原来的脱离式清理，预期退出码 1：关闭已返回，仍有被启动门阻塞的运行时进程树存活。 |
| 定向运行时、就绪、等待者和默认预热测试 | 最终两个 Node 版本矩阵中，四个命令全部通过。此前就绪与核心链路定向测试也在 Node 22.23.2、24.10.0 通过。 |
| 完整回归，Node 22.23.2 | 退出码 0，ALL SUITES GREEN，用时 610.29 秒。 |
| 完整回归，Node 24.16.0 | 退出码 0，ALL SUITES GREEN，用时 758.05 秒。 |
| TypeScript、双语结构、可读性、空白检查 | TypeScript 退出码 0；双语结构、可读性和空白检查通过。 |

Node 22 完整日志 SHA-256：`d5c199d31b8427eb2fe35d61e9f9adfad6eaf7bcd35f1afba28bc2d2360b7929`。Node 24 完整日志 SHA-256：`b870066cb29925e88f4d5c93163e0b06406f21b043024bc4065be575a24d417e`。

独立审查发现预热清理问题后，主动停止了此前的完整回归。首个完成的 Node 22 回归随后在既有干净消费端 SDK 启动用例中失败，用时 20088 ms；该次新增就绪、核心链路、等待者和预热测试全部通过。这两次均不计为完整通过。首个完成的失败日志 SHA-256：`05112150d9ac3fb6f31344f81db33a9fc2f2f54d0838c5daa1af3a8948bdfd52`。

一次加入阶段记录的隔离复现通过。原始原因仍由 [#511](https://github.com/Danceiny/gotry/issues/511) 跟进；包验证已补充阶段、请求数和封闭错误分类，没有自动重试或延长期限。新增 worker 夹具也已明确排除在 npm 发布包之外。

最终完整回归明确排除：真实 HotelByte UAT；外部 STAICLI 包验证（未提供产物）；七项可选 Agent Reach doctor 断言（未安装）；远端 hotelbyte-skills、FlyAI 航班／酒店、会话／登录与 Lavish 实时探针。当前回归入口不再运行历史 Python oracle。

## 干净消费端启动超时的归因（#511）

原始失败只留下四项可观测特征：退出码 1、用时 20088 ms、stdout 0 字节、stderr 731 字节；日志正文已丢失，原始环境未再复现。这四项足以定位阶段。

- 退出码 1 且 stdout 0 字节说明脚本没有走到成功分支，错误以未捕获形式逃逸；外层 `spawnSync` 上限是 60000 ms，因此不是被外层超时击杀。
- 干净消费端不覆盖任何 SDK 计时参数，继承 SDK 默认预算：initialize 期限 10000 ms、shutdown 1000 ms、stdin EOF 宽限 6000 ms、SIGTERM 宽限 3000 ms（`@deepseek-ai/dsh-sdk-client` 0.1.5-rc.1 的 `lib/index.js` 第 185／537／542／543 行）。`DeepSeekHarness.start()` 在 initialize 失败时会先跑完整条关闭阶梯，再重新抛出。
- 四段之和为 20000 ms。用不响应握手的夹具实测该组合，三次得到 `initializeMs=10001..10003`、`closeMs=10010..10038`、`totalMs=20013..20040`，与观测的 20088 ms 相差 48–75 ms。

因此原始失败发生在 initialize 握手：运行时在 10000 ms 内没有应答，关闭阶梯随后再消耗约 10000 ms。另一种解释需要握手完成后的某一段恰好再耗去约 9000 ms；当时的脚本还没有模型请求计数，事后无法区分，新增诊断现在可以区分（请求数为 0 表示握手从未完成）。生产端口已把三段宽限压到各 500 ms，并配一次性预热进程（`ts/src/booking-surface/dsh-planner.ts`）；包验证没有预热，沿用默认值。

同一台机器上，打包干净消费端的正常冷启动在预算内用 589／958／1093 ms 完成握手，余量约 9–17 倍。因此「期限对正常冷启动偏紧」不成立，原始失败更像运行时被长时间挂起或饥饿：该次回归与其他用例并行，且是首个完整回归。原始 stderr 已丢失，无法进一步区分。

诊断保留：消费端脚本现在每到一个阶段就把记录直接写入 fd 2，并在未捕获异常钩子里补写失败记录，因此「退出码 1、stdout 0 字节」这种形态不再吞掉阶段信息；包验证同时打印正常启动的各阶段耗时，把上述默认预算组合固定为断言，并保留一条未捕获逃逸的负向对照。启动失败诊断改为按顺序上报这些记录，而不再从 stderr 末尾截断——原始日志被截到 256 字节，恰好丢掉最早到达的那些阶段，而区分「冷启动挂起」与「清理阶段挂起」靠的正是它们；一条留存对照把这一点固定下来：同一条记录链既要躲过尾部截断，也要经过脱敏规则。原始原因仍由 [#511](https://github.com/Danceiny/gotry/issues/511) 跟进。

## 本地启动预算与模型预算拆分（#554）

创始人 2026-09-21 的裁定是：只有 LLM 调用才可以容忍秒级延迟——我们自己的进程启动与回收必须按自己的口径设限，不能沿用模型侧的宽松兜底。[#554](https://github.com/Danceiny/gotry/issues/554) 先做了埋点取数：首个握手在冷页缓存下为 2213–2386 ms；页缓存已热时，20 个全新 worker 的分布为 min 344／p50 385／p95 505／max 505 ms。

据此落地两项改动，均未触碰模型侧预算（`turnTimeoutMs` 12000 ms、`softStallBudgetMs` 为其三分之二）。

- **显式的启动期限**：生产路径的任务端口与预热端口改为传入 `initializeTimeoutMs = PLANNER_BOOT_BUDGET_MS`（5000 ms，`ts/src/booking-surface/dsh-planner.ts`），不再继承 SDK 的 10000 ms 模型侧兜底。5000 ms 对最差冷启动观测留有 2 倍以上余量，对热态 p95 约 10 倍。
- **类型化的启动失败**：从未完成握手的请求不再报 `PLANNER_PROVIDER_TIMEOUT`——那个码声称是模型停滞，而实际一个 provider 调用都没发生。worker 按自己负责的阶段分类（`HARNESS_BOOT_TIMEOUT` 与 `HARNESS_START_FAILED`／`HARNESS_RUN_FAILED`），端口只放行这一闭集跨进程边界，planner 返回 `PLANNER_BOOT_TIMEOUT` 并补齐 `boot_timeout` 度量结果。

改动后实测（对着一个从不回应握手的夹具）：轮次预算放宽到 20000 ms，使 13333 ms 的软停滞预算宽于启动预算，该轮在 **6055 ms** 收敛——启动期限先到，关闭阶梯再加约 1000 ms，全程零 provider 请求。若仍走 SDK 兜底，同一用例会落在 11 s 附近，因此该上限是真实生效而非只写在代码里。1500 ms 轮次预算下的冷启动用例现在报 `PLANNER_BOOT_TIMEOUT`，不再报模型侧的错误码。5000 ms 是**上限而非实测耗时**：实测握手为 0.34–2.4 s。

## 场景结果

| 场景 | 必要证据与实际结果 |
|---|---|
| 同一 port 就绪与模型停滞 | 阻塞真实 CLI 启动 1800 ms，预热持续等待且无模型调用。初始化后，请求包含 `booking_run_search`，到达本地 SSE，并在 3000 ms 内返回 `PLANNER_PROVIDER_TIMEOUT`。关闭后 worker 和 CLI 均退出。 |
| 冷启动 | 保持启动门阻塞。原有 1500 ms 轮次预算在零模型调用时返回明确类型的**启动**超时（`PLANNER_BOOT_TIMEOUT`，因为握手从未完成），两进程均回收。另有第二组用例把轮次预算放宽到 20000 ms，使得只有 5000 ms 启动期限能结算它，并断言确实如此。 |
| 初始化失败 | 可控 CLI 退出码 23、信号 null；预热严格返回 `HARNESS_START_FAILED`。返回错误不含私有夹具 stderr，两进程均回收。 |
| worker 退出与调用方关闭 | 每个场景启动两个 run 和一个 warmup，等 worker 确认收到三条请求，要求所有 Promise 在 1500 ms 内拒绝。重复关闭返回同一 Promise，关闭也回收忽略 TERM 的孙进程。 |
| 默认后台预热 | 启用默认预热并阻塞两个 CLI 启动门，关闭有界、拒绝任务预热、回收两棵 worker／CLI 进程树，再清理隔离 scratch；重复关闭返回同一 Promise，模型请求数为零。 |
| 既有核心链路 | 真实插件工具调用、参数修复、续轮、模型停滞与子进程归属继续通过。 |

最终 Node 22／24 观测值：模型请求到达 32–34 ms，模型停滞超时 1015–1016 ms，就绪进程树关闭 98–133 ms，冷启动超时 1001–1004 ms。 这些是观测值，不是新的服务承诺。失败诊断记录启动阶段、模型请求数、安全错误分类和夹具进程证据，不暴露原始模型 stderr。

已知后续问题：worker 退出后，**新提交**的 run／warmup 仍可能一直等待，直到显式关闭。这一独立终态缺陷已记录为 [#510](https://github.com/Danceiny/gotry/issues/510)，本次未修复；等待者测试覆盖的是退出前已提交的请求。

## 复现方法

两个包根目录分别执行 `npm ci --no-audit --no-fund --strict-peer-deps` 后，运行：

```sh
(cd ts && npx tsc --noEmit)
(cd ts && npx tsx scripts/booking-copilot-dsh-core-proof-tests.ts)
(cd ts && npx tsx scripts/booking-copilot-dsh-readiness-proof.ts)
(cd ts && npx tsx scripts/managed-dsh-run-port-proof.ts)
(cd ts && npx tsx scripts/booking-copilot-dsh-warmer-proof.ts)
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 bash scripts/run-all-tests.sh
```

复现版本矩阵时，在 PATH 中选定准确的 Node 二进制，并使用临时 HOME，避免回归脚本的 nvm 设置切换版本。npm 缓存单独保留。四个定向命令全部接入完整回归。就绪预热仅调整测试准备过程，正常首轮的超时语义保持不变。
