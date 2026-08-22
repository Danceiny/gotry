# GoTry 仓库 Agent 契约

- 上游文档优先:改行为先对照 `docs/gotry-master-outline.md`(总纲);复用矩阵(§2)是硬约束——代码级引入仅限 open-source import,内部资产只 bridge/reference。
- 分层纪律:门到门算术只改 `py/gotry_feasibility/model.py`;求解逻辑只改 `engine.py`;两者不得互相渗透。改任何一侧必须跑 `py/tests`(金标准用例是回归底线)。
- TS↔Python 桥接面只有 `gotry_feasibility.cli` 一个 JSON 契约,不得新增第二条桥。
- dsh 跟 main(创始人决策):升级后先跑 `cd ts && npx tsc --noEmit && npx tsx scripts/smoke.ts`。
- 红线进代码:动机画像无 evidence 拒绝落盘;wish pool 条目强制 conditions;写操作(预订/支付类工具)未来必须过 WriteGate(确认前不得实现任何直接写)。
- 提交信息一句话说清「为什么」;测试红着不许合。
