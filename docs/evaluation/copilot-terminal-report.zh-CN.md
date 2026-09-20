[English](copilot-terminal-report.md) | [简体中文](copilot-terminal-report.zh-CN.md)

# Booking Copilot worker 终止测试报告

> 定位：验证托管 worker 终止后，端口不会继续接收无限等待的请求。
> 状态：最终提交树于 2026-09-20 通过完整本地门禁，PR 已提交待审查。
> 上游：[架构](../architecture.zh-CN.md)、[#510](https://github.com/Danceiny/gotry/issues/510)、[就绪测试报告](copilot-readiness-report.zh-CN.md)。
> 下游：Booking Copilot 维护者与 PR 审查者。

## 证据边界

这是子进程生命周期回归：生产 `ManagedDshRunPort` 调用已安装的 dsh 子进程运行时，与真实的受控 worker 进程交换 JSON 行，验证操作系统退出、启动失败、请求结束与进程树清理。它不覆盖真实模型、浏览器交互、供应商预订或支付，不作为完整功能的业务验收结论。完整回归另行保留既有的本地 SDK／CLI／插件／模型夹具链路。测试使用临时目录；此处记录的验证调用使用隔离 HOME，不写入创始人的数据。

## 问题与设计

旧实现拒绝了 worker 退出时已有的请求，却没有保存终止状态。之后的 `run` 或 `warmup` 仍向已结束的 worker 写入，可能无限等待。最终负向对照失败，新 run 未在下一轮 `setImmediate` 前拒绝。

现在端口先记录安全的终止错误，再拒绝已有请求。后续调用直接拒绝，不分配请求编号，也不写入 stdin。正常退出与信号终止返回 `managed DSH worker exited`；子进程结果异常返回 `managed DSH worker failed`，不透传 SDK 原始错误。显式关闭保留原有错误和清理责任，没有增加重试、重启、延长时限或改变模型调用行为。

该改动修复 ADR-23 下既有的生命周期契约，没有引入新的架构边界。按架构 §11 核对后，系统形态、里程碑门槛、公开用法和已有架构债务均未变化；受影响的文档权威是本测试报告及其索引。

审查中发现的关联问题记录于 [#513](https://github.com/Danceiny/gotry/issues/513)：若清理观察在 worker 结果被消费前失败，旧关闭流程会留下无人处理的派生 Promise 拒绝。辅助故障注入测试使用真实启动失败的 handle，仅注入 SDK 契约允许的清理拒绝或超时。修复会立即把 worker 失败接收为结果值，仅在清理成功后再抛出，保留清理错误的优先级。这是合成异常覆盖，与下表的真实进程场景分开判断。

本分支等待 [#514](https://github.com/Danceiny/gotry/issues/514) 期间，main 合入了 [#518](https://github.com/Danceiny/gotry/issues/518) 的清理诊断，其 `close()` 已把 worker 结果按值接收（吸收了 #513 的修复）。交付分支合并该演进，并在其上保留本修复的终态语义：`run`／`warmup` 守卫仍以纯安全错误拒绝，`close()` 失败则表现为类型化的 `ManagedDshCleanupError`，稳定公开语义（`managed DSH worker failed`、`managed DSH process tree observation failed`、`managed DSH process tree cleanup timeout`）位于追加的安全诊断载荷之前。两个 proof 在合并树上断言该类型化契约。

## 场景矩阵

| 场景 | 必须观察到的结果 |
|---|---|
| 自然退出 23 | 已接收请求被拒绝；观察到退出后，新 run 与 warmup 在下一轮事件循环前拒绝。 |
| 外部 SIGKILL | 已接收请求被拒绝；新调用立即拒绝；关闭时清理仍存活的孙进程。 |
| 工作目录不存在 | 真实启动失败以固定安全错误拒绝已有和后续请求；重复关闭返回同一个有界拒绝。 |
| 显式关闭 | 两个等待中的 run 和一个 warmup 被拒绝；后续调用提示已关闭；重复关闭返回同一 Promise。 |
| 清理观察失败 | 注入拒绝与超时后，外层保留清理错误，重复关闭返回同一 Promise，没有未处理拒绝。 |
| 清理 | 有界关闭后，worker 与忽略 TERM 的孙进程均不存在；自然退出和信号退出后仍可幂等清理。 |

立即拒绝以事件循环断言验证，不是生产延迟承诺。已有请求的测试上限为 1500 ms，清理的外层上限为 2000 ms。清理失败 proof 在注入后对真实 provider 清理的观察预算取 provider 自身尺度（12 秒探测）：provider 单次观察调用自身可耗至其文档标注的 5 秒 systemd 查询预算，且进程内首次调用需支付 user-manager 激活成本，冷启动的 Linux CI 运行器上曾超过原 2 秒探测。所有可能失败的异步操作都会立即注册拒绝处理。

## 验证记录

环境：macOS 26.6.2、arm64；两个包根目录均按锁文件安装；dsh 子进程运行时为 0.1.5-rc.1。基线为 `3855f9e`（#518／#534 之后的 origin/main）；交付树为 `7d4bdbc`（main 合入本分支）。2026-09-19 的执行结束于 2026-09-19T11:34:29.019539+00:00；交付树上的最终执行为 2026-09-20T19:31:08Z 至 19:42:11Z。此处记录的验证调用使用隔离 HOME。宿主默认 Node v26.9.0 下的一次中间执行因隔离工作目录的测试环境缺陷失效（依赖符号链接破坏了构建脚本的仓库内 TypeScript 解析约束），与产品代码无关，不计为有效执行。

| 检查 | 结果 |
|---|---|
| 原终止行为，Node 22.23.2 | 预期 exit 1：新 run 未在下一轮 `setImmediate` 前拒绝。 |
| 原关闭行为，Node 22.23.2 | 预期 exit 1：注入观察拒绝和超时都产生了未处理的 worker 失败拒绝。 |
| 三个定向测试，Node 22.23.2 与 24.16.0 | 六条命令全部 exit 0；终止、已有请求与进程树、清理失败契约均通过。 |
| TypeScript 与 dist 兼容，Node 22.23.2 | 均为 exit 0。 |
| 完整回归，Node 22.23.2，2026-09-19 | exit 1，`REGRESSION FAILED`，1078.59 秒。FlyAI 酒店夹具失败，本次 Copilot 新增测试在该轮中通过。 |
| 合并树上的三个 managed proof，Node 22.23.2 与 26.9.0 | 终止、清理失败与清理诊断 proof 均 exit 0，断言类型化的 `ManagedDshCleanupError` 契约。 |
| 合并树上的 smoke 与 TypeScript | `SMOKE OK`；`tsc --noEmit` exit 0。 |
| 最终完整回归，Node 22.23.2，2026-09-20 | exit 0，`ALL SUITES GREEN`，663 秒，交付树 `7d4bdbc`。 |
| 双语结构、可读性与空白检查 | 通过。 |

生产源码 SHA-256：`6bf542c243e7dd57cf1717e03daf9d9c139772995fd2fe3f525664721ae17850`（合并树；合并前为 `68f5cde3f4b8f57ce9e14d41f52f7fca94bd4bf425d1e524806efeef74869138`）。最终完整日志 SHA-256：`a7d5072ac3df119285af1b595e3c599b907550a4e001089362d7b6777f349cc7`（2026-09-19 失败日志 SHA-256：`ef84759ec88a6eeedcdc60ea32cc87a2121aaa5bf1127e65185a43035cef604b`）。验证期间生产与测试源码指纹均未变化。负向对照日志指纹：终止行为 `c857b16e4daf9282ec40d7f0c643ae20329101796bca55bf4f49a80c4ac3f518`；清理行为 `7536108abb27e47f3acbf579a286e1afbf8bbf713069817b3fef45c4dfbc86ac`。两个对照均在隔离源码目录中，使用最终测试验证旧端口，不替换工作中的实现。

2026-09-19 的门禁失败记录于 [#514](https://github.com/Danceiny/gotry/issues/514)：`flyai-tests.ts:249` 期望酒店畸形条目比例 `1/2`，实际收到 `exit -1`。#514 已由 PR #534 收口（终止携带陈旧 429 文本的 fail-closed 分类），FlyAI 各套件在 2026-09-20 的最终回归中通过；当时的环境压力读数始终未转化为根因结论。

更早一轮完整回归在审查发现 #513 后主动停止，不计为通过。中止与失败的 2026-09-19 执行不满足最终 SHA 门禁；2026-09-20 在交付树上的执行满足该门禁。PR #535 的首轮 CI 发现一处红：Node 24 任务在清理失败 proof 注入后的真实清理观察处失败（`real handle cleanup observes an empty managed range`，`false !== true`）。其前所有 #510／#513 验收断言在同一任务内通过，terminal proof 的启动失败关闭（同一真实 `waitForExit` 契约）亦在该运行器通过；诊断结论是 proof 侧 2 秒探测低于 provider 自身 5 秒 systemd 查询预算在冷启动 CI 运行器上的实际耗时（进程内首次 user-manager 激活）。探测预算已对齐 provider 尺度（12 秒），断言本身未变；这是测试预算修正，不是产品改动。可选的真实 HotelByte、远端 skills、会话／登录与 Lavish 探针、外部 STAICLI 包及可选 Agent Reach doctor 断言仍在报告范围之外；历史 Python oracle 不在当前回归入口内。

## 复现与限制

```sh
(cd ts && npx tsc --noEmit)
(cd ts && npx tsx scripts/managed-dsh-terminal-proof.ts)
(cd ts && npx tsx scripts/managed-dsh-close-failure-proof.ts)
(cd ts && npx tsx scripts/managed-dsh-run-port-proof.ts)
node scripts/build-dist-compat-tests.mjs
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 bash scripts/run-all-tests.sh
```

在 PATH 中选择目标 Node，使用临时 HOME，避免回归入口经用户 nvm 配置切换版本。新测试已接入完整回归。真实供应商与模型验收仍在本报告范围之外。独立的干净消费端 SDK 启动调查 [#511](https://github.com/Danceiny/gotry/issues/511) 保持打开，回归变绿不能解释其先前失败。

清理证据覆盖本次受管进程组，不证明主动脱离该进程组的后代也能被清理。
