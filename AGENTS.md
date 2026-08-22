# GoTry 仓库 Agent 契约

- 上游文档优先:技术权威面是 `docs/architecture.md`(系统/ADR/演进/债务);程序层决策看 `docs/gotry-master-outline.md`(总纲);复用矩阵(§2)是硬约束——代码级引入仅限 open-source import,内部资产只 bridge/reference。
- **进入本仓的每个 agent/tick 先做异步工单清扫**:`ts/gotry-state/async/` 若有 `*.json` 而无同名 `.deliverable.md`,执行 `cd ts && npx tsx scripts/async-collect.ts <工单id>`(「一小时后回来」的调度闭环由这条驱动)。
- 分层纪律:算术只在 `model.ts`/`unified.py` 的 evaluate 层;求解只在 `unified.ts`/`unified.py`;engine.*/journey.* 是 deprecated 兼容层,新代码不得调用。改任何一侧必须跑全栈回归(`scripts/run-all-tests.sh`,Python 20/20 + TS 套件全绿)。
- TS↔Python 桥接面只有 `gotry_feasibility.cli` 一个 JSON 契约,不得新增第二条桥。
- dsh 跟 main(创始人决策):升级后先跑 `cd ts && npx tsc --noEmit && npx tsx scripts/smoke.ts`。
- 文档纪律:单一文件承载单一关注点,版本历史归 git,不设 vN 后缀;GoTry 文档一律放本仓。
- 红线进代码:动机画像无 evidence 拒绝落盘;wish pool 条目强制 conditions;写操作(预订/支付类工具)未来必须过 WriteGate(确认前不得实现任何直接写)。
- 提交前跑 `git status --short` 并能解释每个条目;提交信息一句话说清「为什么」;测试红着不许合。
