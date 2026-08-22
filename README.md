# GoTry 核心技术框架

> 使命:身体和灵魂,更多旅行,更少旅游。
> 上游:产品设计(D1)与总纲(D0)见 hotel-be `docs/business-plan/gotry-*`。本仓是**核心技术先行**的落地:战略节奏是技术不成熟时不动产品与业务。

**当前形态(Phase 0 / T1 PoC)**:可行性引擎(Z3 门到门全成本)+ dsh 插件(TS)+ 异步深度规划 demo(模拟 loopx)。一句话:已经能用确定性求解回答「上海、周末、想放空,洱海为什么不行、什么行、洱海什么时候去」。

## 快速开始

```sh
# 1. Python 侧(≥3.9)
python3 -m venv .venv
.venv/bin/pip install z3-solver

# 2. 测试 + 洱海金标准用例端到端
./scripts/run-golden-case.sh

# 3. TS 侧(需 node ≥22;本机经 nvm)
cd ts && npm install && npx tsc --noEmit && npx tsx scripts/smoke.ts
```

## 目录

```
py/gotry_feasibility/   Z3 可行性引擎:model(门到门算术)+ engine(选择/unsat core/最小修改)+ cli
py/gotry_async/         异步深度规划 demo:loopx 概念(objective/todos/gates/evidence/quota)确定性模拟
py/tests/               金标准用例测试(8 断言)
ts/src/                 dsh 插件 gotry-tools(3 工具)+ Python 桥接(延迟计量)
ts/cordis.example.yml   dsh 组合示例
data/golden_erhai.json  洱海金标准用例(静态样例数据)
docs/architecture.md    架构(D2-lite):组件/决策/已验证与未验证清单
```

## 金标准用例的输出(为什么这是「懂事儿」)

输入:上海用户 + 洱海照片 + 周末 2 天 + 预算 ¥3000 + 休整动机 0.7。引擎输出:

- **大理·洱海:现在不行**——冲突约束 duration(2 天装不下),最小修改:延长到 5 天 + 预算 ¥4950;**进「下一次出发」清单**(5 天、约 ¥4950、春秋最佳)。
- **千岛湖:可行**——06:35 起床(卡着 06:30 的动机红线)、84% 到达精力、¥1002。
- 两道选择题(不是重新访谈):「千岛湖还是太湖」「洱海留给下一次?」

 unsat core 是 Z3 算出来的,不是模板话术;¥4950 是 Optimize 的最优值。

## 状态与边界

见 `docs/architecture.md` §3/§4:已验证/未验证诚实清单。数据为静态样例;精力/时长参数是初始校准值,校准数据源是未来的共享经验层(D1 §6.6)。
