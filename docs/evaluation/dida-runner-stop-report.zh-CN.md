[English](dida-runner-stop-report.md) | [简体中文](dida-runner-stop-report.zh-CN.md)

# Dida 实时 runner 停止验证

> 定位/Role：Dida 实时 runner 停止、清理和 opt-in 闸的命令级证据。
> 状态/Status：frozen(2026-09-19)
> 上游/Upstream：GitHub issue #502/#504 与 GoTry 仓库合同。
> 下游/Downstream：`ts/scripts/session-dida-live-e2e.ts`、对应回归命令和审核实时会话证据的维护者。

本报告覆盖 GitHub issue [#502](https://github.com/Danceiny/gotry/issues/502) 与 [#504](https://github.com/Danceiny/gotry/issues/504)，分支为 `fix/dida-live-stop-502`，基于 `origin/main` 提交 `20d728e3668d302821bad0f8687ca8ef55d29ed5`。

## 范围与实现

runner 现在要求 `GOTRY_SESSION_LIVE === "1"` 后才创建浏览器进程；每次只调用一次 `sessionDidaSearch`，移除节律闸重置与重试循环，并在 `finally` 路径中 abort、等待并发 click assist 完成后再关闭浏览器。实现提交为 `af1060c28e9b6c1dc40341a553093e6d21b2c8b6`。

## 复现与修复后命令级 E2E

命令 `cd ts && npx tsx scripts/dida-runner-stop-tests.ts` 会在临时 overlay 中启动真实的 `scripts/session-dida-live-e2e.ts` 入口。runner 源码原样复制。session 模块、浏览器适配器和 Chrome 可执行文件使用合成实现；测试专用计时器缩短等待，fetch trap 拒绝网络尝试。事件记录全部 assist DOM 操作、点击、终态结果和浏览器关闭；断言要求 assist 已启动，且终态后不再发起新的 DOM 操作。本轮每个结果前观察到两次点击与两次 overlay 操作；测试要求至少一次点击，不绑定受调度影响的精确次数。

| 用例 | 预期进程退出码 | search 次数 | 闸重置次数 | assist 清理 | 结果 |
|---|---:|---:|---:|---|---|
| `challenged` | 2 | 1 | 0 | 结果前点击 2 次；浏览器已关闭 | 通过 |
| `cooldown` | 2 | 1 | 0 | 结果前点击 2 次；浏览器已关闭 | 通过 |
| `needs-login` | 2 | 1 | 0 | 结果前点击 2 次；浏览器已关闭 | 通过 |
| `needs-extension` | 2 | 1 | 0 | 结果前点击 2 次；浏览器已关闭 | 通过 |
| 普通 `error` | 2 | 1 | 0 | 结果前点击 2 次；浏览器已关闭 | 通过 |
| `hit` | 0 | 1 | 0 | 结果前点击 2 次；浏览器已关闭 | 通过 |
| search 抛异常 | 1 | 1 | 0 | 异常前点击 2 次；浏览器已关闭 | 通过 |

同一命令还验证 #504 的 unset、`0`、`false`、随机非 `1` 值以及缺少凭证场景。每个场景都以退出码 1 在创建 fake browser 标记前退出，search 调用为零，network trap 为空。修复后日志为 `/tmp/gotry-dida-stop-502-root-e2e.log`。

## 基线证据

测试使用固定 ref `20d728e3668d302821bad0f8687ca8ef55d29ed5`，以 `DIDA502_RUN_BASELINE=1 DIDA502_BASELINE_REF=20d728e3668d302821bad0f8687ca8ef55d29ed5` 取得旧 runner，并通过同一 overlay 执行。对于 `challenged`、`cooldown`、`needs-login`、`needs-extension`，旧 runner 都调用三次 search、重置三次节律闸，并产生二十次 assist 点击；assist 在终态结果后仍继续。旧 runner 对非空非法 live flag 也会启动 fake browser 并超时，证明 #504 的闸缺陷。基线日志为 `/tmp/gotry-dida-stop-502-root-baseline.log`；该日志故意为红，不作为通过证据。

测试草稿曾短暂把完整 `node_modules` 目录链接到 overlay 后写入 stub；该草稿覆盖了本地 Playwright 的两个文件，结果已废弃。两个文件已从锁文件固定的 1.63.0 npm 压缩包恢复，恢复前验证 SHA-512，恢复后验证真实包可导入。随后工作树通过 `npm ci` 独立安装依赖。最终 harness 使用独立的临时依赖目录，并在测试前后校验 canonical `playwright-core/package.json` 与 `index.js` 的 SHA-256 未变化。

首轮完整回归的工作树环境不完整：只安装了 TS 依赖，根目录构建无法加载 TypeScript，后续存活性夹具缺少 `dist`。该轮以退出码 143 终止，保留日志 `/tmp/gotry-dida-stop-502-full-incomplete-env.log`，不作为通过证据。正式重跑前，根目录与 TS 依赖均已按 CI 的严格 peer 命令安装；此前失败的存活性夹具在完整环境下通过。

## 环境与验证

执行日期为 2026-09-19。环境为 macOS arm64、专用命令使用 Node 24.10.0，完整回归脚本切换到 Node 24.16.0；TypeScript 5.9.3、tsx 4.23.13、playwright-core 1.63.0、dsh-session 0.1.5-rc.1。依赖来自已提交的锁文件。root 独立审查最终差异，复跑命令 E2E 与类型检查，并负责完整回归验收。

| 检查 | 实测结果 |
|---|---|
| 最终命令 E2E | 12/12 场景通过，退出码 0；七种搜索结果与五个授权闸场景 |
| 最终测试运行旧 runner | 按预期失败，退出码 1；复现重试、闸重置、终态后操作与错误授权闸 |
| TypeScript 类型检查 | 通过，退出码 0 |
| 仓库完整回归 | 通过，退出码 0；`ALL SUITES GREEN` |
| 文档检查 | 64 对双语文档、8 个读者入口文件通过；差异空白检查通过 |

在实现提交上复现：

```sh
npm ci --no-audit --no-fund --strict-peer-deps
cd ts
npm ci --no-audit --no-fund --strict-peer-deps
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsx scripts/dida-runner-stop-tests.ts
DIDA502_RUN_BASELINE=1 ./node_modules/.bin/tsx scripts/dida-runner-stop-tests.ts # expected exit 1
cd ..
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 bash scripts/run-all-tests.sh
```

基线默认使用上面的精确旧 SHA。完整回归日志为 `/tmp/gotry-dida-stop-502-full.log`。这些本地日志是辅助产物；已提交的场景表与命令保留可审阅、可复现的证据。保留四项显式跳过：HotelByte 真实 UAT、外部 staicli 压缩包验证、可选 Agent Reach doctor（七个断言）、需要显式开启的真实 Lavish 探针。其他供应商实时路径和真实 LLM 巡检保持关闭，不据此宣称真实功能验收通过。

最终完整回归结束时间为 `2026-09-19 08:40:15 UTC`。本地完整日志 SHA-256 为 `65dd68eeca04983cb917612cd71b693de187a84bf7167eeb26b2827b92515f6b`。

## 证据边界与剩余限制

这是合成的命令级 runner E2E：它覆盖真实 runner 入口、登录流程控制、并发 assist、终态退出映射、清理和严格 opt-in，且不访问供应商。没有运行真实供应商 E2E，因为那需要用户登录和供应商网络访问。因此，真实 Dida 账号、浏览器登录、扩展桥接和 portal 回包仍需另行提供 live supplier 验收证据。

本次接受范围是 #502/#504 的 runner 控制流程修复。AbortSignal 无法撤销已发出的浏览器操作；runner 停止新增辅助操作并等待当前任务结束。搜索前的浏览器启动或登录失败、真实 Chrome 进程回收，以及供应商和扩展桥接行为，均不由合成 browser-close 断言证明。测试不会写入共享 `ts/dsh-runtime/gotry-state`、`ts/gotry-state` 或 `gotry-state` 数据。
