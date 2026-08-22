# GoTry 核心技术框架架构(D2-lite,随代码演进)

> 上游文档:hotel-be `docs/business-plan/gotry-master-outline.md`(总纲 D0,决策与复用矩阵)
> 与 `gotry-product-design.md`(D1,产品语义)。本文只讲**已落地的技术形态**。

## 1. 组件与数据流

```
用户素材(洱海照片 + 一句「想去这儿」)
   │ (未来:动机访谈插件抽取,M1)
   ▼
结构化请求 TravelRequest ──动机权重──► MotivationProfile
   │                                    │ escape_rest=0.7 → required_usable_hours=5.4h
   │                                    │ hard: wake≥06:30, energy≥40%
   ▼
┌─────────────────────────────────────────────────────────┐
│ 可行性引擎(py/gotry_feasibility)                          │
│   model.py  evaluate_choice():门到门全成本纯算术          │
│             班次/缓冲/起床/接驳/精力/有效时长/金钱         │
│   engine.py Z3 选择 + 命名约束 + unsat core               │
│             → 单条放宽 → 组合 core(时长+预算) → 收缩      │
│             → _cheapest_plan(Optimize 取最优再回代)       │
│   输出:verdicts + 最小修改建议 + wish pool + answer_md    │
└─────────────────────────────────────────────────────────┘
   ▲ subprocess(JSON stdin/stdout, 延迟计量)          ▲
   │                                                   │
ts/src/bridge.ts                                   py/gotry_async/demo.py
   │                                                   │ loopx 概念模拟:
ts/src/index.ts (dsh 插件 gotry-tools)                 │ objective/todos/gates/
   gotry_feasibility_check / gotry_motivation_save      │ evidence/quota(验证后花费)
   gotry_wish_pool_add                                 ▼
   │                                              「回访交付」+ 不失望四条自检
   ▼
dsh 运行时(cordis 组合,ts/cordis.example.yml)
```

## 2. 关键设计决策(均已实现并验证)

1. **算术与求解分层**:全部门到门算术在 `model.evaluate_choice`(纯函数,可独立测试);Z3 只做「选哪个」。两个层次互不渗透——引擎改求解器不动算术,调参数不动求解。
2. **命名约束 + 组合 core**:每条用户约束(wake_floor/energy_floor/usable_hours/budget/duration/arrival)以 `assert_and_track` 注册;无解时读 unsat core;放宽 duration 换长窗口口径后**取新口径的 unsat core 叠加**(洱海= duration + budget),再做一轮收缩保证只要求用户付出必要代价。
3. **最优预算经 Optimize lower(句柄)取值、等值回代提模**:`Optimize.model()` 不保证最优——这是 Z3 的坑,wish pool 的「约 ¥4950」是真正的最低值。
4. **动机即约束**:required_usable_hours = 4 + 2×escape_rest——「为什么出发」直接进求解器,不是推荐词藻。工具不能毁掉目的(休整型 + 凌晨起床 → 引擎点名冲突)。
5. **桥接面收敛 + 延迟计量**:TS↔Python 只有 `gotry_feasibility.cli` 一个 JSON 契约,每次调用延迟落 `bridge-latency.jsonl`(首次实测 ~226ms,含 Python 启动;生产化方向:常驻进程或 HTTP)。
6. **P0 反幻觉进代码**:`gotry_motivation_save` 无 evidence 拒绝落盘;wish pool 条目强制 conditions。

## 3. 复用矩阵落地状态(对照总纲 §2)

| 组件 | 策略 | 状态 |
|---|---|---|
| dsh(@deepseek-ai/dsh@0.1.1-rc.2, dsh-tools@0.0.1-rc.1) | import,跟 main | ✅ 插件按已发布 rc API 编写并 typecheck 通过;⚠️ 尚未在完整 dsh 运行时内端到端跑(需 DEEPSEEK_API_KEY 与完整 cordis 组合) |
| Z3(z3-solver 5.1.0) | import | ✅ 核心引擎,8/8 测试 |
| loopx | import(桥接) | ⚠️ 概念已映射并确定性模拟(objective/todos/gates/evidence/quota);实装待环境(本地 entrypoint 跑不起来,入口 `loopx.entrypoint:main`) |
| travel_agent / ai-agent-book | reference | 按纪律零代码引入(设计参考) |
| hotelbyte-cli | import+extend | ⏳ 未开始(T3;GoTry 不重建酒店原子能力) |
| TREK | reference+rewrite | ⏳ 未开始(T8) |

## 4. 已验证 / 未验证(诚实清单)

已验证:金标准用例 8/8 断言(unsat core 点名 duration、wish pool 条件、最优预算、P0 拒绝、桥接全链路、异步不失望四条);TS typecheck 对齐 rc 真实契约;冒烟含插件注册路径。

未验证:完整 dsh 运行时内的模型对话循环;真实班次/价格数据(当前为静态样例);多段行程(>1 leg);精力/时长参数仅初始校准值(校准源=共享经验层,见 D1 §6.6)。

## 5. 下一步(按总纲 WBS)

- T1 收尾:在真实 dsh 运行时(npx @deepseek-ai/dsh web + cordis 组合)内加载 gotry-tools 跑通对话级调用;
- loopx 实装:解决运行环境后把 gotry_async 的模拟 tick 换成 loopx CLI 调用;
- T3:hotelbyte-cli 命令缺口盘点 → capability-hotelbe;
- D4:把金标准用例固化为评测集三件套的首批用例(可行性/事实性/透明度)。
