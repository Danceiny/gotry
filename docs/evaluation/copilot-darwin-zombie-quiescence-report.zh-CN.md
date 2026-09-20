[English](copilot-darwin-zombie-quiescence-report.md) | [简体中文](copilot-darwin-zombie-quiescence-report.zh-CN.md)

# Copilot Darwin 僵尸静默报告

> 角色：归属 #518 清理超时机制并落地「按静默判定」修复。
> 状态：机制已在 OS／运行时层面证实；2026-09-19 事件本身未复现，事件级归属仍在 #518 保持开放。
> 上游：[copilot-cleanup-diagnostic-report](copilot-cleanup-diagnostic-report.zh-CN.md)、[architecture](../architecture.zh-CN.md)、[#518](https://github.com/Danceiny/gotry/issues/518)。
> 下游：Copilot 运行时维护者与回归审查者。

## 证据边界

所有实验仅使用本调查自有的分离进程组，并以只读 `ps` 观察 PID、PPID、PGID、状态与启动时间；不采集命令参数、环境变量、供应商输出或请求内容。复现运行使用真实 core proof（安装版 DSH SDK、worker、插件与本地 HTTP/SSE 夹具模型）并隔离状态目录；未访问真实供应商、账号、凭证或真实模型。本文不证明浏览器 UAT、供应商库存或生产延迟。

## 机制与验证

安装版 `@deepseek-ai/dsh-subprocess-local` `0.1.5-rc.1` 的 Darwin fallback 通过轮询 `kill(-pgid, 0)` 观察分离 worker 组，并把 EPERM 映射为「存活」；其 `waitForExit(signal)` 在调用方超时信号触发时返回 `false`，`ManagedDshRunPort.close()` 据此报出 `managed DSH process tree cleanup timeout`。同一运行时在 Linux 上已把「仅剩僵尸」细化为静默（`linuxProcessGroupHasLiveMembers`），Darwin 路径没有等价物。

本机受控 OS 级实验补上了缺失的一半：最后一个存活成员被杀后，仅持有未回收僵尸的组对 `kill(-pgid, 0)` 返回 EPERM（对 SIGKILL 同样 EPERM），只有 owner 回收后才恢复 ESRCH。僵尸无法被任何信号加速，因此在回收延迟下，2000ms 期限实际度量的是「回收完成」而非「终止完成」——这是观测失败形态的一个充分机制。这是已证实的机制，并不证明 2026-09-19 事件即由此发生；该事件仍未排除「未回收的存活成员（如不可中断状态）」或 PGID 身份复用等假设，而这正是 v2 诊断现在会记录的内容。

## 变更与兼容

- 清理诊断升级为 `managed-dsh-cleanup.v2`：每个快照成员新增只读 `startedAt`（`ps lstart`）与 `zombie` 标志，分组新增 `classification`（`empty`／`zombie-only`／`has-live-members`）、存活／僵尸成员计数、worker 存活期间一次性采集的启动时间锚点，以及 `workerIdentity`（`match`／`mismatch`／`worker-absent`／`unknown`），使 PID 复用可由证据证明。快照保持有界（250ms、32 个成员、仅 PID/PPID/PGID/状态/启动时间）且仅存在于失败路径。
- `ManagedDshRunPort.close()` 保持 grace 与期限不变。当观察期限届满时，先经同一安全快照核验静默：组内无存活成员即视为清理完成（僵尸只能等 owner 回收）；存在任一非僵尸成员——或组不可观察——仍以 v2 诊断失败。非 Darwin 判定与失败粘性语义不变。
- 新增 `groupObserver` 构造器接缝（与 `workerPath` 同风格），供证明在不对真实进程发信号的情况下布置判定；真实路径始终使用 ps 快照。

未放宽任何运行时依赖、期限、grace 或断言。回滚即诊断模块、run-port 判定与证明三者一起回滚；v1 消费方只会看到新的 schema 版本字符串。

## 复现矩阵

本机所有运行使用官方 Node 22.23.2 darwin-arm64 构建（tarball SHA-256 `61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6`）并隔离状态目录。历史超时未复现：修复前 main 上，单跑 1 次、持续 fork churn（2 个有界 churn 进程）下串行 6 次、加倍 churn 下 4 次全部通过且零清理超时；6 个满转 CPU spinner 下 3 次运行以另一种更早的形态失败——首个 planner 回合返回 `error` 决策而非 `operation`，发生在任何清理之前——记录为 core proof 的负载容忍边界，不属于 #518。修复分支在 churn 负载下 4 次全部通过。原始事件无 PID 证据，事件级归属保持开放；再次发生时将记录「仅剩僵尸」vs「存活成员」分类与启动时间身份。

## 验证矩阵

- 修复分支上 `npx tsc --noEmit` 与 `npx tsx scripts/smoke.ts` 通过（宿主默认 Node 26.9.0）。
- 扩展后的诊断证明覆盖注入观察失败、合成表（仅剩僵尸、存活、不可中断、空组、身份复用）、真实存活持有者在自有组内保持真实僵尸，以及 close 判定：仅剩僵尸与空组完成清理、存活成员仍带类型化诊断失败、真实运行时仍回收每棵树。
- `managed-dsh-run-port-proof`、planner/plugin/readiness/warmer 证明与真实 core proof 在修复分支上于 Node 22.23.2 与宿主默认版本下通过。
- 交付分支最终完整回归：退出 0，`ALL SUITES GREEN`，Node 22.23.2 下 676 秒；日志 SHA-256 `9c617a88684be2722d3cfd0fdf6e9f18507ba0bdc87bb6c8999ea3b73c6ed892`（同一修复在契约修正前的运行测得 583 秒，日志 SHA-256 `6a1ba839a2160071010612c9f852daf750b0527de2373ce3b208835f9f94f8bb`）。
