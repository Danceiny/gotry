[English](dida-runner-stop-report.md) | [简体中文](dida-runner-stop-report.zh-CN.md)

# Dida 实时 runner 停止验证

> 定位／Role：Dida runner 停止、清理和显式开关的命令级证据。
> 状态／Status：场景报告已验证；最终提交的验收记录随 PR 发布。
> 上游／Upstream：[#502](https://github.com/Danceiny/gotry/issues/502)、[#504](https://github.com/Danceiny/gotry/issues/504)、[#515](https://github.com/Danceiny/gotry/issues/515) 与仓库合同。
> 下游／Downstream：实时 runner 维护者与 PR 审核者。

## 范围与实现

runner 要求 `GOTRY_SESSION_LIVE === '1'` 且凭证齐备，之后才创建临时目录或浏览器。它只调用一次既有 `sessionDidaSearch`，不重置限流、不重试终态。搜索结束或抛错后，先阻止新的辅助操作，立即尝试关闭浏览器，并行等待关闭与辅助任务结束；两项各有 5000 毫秒上界。清理未完成会报出具体阶段并以退出码 1 结束，不输出成功搜索结果。

PR [#505](https://github.com/Danceiny/gotry/pull/505) 合入主干 `7f4084492ee9d5acf9e41e9cc5269cb2d3e8198b`。两个索引冲突保留 Dida、SF 隔离和 Copilot 就绪报告，自动合并也保留对应回归入口。未改变 session 能力、供应商协议、持久状态或依赖。

## 场景矩阵与真实边界

测试在隔离临时目录中启动真实 runner 入口，源码原样复制。浏览器通信、Chrome 可执行文件和 session 回包使用合成实现。原始 DOM IIFE 在 `node:vm` 中针对最小 document／button 夹具实际执行，分别记录求值尝试、滚动和真实模拟按钮点击，求值尝试不再计为点击。无按钮的终态场景让辅助任务持续到搜索结束；hit 场景证明一次按钮点击及辅助任务提前结束。

| 场景 | 必须观察到的结果 | 结果 |
|---|---|---|
| challenged、cooldown、needs-login、needs-extension、error | 退出码 2；搜索一次、零限流重置、零按钮点击；终态后无新 DOM 调用；已调用关闭 | 五项通过 |
| hit，按钮存在 | 退出码 0；搜索一次、零重置、恰好一次按钮点击；已调用关闭 | 通过 |
| 搜索抛错 | 退出码 1；搜索一次、零重置、终态后无新 DOM 调用；已调用关闭 | 通过 |
| 开关未设、空串、0、false、随机值 | 创建浏览器前退出，退出码 1；零搜索、零网络尝试 | 五项通过 |
| 开关启用但缺少凭证 | 创建浏览器前退出，退出码 1；零搜索、零网络尝试 | 通过 |
| 求值等待关闭才结束 | 调用关闭并释放求值；关闭完成；终态退出码 2 | 通过 |
| 求值始终不结束 | 关闭完成；明确报出 `cleanup timeout: click assistance`；退出码 1 | 通过 |
| 浏览器关闭始终不结束 | 已尝试关闭；明确报出 `cleanup timeout: browser close`；退出码 1 | 通过 |

所有启用场景都断言浏览器标记与关闭调用。网络 trap 拒绝 fetch 尝试。只有临时 preload 缩短生产等待时间，将 5000 毫秒清理上界改为 200 毫秒，仍严格断言错误文本和进程退出码。测试强制超时属于失败，不算清理成功。每次运行前后都校验 canonical Playwright 文件哈希未变。

## 独立验证与失败对照

在 macOS arm64、隔离 HOME、锁文件依赖下，协调者独立复跑全部 16 个场景：Node 22.23.2 耗时 11.62 秒，Node 24.16.0 耗时 11.39 秒，均以退出码 0 通过。两份原始文本日志 SHA-256 均为 `39adccf333dcab13f0ab241d9d016fb508ce4ddf0fdfcecf64052bf18b5a097b`。这是 runner 命令级端到端验证，不代表真实供应商验收。

最终测试通过 `DIDA502_RUN_BASELINE=1` 执行固定版本的旧 runner。基线 `20d728e3668d302821bad0f8687ca8ef55d29ed5` 对非 hit 终态搜索三次、重置限流三次，结果之后仍继续 DOM 求值；非空非法开关会启动假浏览器并超时。旧报告中的「20 次点击」标签有误，实际只是求值尝试，未证明点击。当前无按钮夹具记录零点击，并独立观察额外求值。

清理对照使用旧 PR 提交 `9377cf1c39e95c1d8884ace34a0c69be9541691c` 与等待关闭才释放的求值夹具。旧代码先等求值再关闭，导致 runner 在 15 秒后被测试超时终止，始终没有关闭事件；修复后先调用关闭并以退出码 2 返回。该对照直接复现 [#515](https://github.com/Danceiny/gotry/issues/515)，证明此前通过的测试遗漏了循环等待。

提交前类型、构建兼容与完整回归均通过，退出码 0。完整回归耗时 859.02 秒，于 `2026-09-19T12:53:30.995581+00:00` 结束，末行为 `ALL SUITES GREEN`；日志 SHA-256 为 `8db5251862cf86e0851c71d3ec0075fa13034c9420161f216feafef9ca7270b5`。最终提交的本地复验与 CI 收据随后记录在 PR 中，不能用本段代替。

## 复现

```sh
(cd ts && npx tsc --noEmit)
(cd ts && npx tsx scripts/dida-runner-stop-tests.ts)
(cd ts && DIDA502_RUN_BASELINE=1 DIDA502_BASELINE_REF=20d728e3668d302821bad0f8687ca8ef55d29ed5 npx tsx scripts/dida-runner-stop-tests.ts) # expected failure
(cd ts && DIDA502_RUN_BASELINE=1 DIDA502_BASELINE_REF=9377cf1c39e95c1d8884ace34a0c69be9541691c DIDA502_ONLY_CLEANUP_CASES=1 DIDA502_CLEANUP_CASE=pending-evaluate-released-by-close npx tsx scripts/dida-runner-stop-tests.ts) # expected failure
node scripts/build-dist-compat-tests.mjs
GOTRY_SESSION_LIVE=0 GOTRY_HBCLI_LIVE=0 GOTRY_HOTELBYTE_SKILLS_LIVE=0 GOTRY_LAVISH_LIVE=0 bash scripts/run-all-tests.sh
```

根目录和 TS 依赖均以 `npm ci --no-audit --no-fund --strict-peer-deps` 安装，在 PATH 中选择 Node 版本并使用临时 HOME。完整回归已包含此命令。跳过项包括真实 HotelByte UAT、staicli 外部压缩包、可选 Agent Reach doctor、远端 skills 校验，以及真实 Lavish、供应商会话和 LLM 路径。

## 失败尝试与限制

早期测试草稿链接 canonical 依赖后写入 stub，覆盖了两个本地 Playwright 文件；该轮证据已废弃，文件已从校验过的锁文件压缩包恢复，工作树依赖也独立重装。当前测试使用独立依赖并检查哈希。一次根目录依赖不全的完整回归以退出码 143 停止；首次合入主干后的完整回归发现清理缺陷，也以 143 主动停止，两轮均不算通过。旧 PR 提交的 CI 失败在 Copilot stalled-provider 就绪夹具；主干已包含 #512 修复，因此更新提交仍须重新执行本地与 CI 验证。

没有执行真实 Dida 账号、供应商回包、扩展桥接或 canonical session 终态分类；相应实时验收继续由 [#272](https://github.com/Danceiny/gotry/issues/272) 跟踪。测试证明 runner 如何处理收到的终态，不证明供应商如何产生终态。AbortSignal 无法撤销已发出的 DOM 操作，上界只限制等待并报告未完成。搜索前的浏览器启动／登录失败，以及真实 Chrome 进程树回收，仍不在本报告证明范围内。测试不写入共享产品状态。

架构第 11 节核对：只有本报告和双语索引反映证据变化；系统结构、供应商可用性、里程碑验收与发布状态均未变化。
