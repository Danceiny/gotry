# GoTry 发版记录

> 每个 tag 一条:内容、证据、闸勾稽。发布闸(AGENTS.md):① 全栈回归绿 ② §11 六状态面同步 ③ README 用法逐条实测 ④ License 明确 ⑤ 版本号在 tag 与全部文档间一致。
> 对外推送(remote)与 License 未定前,所有 tag 仅为本地候选。

## v0.0.1-rc.1(annotated tag,2026-08-22)

**点式体例首发**(对齐 dsh `X.Y.Z-rc.W`)。5 个新提交吸收 + 文档同步;无功能删除,无 API 变更。

### D-7 切轨(`bdcd630`)

`ts/src/unified.ts` 新增 `segmentsFromCandidate`(候选→单 choice 段适配器) + `solveChoiceSegment`(枚举求解) + `renderCandidateMarkdown`;`ts/src/index.ts` 插件路径、`py/gotry_feasibility/cli.py` 桥、`ts/scripts/diff-test.ts` 全部从 deprecated engine/journey 切轨到 unified;engine/journey 退纯 oracle。

### Bug 修复

- `85a07d6` 时间感知(persona 注入动态变量 `{{current_date}}`)+ generic 路由污染(generic scenario 不再 fallback 到普吉包,继续访谈)
- `8e0509c` dsh web WASM 崩溃止血(z3-solver 改动态 import;`solveUnified` 加 try-catch 护栏——dsh 进程被 Z3 `mk_bool_var` `memory access out of bounds` 整死后修;handler 不调 `process.exit`,留证 dsh 控制流)

### 能力面增量

- `d83c5be` hotelbyte-cli 接入:`ts/capabilities/hbcli.ts` 封装(bun + hbcli --json 进程)+ `searchHotels`/`listDestinations` 高层语义;失败/超时/spawn_error 一律降级,证据链三态标注。`gotry_hotel_search` 工具切轨到新封装,hbcli-tests 4/4 绿(`run-all-tests.sh` §8)。

### 进程护栏(D-NEW 部分赎回,`df4c111`)

`ts/capabilities/incident-log.ts` 提供 `recordIncident` 同步 fsync append-only JSONL(`gotry-state/incidents.jsonl`) + `installProcessGuards` 挂 uncaughtException/unhandledRejection;handler 不调 process.exit,留证不阻断 dsh 控制流。`ts/src/index.ts` `apply()` 调 `installProcessGuards(config.stateRoot)`。incident-tests 2/2 绿(`run-all-tests.sh` §9)。

### 文档同步

- README 切到「v0.0.1-rc.1 = 当前」,旧 RC1/RC2 列入历史;薄壳废弃 + dsh 唯一推荐面
- architecture.md §1「当前形态」与 §10 D-7 状态、D-NEW 同步
- roadmap.md「当前位置」段替换为 5 commit 列表

### 验证(发布闸五项勾稽)

| 项 | 结果 |
|---|---|
| ① 全栈回归绿 | ✅ 10 套测试 PASSED(Python 单元 + TS engine/journey/unified + replay + 异步 + smoke + hbcli + incident + 差分) |
| ② §11 六状态面同步 | ✅ architecture.md §1/§9/§10 + roadmap.md + README.md + release-notes.md + stage1-top-down-design.md 均已同步 |
| ③ README 用法逐条实测 | ✅ `./gotry` shell/cli/headless 已实测;dsh web `:3080` 启动+进程保活 |
| ④ License 明确 | ⏸️ 沿用 rc2 的「未决」——本 tick 无变更 |
| ⑤ 版本号一致 | ✅ README/architecture/roadmap/release-notes 全部 v0.0.1-rc.1;无 vc 引用残留 |

### 已知留账(沿 architecture.md §10)

- D-NEW-2: dsh 主循环对单插件抛错的容错(超出 M2);本次[部分赎回]的是 gotry 侧护栏
- D-7 剩余尾债: `py/gotry_demo/build_plan.py`(demo 离线工具)仍调 `journey.solve_journey`
- z3 WASM multi-Context race: 三个模块各自 z3Promise 时连续跑会偶发 `memory access out of bounds`(本次回滚了 unified 共用单例改动,会触发 Context mismatch 副作用;债务保留为待审)
- M4 校准输入等待(创始人)
- remote & License 决策等待

---

## v0.0.1-rc2(annotated tag,2026-08-22)

在 rc 之上的发布面修复:

- **fix `29318f4`**:`./gotry` 裸跑在 `set -u` 下崩溃(`$1` unbound)、`./gotry web` 把 "web" 当 prompt 传给 headless——README 三条用法两条是坏的;薄壳 server 从绑全接口 + CORS `*` 改为只绑 127.0.0.1、去 CORS 头(/state 暴露画像与历史、/chat 消费用户 key,不应对局域网/任意网页可见);README 补齐 dsh 运行时安装步(原缺,方式二/三对新用户不可用)。
- **docs `f2a01cc`**:AGENTS.md 发布纪律——对外发布单 owner + 五项发布闸。
- 验证:三分支实测(裸 `./gotry` 起薄壳并确认 127.0.0.1 绑定与 `/state` 应答;`./gotry web` dsh Web 起来;`./gotry "…"` headless 真实 LLM 应答);全栈回归绿。

## v0.0.1-rc(annotated tag @ `68f4fe1`,2026-08-22)

首个候选:种子用户前的工程面全通。

- 产品面:薄壳七段(品牌三页/意图路由三场景/休假语义/会话持久化/云南包/Markdown 渲染/UX),一键入口 `./gotry` 三模式;
- 能力面(M2 交付):OpenFlights 骨架(168 枢纽对,ODbL 署名在数据文件内,三值语义:检出=强肯定/枢纽对缺失=降级信号≠证伪/枢纽集外=无结论)+ OpenSky 校验桥 + hbcli 酒店桥(实时/静态降级,证据标注)+ bookedResources 锚点;
- 智能面:DeepSeek 原生 dsh 运行时(人格 + 五工具,全只读,WriteGate 留白未触);
- 验收:三场景(洱海候选/云南带爸妈/普吉 workation)E2E + 全栈回归绿;
- 已知留账:D-7(deprecated 层承重 + 洱海路由 hack)未清偿;种子用户启动等 remote 与 License 决策。
