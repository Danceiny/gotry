[English](flyai-drain-bounded-report.md) | [简体中文](flyai-drain-bounded-report.zh-CN.md)

# FlyAI stderr drain 有界化报告

> 角色：收尾 #516——FlyAI CLI 主进程退出后，仍持有 stderr 管道的后代不能再让 `flyaiSearch` 无界等待；进程树策略不再散落为各 helper 的私有副本。
> 状态：机制已交付并锁定回归；全程未触碰真实 FlyAI 端点、账号或模型。
> 上游：[architecture](../architecture.md)、[effect policy](../design/effect-interpreter.md)、[#516](https://github.com/Danceiny/gotry/issues/516)、[#514](https://github.com/Danceiny/gotry/issues/514)、[#523](https://github.com/Danceiny/gotry/pull/523)。
> 下游：能力层维护者（flyai / hbcli / anything）与 PR 评审。

## 资源所有权（单一边界，无各 helper 自建策略）

| 资源 | 归属 | 上界 |
| --- | --- | --- |
| CLI 主进程生命周期 | `spawnBounded`（`capabilities/spawn-bounded.ts`，与 hbcli/anything 共享） | `timeoutMs` deadline → SIGKILL 整组 |
| 后代进程树 | 同一 `spawnBounded` 私有进程组 | abort → SIGTERM 整组 → 500 ms 宽限 → SIGKILL；有界结算（hard settle） |
| stdout | flyai 包装层按次开/读/删的临时文件（#84 抗截断语义；保留） | 文件语义，无管道缓冲上限 |
| 主进程退出后的 stderr 管道 | `drainMs` 窗口（默认 3 000 ms；查询级可调） | 到点 → SIGKILL 整组 → 以 `drainTimedOut` 结算 |

改动前，同一保证只以 `flyai.ts` 文件内副本的形式存在；#516 验收明确要求优先复用仓库已有进程组清理边界。`spawnBounded` 新增两个 opt-in 旋钮（`stdoutFd`、`drainMs`）以及 exit `signal`/`drainTimedOut` 结果面；hbcli/anything 行为不变（默认参数下其套件与 `spawn-bounded-abort-tests` 保持全绿）。

## 退出原因与 drain 超时的区分（不完整收集不写成成功事实）

`FlyaiLocalTermination` 新增 `drain-timeout`。主进程已退出（退出码保留在错误消息里）但管道在 `drainMs` 内未释放时，杀组并 fail-closed：verdict `error`、`retryable: false`、绝不暴露 `options`，且该分类先于任何 HTTP 文本扫描——drain 时限前打印的陈旧 `429 Trial limit` 不会被改判 `needs-setup`。注册工具入口在此路径零库存事实。窗口内释放则保持普通 exit-0 语义（`hit`），drain 窗口本身不制造失败。

## 回归锁（真实注册工具入口）

`ts/scripts/flyai-tests.ts` 用例 1d 经 `apply` → `gotry_flyai_search` → 生产 effect，配合真实假 CLI 子树：

- 持管道后代（`sleep 30 &`、有效 hit 载荷、exit 0）：有界返回（≥ drainMs 且 < 3.5 s）、`localTermination: 'drain-timeout'`、零事实、持有者 PID 读回确认已死、无 stdout 临时文件泄漏；
- drain 超时携带陈旧 429 文本：单次尝试、verdict `error`、无 `setup` 指引；
- 窗口内释放（`sleep 0.2 &`）：`hit` 且照常落 typed positive fact——正常退出有界语义保持。

信号、deadline、spawn 失败与空退出四形态在 1c 用例中沿用同一共享边界，保持单次 fail-closed 锁。

## 验证

- `npx tsc --noEmit` exit 0；`flyai-tests`（含 1b/1c/1d）连续 4 轮全绿；`spawn-bounded-abort-tests` 8/8；`hbcli-tests` 8/8；`anything-tests` 7/7；`smoke` OK（隔离 stateRoot）。
- 全量回归与 Node 22/24 矩阵以交付 PR 的 CI 为准（两个全量回归 job 须全绿）；耗时与完整日志 SHA-256 记录在 PR 与 issue 评论中。
- 没有为掩盖挂起而放宽任何时限：上述每个界都是结算界，持管道后代的挂起夹具被断言必须终止，而非跳过。

## 复现

```sh
(cd ts && npx tsc --noEmit)
(cd ts && npx tsx scripts/flyai-tests.ts)
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 bash scripts/run-all-tests.sh
```

## 剩余边界

- 逃出进程组的后代（如 `setsid`）不在组信号覆盖内；这是 `spawn-bounded` 已文档化的边界——需要更强证明的调用方必须按已知 PID 读回（用例 1d 即这么做）。
- win32 上 `spawnBounded` 无条件 detached，而旧 flyai 副本在 win32 不 detached；win32 不是本仓库的受测平台（CI 为 Linux，开发为 Darwin）。
