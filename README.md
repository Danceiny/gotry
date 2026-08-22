# GoTry

> 使命:身体和灵魂,更多旅行,更少旅游。
> 「从出发到下一次出发」的 AI 旅行 Agent:动机访谈进、已验证的行程方案与选择题出;
> LLM 负责理解与解释,确定性组件负责判定与算术。

**当前形态(Stage 1 工程面完成,LLM 为 mock)**:对话循环(日历一次断言/增量访谈/求解挂载/gates 选择题)+ 统一行程模型(时区感知全成本/工作窗口/红眼睡眠模型)+ 异步深度规划(工单跨进程持久化,「一小时后回来」)+ dsh 插件 + 真 LLM 适配器(等 DEEPSEEK_API_KEY 即插即用)。经真实行程重放验证:**Kimi 的 13 轮失败 = GoTry 3 轮**。

## 快速开始

```sh
# Python 侧(≥3.9)
python3 -m venv .venv && .venv/bin/pip install z3-solver

# TS 侧(需 node ≥22;本机经 nvm)
cd ts && npm install && cd ..

# 全栈回归(Python 20/20 + TS engine/journey/unified + 双实现差分)
./scripts/run-all-tests.sh

# 对话循环重放(3 轮走完 Kimi 的 13 轮)
cd ts && npx tsx scripts/replay.ts

# 异步深度规划(请求进程种工单 → 另一进程回收)
cd ts && npx tsx scripts/replay-async.ts --request-only
cd ts && npx tsx scripts/async-collect.ts <工单id>   # 见 gotry-state/async/

# 真 LLM 重放(需 DEEPSEEK_API_KEY;无则回退 mock)
cd ts && npx tsx scripts/replay-real.ts
```

## 文档地图(全部在本仓)

| 文档 | 关注点 |
|---|---|
| `docs/architecture.md` | **技术权威面**:系统/五层/代码地图/统一模型/循环/数据/ADR×9/演进/债务 |
| `docs/gotry-master-outline.md` | 总纲:工作分解/复用矩阵/决策门 |
| `docs/gotry-product-design.md` | 产品:主循环/透明机制/全成本/共享经验层 |
| `docs/stage1-top-down-design.md` | Stage 1 详细设计与实现序(mock 先行) |
| `docs/kimi-postmortem.md` | 反例教材:真实 13 轮对话的失败归因与地面真值 |
| `docs/demo-plan-2026-07-17.md` `docs/demo-reconciliation.md` | demo 交付物与对账 |

## 招牌输出(为什么这是「懂事儿」)

**洱海案例**(上海/周末/¥3000/休整动机):「大理·洱海现在不行——冲突约束 duration;最小修改:5 天+¥4950(Optimize 最优值);已进『下一次出发』清单。千岛湖可行:06:35 起床、84% 精力、¥1002。」unsat core 是 Z3 算的,不是话术。

**工作窗口案例**(真实 workation):普吉工作窗口=当地 13:00-22:00,周五晚班 TG216/TG218 落在窗口内被确定性排除,只剩周六早班——与发起人真实选择一致,Kimi 烧三轮的问题一条模型规则回答。

## 迭代治理

本仓由 loopx 治理(`.venv-loopx/bin/loopx`,goal `gotry-demo-goal`),每 2 分钟一个有界 tick;agent 契约见 `AGENTS.md`(含异步工单清扫规则)。上游战略文档曾寄居 hotel-be,已全部归仓。
