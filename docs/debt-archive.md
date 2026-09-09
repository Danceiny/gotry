# 已清偿债务存档

> 定位:已清偿债务的追加式存档——每笔债的清偿时间、方式与证据锚点;开着的债与工作面只在 [`architecture.md` §10.1](architecture.md#101-未清偿工作面)。
> 状态:living(只增不改:条目从 §10.1 勾销时迁入,迁入后正文保持原样,历史保真)
> 上游:[`architecture.md` §10](architecture.md#10-债务清单引擎细节工作只能来自这里)——债务只能在该表诞生;清偿即迁入本文件,不在权威面保留
> 下游:reviewer 与考古——查「某笔债何时、以何证据清偿」;本文件不承载当前状态,不属 §11 六状态面

## 速览

- 本文件只回答一件事:每笔已清偿债务何时、以何证据清偿。
- 新条目只能随 M-exit 勾销从 `architecture.md` §10.1 迁入,迁入后不改写(版本历史归 git)。
- 要接的活不在本文件;工作面始终是 `architecture.md` §10.1。

> 编号备注:`D-24` 曾被会话扩展 onboarding 与事实闸覆盖面重复占用;事实闸债务(仍在 §10.1 工作面)沿用 `D-26`,本存档中的「D-26-bridge」为旧桥钉住 CLI 债的历史归档别称,与活跃 D-26 无关。

## 存档表


| 债务 | 状态 / 清偿 |
|---|---|
| D-1 双引擎算术复制 | **已清偿**(统一模型落地,洱海对账等价) |
| D-2 TS unsatCore 竖线 | **已清偿**(coreOf 剥竖线+回归断言) |
| D-3 LLM 未进环 | **已清偿**(S4 由 MiniMax-M2 完成,`bb880f3`;mock 留作回归夹具,ADR-8 兑现) |
| D-5 时区语义 | **已清偿**(EK329 官网逐分一致) |
| #290 DSH alpha.1 公开契约兼容 | **已清偿**:persona 经 `personaPrefix` / `personaSuffix` 投射(legacy `persona:` 不投影);桥 call handler 结构性归类(`timed_out` / `spawn_failed` / `runner_failed`)。详见 [`architecture.md`](architecture.md) §9 #290 条目、§1 状态速览、`ts/scripts/benchmark-environment-bridge-e2e.ts` 中 source+packaged 普通产品人格(personaPrefix + 展开 `今天是 YYYY-MM-DD`)抓取证据 |
| D-4 gate/卡片无承载界面 | 已清偿,详见下方 |
| D-4a'(agent-reach 100% follow) | 已清偿,详见下方 |
| D-4\'(Anything 数据接入) | **已完成 2026-08-23**: gotry capabilities/anything.ts 11 套实测 5/5 + hbcli `search anything` 子命令 + hotel-be `/api/search/anything` `@path` 注解;三仓 commit 闭环(244a0ae/c38ff65d1/43236a0) |
| D-6 红眼睡眠模型未校准 | **已校准 2026-08-28**:红眼航段落地后接驳(机场→住处/办公室)乘车补眠回血(1h≈+5%,上限 80)——对账真值:引擎原算 75%(机上睡眠),你真实体感 80%(75+1.5h 路上补眠);落地补眠此前未算,现加 `groundRecoveryMin` 参数;EK329 精力 75→79(45min 接驳×5%/h≈+4),unified 断言同步 |
| D-7 deprecated 层仍承重 | 已清偿,详见下方 |
| D-8 对话循环不进 CI | **已清偿**(replay 带终态断言 + 异步工单跨进程闭环 + smoke 进 `run-all-tests.sh` §5-7) |
| D-10 slot→spec 求解桥接未做 | 已清偿,详见下方 |
| D-11 `npx tsc --noEmit` 存量 14 错 | **已清偿**(1bf9671,语义零变更:tsc 0 错;smoke/memory §18 全过;17 套 ALL GREEN) |
| D-23 效应解译器迁移未完成(ADR-18) | **已清偿 2026-09-04(issue #115)**:六渠道入效应注册表,23 工具外部依赖面全收敛 effect_interpreter.v1(没有策略表行就没有效应);effect-tests §12 四组断言 |
| D-27 vendored 仓内形态 Node 兼容窗口断裂 | **已清偿 2026-09-04(issue #120)**:`selectDshRuntime` 删除 legacy vendored 回退,dsh 解析只认 root manifest/依赖闭包,找不到即 fail-closed 指重装;`DshRuntime.source` 收敛 `'root'`;§48 e2e 断言改为「非 benchmark 也不再回退 vendored」。残余 `ts/dsh-runtime/vendor/` 目录属锁一致性面,另行处置 |
| D-32 state-cli 租户参数串位与未隔离命令扩面 | **已清偿 2026-09-08(issue #226/#241)**:集中 parser 剥离 flag 值,拒绝未知/重复/缺值/非法 numeric(含 `.5`/`+.5`);`tick`/`export`/`whatif` 对非 local 在 mkdir/openDb/solve/write 前 fail-closed;跨进程 §29 覆盖零目录创建、root hash 不变、合法顺序等价与 tenant scope 读面。#241/#243 已入 main并关闭 |
| D-26-bridge 扩展在线时默认桥钉住 CLI(历史归档别称,详见下方) | 已清偿,详见下方 |
| D-25 扩展商店上架(ADR-21 分发 B 轨) | 已清偿,详见下方 |
| D-14 playwright-core 分发面(RFC) | **基本清偿 2026-08-30**:传输主载改自研扩展桥(零新依赖,node:http);puppeteer-core 降为 cdp 显式后备车道的可选依赖(动态导入+缺包优雅降级);`extension/` 进 npm files 白名单,`gotry setup` 负责落位与加载指引。**残余**:D-16 上游发布面断裂修复前,session 面在 npm 干净安装下的端到端实测未完成(残余追踪 = [#272](https://github.com/Danceiny/gotry/issues/272)) |
| D-12 loopx RFC 映射升级四接缝 | **已全部落地(RFC accepted 2026-08-27)**:S1 tool-packet envelope(ADR-13);S2+S3 记忆效用 sidecar + wish 触达 0..1(ADR-14);S4 WriteGate L0-L4 渐进授权词汇进 roadmap M5 交付物(2026-08-28);多用户 AaaS 方向见 RFC §6.5 远期采纳面 |
| D-16 上游 dsh 发布面断裂 | 见下方「D-16 上游 dsh 发布面断裂」 |
| D-24 会话扩展 onboarding UX 缺口(issue #21 隐性状态) | 见下方「D-24 会话扩展 onboarding UX 缺口」 |
| D-17 Z3 WASM race(README Known limitation) | 已清偿,详见下方 |
| D-20 六状态面里程碑口径漂移 | **已清偿 2026-08-29(Issue #19)**:六状态面统一为「M3 真实 evidence 未收口;M4 为 founder 授权并行,不是 M3 Exit 证明;M5/M6 仅受各自 Entry gate 开闸」。后续不得把工程交付、发布或并行切片等同于里程碑退出证据。 |
| D-21 async 非 4/4 被误结算为成功 | 已清偿,详见下方 |
| D-32 ledger tenant scope 只落 schema 未贯穿事件/fold | **已清偿 2026-09-08(issue #224)**:`insertEvent` 写当前 tenant,`readEvents`/fold/rebuild 全带 tenant 条件,`wish.updated` 同 id 查当前租户 item;legacy JSON/JSONL 与 v1 DB 只归 `local`。新增 run-all §28/§36 断言覆盖非 local owner、同 id/idem_key、交错 update、跨进程 reopen、A rebuild 不影响 B/local、重复 rebuild、booking saga 审计 owner。已被旧 bug 写成 `local` 的非 local 历史事件缺少可审计 owner,不得自动猜修;有外部证据时另走人工 data-repair issue/PR。 |
| D-34 可选能力 onboarding 缺口(#258/#267) | **已清偿 2026-09-09(#258;#267 = #266 合并后的 post-merge 加固)**:交互式 `gotry web` 启动前无可选能力配置面;现由 per-launch onboarding 复用 `doctor --fix` 幂等安装器。#267 补齐 awaited POSIX onboarding process group、bootstrap installer bounded process group、outer grace > installer TERM+SIGKILL budget、0700/0600-wx result 通道与 §21c/§21f/§21g stubborn installer 信号/timeout fixture。M4 UX 质量线,不计入 #20 Exit。详见 [`architecture.md` §9](architecture.md#9-演进时间线唯一来源-roadmapmd-的-m0-m6此处只保留原则与现状) |
| D-35 Node 26 dist 构建 API 移除 | **已清偿 2026-09-09(issue #265)**:移除 Node 已删除的 `stripTypeScriptTypes(...,{mode:'transform'})` 路径,改由根 manifest + npm/pnpm 双锁精确固定 TypeScript 5.9.3 并显式产出 ESM。Node 22/24 保留 typecheck + 全栈 CI,另以 Node 22/24/26 focused matrix 验证 exact source→dist、资产字节、无相对 `.ts`/CommonJS wrapper、入口与关键动态 import；Node 24 独立 pnpm frozen-lock job 防直接依赖的 `.pnpm` 解析布局回归。clean-archive release builder 先在隔离 source 内严格 `npm ci --include=dev`,再从提交锁派生剥除 build-only TypeScript entry 的最终 runtime manifest/lock 并严格 `npm ci --omit=dev`;builder proof 拒绝 TypeScript 出现在 runtime package/deps/manifest。该 M4 工程质量证据不关闭 #20/#136/#137 的真实 gate。 |
| D-36 酒店日期闸缺位(hotel-date-gate) | **已清偿 2026-09-09(issue #283)**:实现与边界详见 [`architecture.md`](architecture.md) §1.2;共享 `parseAbsoluteDate` 拒非法日历日,酒店消费边界拒缺失日期、溢出和错误顺序,失败不 dispatch 并返回 `input_required`,有效日期与静态降级兼容。隔离 fixture 证据不构成真实供应商准入。 |

**D-24 会话扩展 onboarding UX 缺口(issue #21 隐性状态)**

- **部分清偿 2026-08-30(founder 实测)**:实证「能装≠装到能用」,降到 **3 次点击 + 0 次终端命令**(5 步 wizard + 剪贴板 + GUI 面板 + health-watch 自动重放);`ts/capabilities/session/{wizard,health-watch}.ts` + `ts/scripts/health-watch-cli.ts` + bootstrap `wizard` 子命令 + run-all §40。
- **2026-09-02 商店上架 + 职责返交**:wizard 撤销 5 步形态,`sessionFlightSearch`/`sessionLogin` 在 `needs-extension` 时返回 `verdict.installUrl`,dsh UI 直接渲可点链接——用户侧进一步降到 1 次点击(Chrome 商店「添加至 Chrome」)+ dsh 自动 retry,gotry CLI 完全不介入。

**D-16 上游 dsh 发布面断裂(Round 5 工程面已清偿)**

- **已验证解法②并落地 2026-08-28(记忆域 lane)**:D-16 前提有误——npmjs 上 dsh-scope **有完整 0.1.x**(0.1.1-rc.2 在列;lane 查的是滞后的内部 bnpm 镜像)。根 dependencies 已显式钉 `dsh-scope@0.1.1-rc.2`,干净安装实测:ERESOLVE 仅降级为 warning、ledger/index/dsh-tools 全部 import OK、五导出齐。rc.10 已发布(founder 确认制下 agent 执行:web 登录 + 浏览器二次验证,恢复码被 npm 拒收改用 web OTP 通道)。
- **2026-08-29 增补**:dsh 家族 0.1.2-alpha.1 未发 npm 时,以 `ts/dsh-runtime/vendor/` 全量源码 tarball 暂时解除 repo 工作副本堵点。
- **Round 5 清偿**:root manifest、package-lock 与 root pnpm importer 把公开 npm `0.1.2-alpha.3` closure 的 216 个 `@deepseek-ai/dsh*` 包全部声明为精确直接依赖,publish preverify 永久拒绝名称集合漂移、漏钉、混版与 range;source/package runtime root-first 解析。source 普通运行保留 `ts/dsh-runtime/` cwd 与状态连续性,package/benchmark 使用调用目录隔离。legacy alpha.1 vendor 不再承载 benchmark 或推荐源码安装路径,只保留解析兼容且不承诺可运行。发布 GoTry 新版本仍受 founder 确认制与独立发布闸约束,本轮不发布。

**D-4 gate/卡片无承载界面**

**词表内赎回 2026-08-22**:feasibility + 酒店/天气/Anything/AgentReach 五工具 presentResult 结果卡(可行性:候选判定+预算行;酒店:N 家(实时/静态);天气:ok/降级;Anything:N hits;AgentReach:✅/🔧/📦/❌ verdict)+ 12 工具 kind 图标分类(search/fetch/execute/edit,零 other);**地图位已解 2026-08-22**:宿主插件 dsh-map-tools v0.5.1(7 个 map_* 原生工具:驾/公/步/骑路线+地理编码+POI,零 key 走 OSRM,高德可后配)。当前 source/package 优先使用随包 `ts/dsh-runtime/vendor/dsh-map-tools/` MIT payload，settings 接线走真实 `SettingsProvider.prototype.installSection`(0.1.2-alpha.3 与 0.1.5-alpha.1 均已发布) + 普通 namespace 字符串；旧 source/npm 布局只作兼容回退；外部 npm 依赖因 rc peer 与 DSH alpha closure 冲突而移除(运行时锁 alpha 而 map-tools peer 要求 `>=rc.1`,semver alpha<rc 必 ERESOLVE;现 0.1.5-alpha.1 230 包闭包,#268)，§49b 对 clean tarball、7 工具、settings watch/reload/dispose 和零网络坐标路径 fail-closed；patch 条目占位、payload 缺失时整块剔除不挡启动;root `./gotry` 统一走 inner。

**D-4a'(agent-reach 100% follow)**

**已完成 2026-08-23;2026-08-22 wrapper 化**: Agent-Reach v1.5.0 装于 .venv(与 z3-solver 同址);gotry 侧为薄壳 —— agent-reach-bridge.py 反射桥(get_channel+getattr 直调上游注册表)+ agent-reach.ts 管道层,零渠道知识,上游加渠道零改动;gotry_agent_reach(action=reach 反射 / status 真 doctor);needs-setup 透传上游 check() 原话。

**D-7 deprecated 层仍承重**

**大部赎回**:dsh 插件进程内路径切轨 solveChoiceSegment(枚举,~0ms)、cli.py 桥切轨 solve_choice_segment、diff-test 切轨统一模型对统一模型;engine/journey 退纯 oracle(保留为金标准对照)。**尾债清偿 2026-08-22**:删 build_plan.py + gotry_async/demo.py + run-golden-case.sh(已断:调 rc.3 删除的 cli.py);py 树仅剩 gotry_feasibility oracle 对照 + 其 unittest。

**D-10 slot→spec 求解桥接未做**

**已清偿 2026-08-27(三切片)**:A `slot-spec.ts` 解析层(锚点卡词表/绝对/+N → 绝对日期,词表外 unresolved;time-eval §5);B 工具面接线(`gotry_hotel_search` 日期槽位收逐字表达,unresolved 降级无日期搜索+date_notes,smoke §8);C spec 链路一致性闸(runTurn 求解前比对,分歧不求解、追问确认,replay 尾段)。**ADR-12 复审结论:设计成立**,解析范围必须有界(只解析锚点卡词表,不做开放式中文相对日期解析——被拒备选即维护黑洞)。**闸范围边界(2026-08-28 真模型巡检修正)**:槽位 v1 只有 trip 级主日期,闸仅校验恰好一个带日期段的 spec;多段行程逐段日期无槽位真值,不判(金标准六段行程曾被全段误判分歧拦死求解,巡检抓出后收窄,多段旁路回归进 replay 尾段)。

**D-26-bridge 扩展在线时默认桥钉住 CLI**(历史归档别称;§10.1 活跃 D-26 = 事实闸覆盖面缺口,公开追踪 = #273)

**已清偿 2026-08-30**:`server.unref()` 不会自动解开已接受 socket 与 parked 长轮询 timer,导致 `SMOKE OK` 后进程仍存活;默认桥对两者 `unref`,active submit timer 与 `keepBridge=true` 保持引用。§38 子进程红→绿 + §40 9/9 + 真扩展 smoke exit 0 守住。

**D-25 扩展商店上架(ADR-21 分发 B 轨)**

**已清偿 2026-09-02**:Chrome Web Store 过审发布 v0.1.0([商店页](https://chromewebstore.google.com/detail/gotry-session-bridge/oeajpiccmonococjcegddlooeeohlbgd)),一键装 + 自动更新通道打通。上架实测坐实材料预案——商店用自己签名 key 重签、不认 manifest 固定 key,商店版 ID 与 unpacked 固定 ID 不同;影响面按预案收口:桥 Origin 白名单双通道同信(`EXTENSION_ORIGINS`,§38 新增商店源断言),扩展代码/manifest 零改动。Node 侧保留 extension 文件/`manifest.key` 预检,`sessionFlightSearch`/`sessionLogin` 在 `needs-extension` 时以 `installUrl`/`installAction` 交 dsh UI,旧 wizard 不再承担安装职责;#117 自适应文案已清偿 D-24。

**D-17 Z3 WASM race(README Known limitation)**

**复修清偿 2026-09-08(issue #227)**:08-29 的单例+互斥修掉三模块多实例与显式并发,但 Node24 全栈 run-all §30 仍出现间歇 `Aborted(Runtime error: The application has corrupted its heap memory area (address zero)!)`。新增根因证据:① 冷启动并发 `getZ3()` 在 await 后缓存 Promise,可创建多个 high-level Context 对象；② `z3-solver@5.2.0` high-level `FinalizationRegistry` cleanup 直接调用 native `dec_ref`/`*_dec_ref`,会在 GC 时机越过 `withZ3` 与 actual native check 并发。修复锚点:`z3-shared.ts` Promise 先缓存 + `enable_concurrent_dec_ref` fail-closed + low-level cleanup 局部队列 + actual async native barrier + fatal poison；engine/journey/unified 显式 release Solver/Optimize/Model 以降低 GC 压力但不提前 free 活对象。反证锚点:`z3-lifecycle-tests.ts`/`z3-lifecycle-fault-tests.ts`/`z3-race-repeat-tests.ts`;run-all §30/§30b/§30c。

**D-21 async 非 4/4 被误结算为成功**

**已清偿 2026-08-29(Issue #19)**:`collectDeepPlanning` 产出 `gotry_async_terminal.v1`;collector 仅在 4/4 时写 `succeeded`/ledger `settled`/exit 0,任一未达写 `failed`/ledger `failed`/exit 2;账本保存结构化结果,终态复诵零重算且保持同一退出码。隔离 `stateRoot` 回归见 run-all §28。
