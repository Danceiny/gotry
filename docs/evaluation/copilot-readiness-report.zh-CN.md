[English](copilot-readiness-report.md) | [简体中文](copilot-readiness-report.zh-CN.md)

# Booking Copilot 就绪与进程清理测试报告

> 定位：验证 #506、#508、#509 的运行时就绪、模型停滞计时和进程归属。
> 状态：2026-09-19 本地验证通过，后续 #510、#511 仍保持打开。
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

## 场景结果

| 场景 | 必要证据与实际结果 |
|---|---|
| 同一 port 就绪与模型停滞 | 阻塞真实 CLI 启动 1800 ms，预热持续等待且无模型调用。初始化后，请求包含 `booking_run_search`，到达本地 SSE，并在 3000 ms 内返回 `PLANNER_PROVIDER_TIMEOUT`。关闭后 worker 和 CLI 均退出。 |
| 冷启动 | 保持启动门阻塞。原有 1500 ms 轮次预算在零模型调用时返回明确类型的超时，两进程均回收。 |
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
