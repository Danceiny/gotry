# GoTry 仓库 Agent 契约

- 上游文档优先:技术权威面是 `docs/architecture.md`(系统/ADR/演进/债务);程序层决策看 `docs/gotry-master-outline.md`(总纲);复用矩阵(§2)是硬约束——代码级引入仅限 open-source import,内部资产只 bridge/reference。
- **进入本仓的每个 agent/tick 先做异步工单清扫**:`ts/gotry-state/async/` 若有 `*.json` 而无同名 `.deliverable.md`,执行 `cd ts && npx tsx scripts/async-collect.ts <工单id>`(「一小时后回来」的调度闭环由这条驱动)。
- 分层纪律:算术只在 `model.ts`/`unified.py` 的 evaluate 层;求解只在 `unified.ts`/`unified.py`;engine.*/journey.* 是 deprecated 兼容层,新代码不得调用。改任何一侧必须跑全栈回归(`scripts/run-all-tests.sh`,Python 20/20 + TS 套件全绿)。
- TS↔Python 无桥:py/gotry_feasibility 仅作历史对照 oracle,产品运行时与工具链零引用;不得新增任何 Python 依赖面。
- dsh 跟 main(创始人决策):升级后先跑 `cd ts && npx tsc --noEmit && npx tsx scripts/smoke.ts`。
- 文档纪律:单一文件承载单一关注点,版本历史归 git,不设 vN 后缀;GoTry 文档一律放本仓。
- 状态同步纪律:任何改变系统当前形态/状态/债务的提交,必须在同一提交内同步 `architecture.md` §11 列出的全部状态面(6 处);M-exit 提交在提交信息中附保鲜清单勾稽结果。
- 红线进代码:动机画像无 evidence 拒绝落盘;wish pool 条目强制 conditions;写操作(预订/支付类工具)未来必须过 WriteGate(确认前不得实现任何直接写)。
- 提交前跑 `git status --short` 并能解释每个条目;**只暂存自己负责的具名文件,禁止 `git add -A`/`git commit -am` 席卷工作区**——多 agent 并行时工作区常混有他人在制品;提交信息一句话说清「为什么」;测试红着不许合。
- 对外发布纪律:打 tag / 推 remote / 发版说明**只由发布 owner 执行**(当前:创始人指定的 review agent);发布前必过发布闸——① 全栈回归绿 ② `architecture.md` §11 六状态面同步 ③ README 用法逐条实测 ④ License 明确 ⑤ 版本号在 tag 与全部文档间一致。任何 agent 不得自行宣称「已发布」。

## 巡检/测试的状态纪律

dsh 运行时状态目录(`ts/dsh-runtime/gotry-state/`)是创始人的真实产品数据
(动机画像/愿望池)。巡检或测试 prompt **不得写入共享状态**:
- 只做只读验证(读文件/doctor/无副作用工具调用);
- 需要验证写路径(动机保存/愿望池入池)时,用隔离 `stateRoot` 跑插件
  (如 smoke 的做法),绝不用 `./gotry` 直跑写型测试 prompt;
- 历史教训:2026-08-26 巡检曾用真会话写入愿望池/改写动机画像,污染了
  创始人数据(愿望池 4 条均为测试来源)。
