[English](copilot-cleanup-diagnostic-report.md) | [简体中文](copilot-cleanup-diagnostic-report.zh-CN.md)

# Copilot 清理诊断报告

> 定位：验证进程清理调查中的失败归属与首错保留。
> 状态：已实现；原始清理超时仍由 #518 跟踪，尚未解决。
> 上游：[架构](../architecture.zh-CN.md)、[#518](https://github.com/Danceiny/gotry/issues/518)。
> 下游：Copilot 运行时维护者与回归审查者。

## 证据边界

core proof 在隔离的 HOME 和状态目录运行实际安装的 DSH SDK、worker、CLI、GoTry 插件及本地 HTTP／SSE provider，覆盖运行时端到端路径。诊断 proof 使用真实受控进程树并注入观察失败，验证错误契约，不代表复现或修复了历史超时。这些证据均不证明浏览器 UAT、真实供应商库存、模型质量或生产延迟。

## 失败与判断

失败的主干整合回归使用 Node 22.23.2，耗时 736.98 秒，以退出码 1 和 `REGRESSION FAILED` 结束。日志 SHA-256 为 `17b3de0579b43b5f44ddefb58c579057711dcba240d4fbfab6c64d90fc60ba1b`。可见异常栈落在 core proof 的 `finally` 中普通 planner 的 `close()`，内层为托管进程树清理超时。相关源码与主干 `01b110a4219aa6d25586df844017f9d66675be89` 一致。

旧日志缺少进程身份，也可能遮盖更早的 body 异常。macOS 上安装的 subprocess runtime 观察 detached 进程组；未观察到组清空不能指出残留进程或确定原因。一次重跑通过不足以解决此问题。

## 修改与兼容

- 私有 worker 协议报告自身 PID 和父 PID；wrapper 接受首个合法的直接子进程身份。缺失或不是直接子进程时，身份保持未知。
- 任务与预热进程的清理错误分别携带角色、worker 退出状态、耗时、原有期限及 grace，并附有界进程组快照。仅保留 PID、PPID、PGID 和进程状态，不采集命令参数、环境、provider 标准错误或请求内容。
- 仅失败时采集快照，独立观察预算为 250 ms，最多返回 32 个成员，明确区分不可用与不支持。进程组观察仅支持已安装运行时在 Darwin 上的 detached fallback；Linux native scope 和 Windows Job 明确标记为不支持。PGID 表示预期进程组，不保证覆盖逃逸后代，也不能排除 PID 复用。安全快照 JSON 写入错误消息，使多层默认错误日志保留具体数值。
- 原有 TERM 到 KILL 的 500 ms grace 和默认 2000 ms 清理期限保持不变。失败的 close 不会因再次调用而变成成功；即使范围观察失败也消费派生 worker outcome，保留 [#513](https://github.com/Danceiny/gotry/issues/513) 跟踪的拒绝处理保护。
- core proof 将 body 首错放在前面，并按依赖顺序尝试后续清理。本地 fixture 服务关闭连接；仅在清理成功后删除隔离状态，失败时保留并输出路径。有界子进程验证错误遮盖、按序保留错误及现场保留，使用父测试当前的 Node 可执行文件。

没有新增运行时依赖、vendor 分叉、交易能力或架构边界变化。回滚时一起撤回诊断、worker 协议和测试改动；旧 worker 仍可工作，只是 PID 诊断未知。架构第十一节的系统形态、路线图和里程碑门禁保持原有事实；本报告和文档索引承载新增证据。

## 验证矩阵

基线为 `01b110a4219aa6d25586df844017f9d66675be89`。根目录及 `ts/` 均按锁文件安装；环境为 macOS arm64，Node 22.23.2 和 24.16.0。日志保存在本地工程证据包，结论同步至 issue。

| 检查 | 结果及限制 |
|---|---|
| 旧主干 wrapper，同一真实进程树诊断 proof | 按预期退出 1，失败在缺少类型化诊断的断言；仍回收实际子进程树。 |
| 注入超时与观察拒绝 | Node 22 和 24 退出 0；角色和 worker 身份保留，无私密错误文本，重复 close 保留失败，实际 worker 与孙进程均回收。这是故障注入。 |
| body 与两项清理同时失败 | 有界子进程验证旧行为遮盖首错，新行为按序保留错误，并执行后续全部清理尝试；清理失败时保留隔离现场。 |
| Node 22 真实 SDK core | root 两次运行退出 0，耗时 11.99 和 12.14 秒；第二次使用可移植的 Node 选择方式。审查修正后，root 再次运行于 9.53 秒通过，包含现场保留与嵌套错误日志对照。历史清理失败未再次出现。 |
| Node 24 真实 SDK core | 审查细化前后均退出 0，分别耗时 9.90 和 13.69 秒；core 日志摘要与 Node 22 相同。审查后的诊断 proof 也于 5.97 秒通过。 |
| 类型检查与 dist 兼容 | 类型检查退出 0（4.48 秒），dist 兼容检查退出 0（3.88 秒）。 |
| 完整回归 | 提交前候选退出 0，耗时 873.54 秒，末行为 `ALL SUITES GREEN`。最终提交的证据记录在关联 issue／PR。 |

旧 wrapper 负对照日志 SHA-256 为 `04867b22c1d1a3373f49382014edd2dcb027d0308c561638b18d113ba7d5d913`；Node 22 诊断日志为 `f35906fd42089060b4a85d8151cd06010c888fabf0717cd68e61c95a4e99122a`；root 两次 Node 22 core 日志均为 `c48aeb391d5c39136a369a7b8823943e8c89943ce380d6791c10a9f86baaf6a2`。

提交前完整日志 SHA-256 为 `bb15d2d598f06179a208eb74268495daf10e9d98948f8cce3690cc8d5a0972bd`，完成于 `2026-09-19T14:29:23.375253+00:00`。本次门禁覆盖冻结的运行时及测试源码；报告随后记录结果。最终提交的重跑仍是创建 PR 的前提。

## 复现与剩余门禁

在 PATH 选择目标 Node，使用临时 HOME，并将全部 live 开关置为 0。不得对 founder 共享状态运行这些检查。

```sh
(cd ts && npx tsc --noEmit)
node scripts/build-dist-compat-tests.mjs
(cd ts && npx tsx scripts/managed-dsh-cleanup-diagnostic-proof.ts)
(cd ts && npx tsx scripts/booking-copilot-dsh-core-proof-tests.ts)
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 ./scripts/run-all-tests.sh
```

原始超时仍需携带新诊断的复现，确认角色、退出状态与存活组成员。在证据支持修复并完成最终回归前，#518 保持打开。独立的 #510 终态和 #511 安装包启动调查仍沿用各自验收要求。
