# 预订 saga 状态机(booking_saga_fsm.v1)——issue #17 采纳面的设计正式化

> 状态:**accepted**(2026-08-29 founder 指令「现在就推进」,对 issue #17 评估中「真正值取的三点」的执行)
> 上游权威:`architecture.md`(技术权威面/ADR-15/ADR-16/ADR-17)、`transactional-state-rfc.md`(§4.3 WriteGate 基座)、`gotry-master-outline.md` §2(复用矩阵)、`roadmap.md`(M5 Entry gate)
> 执行锚点:`ts/src/booking-saga.ts`(纯函数词汇层)+ `ts/scripts/booking-saga-tests.ts`(run-all §36,25 断言)
> 纪律:单一文件承载单一关注点;版本历史归 git;**本交付是 M5 的设计基座具名化,不是交易闭环的实现,不构成 M3/M5 Exit 证据**(D-20 纪律)

## 0. 一句话主张

M5 的预订/支付/退改**不需要引入编排框架**(LangGraph/Temporal 类):预订流程状态机在 TS-4 事务化基座里**已经物理存在**——`pending_writes` 的三态 CHECK + 幂等键 + saga 三方法就是它。issue #17 提议的三个机理全部有既有归宿,欠缺的只是「具名」:本设计把状态、边、事件、拒绝理由收敛为一个显式词汇层(`booking-saga.ts`),并约定 M5 启封时任何 booking seam 只许走这张边表。

## 1. 状态字母表与边表(代码即权威:`ts/src/booking-saga.ts`)

- **状态字母表**(与 `state-ledger.ts` pending_writes.status CHECK 逐字一致):`pending | confirmed | compensated`;补 `none`(∅,主体未登记)为起点。
- **触发器**:`propose`(L2,只登记不执行)/ `confirm`(L3 具名 seam 确认,携 receipt)/ `compensate`(saga 补偿)。
- **边表**(全函数,12 格 = 4 边 + 8 拒,无空洞无第三态):

```
∅ --propose--> pending --confirm--> confirmed
                  │                    │
                  └---- compensate ----┴--> compensated   (吸收态,无出边)
```

| from | trigger | to | 账本事件 | 守卫 |
|---|---|---|---|---|
| none | propose | pending | `write.pending` | L2 只登记不执行;idem_key UNIQUE,重复提议 = no-op |
| pending | confirm | confirmed | `write.confirmed` | L3 具名 seam 确认,必携 receipt;已确认不可再确认 |
| pending | compensate | compensated | `write.compensated` | 外部写未发生,取消即终态(零补偿动作) |
| confirmed | compensate | compensated | `write.compensated` | 已发生副作用的 saga 补偿(退改),receipt 保留(COALESCE) |

拒绝理由闭集:`missing-subject / idem-exists / already-confirmed / absorbed-compensated / already-compensated`——结构化拒绝,**拒绝即不动**(与账本 `changes=0` 同义)。compensated 为吸收态;receipt 在 confirmed 后不可变;幂等键保证「同一预订确认不可能下两次」。

- **审计链**(`sagaTraceViolations`):单 idem_key 的 `write.*` 事件序列必须恰好走出边表的一条合法路径;`write.confirmed` 空 receipt 即违例。词汇层校验物理账本的真实事件流——**词汇层与账本不分叉,分叉即回归红**(§36 物理对账 25 断言)。
- **已知边界(诚实面)**:账本物理层暂不挡空 receipt(词汇层审计已兜住);物理 CHECK 随 M5 拍板入 schema。

## 2. 边型词汇(把 issue #17 的「边」落成 GoTry 词汇)

多 Agent 流程图里的「边」,在 GoTry 里只有三种,全部有现有承载:

| 边型 | 语义 | 现有承载 | 例 |
|---|---|---|---|
| **deterministic-edge** | 代码层判定,无 LLM 参与 | Z3 命名约束 + unsat core(`unified.ts`);gate 守卫;validateSpec 闸 | 合规检查(差标/工作窗口/红眼)= 求解前确定性排除,violation 带理由入 exclusions——**violation 的候选不给下游**,比「合规 Agent 返回布尔再路由」更强 |
| **gate-edge** | 用户决策点,唯一交互形态 | L1 gates 消息内选择题(D1 契约;`loop.ts`) | 「加 ¥300 升舱吗」式 trade-off 选择 |
| **external-event-edge** | 外部世界事件恢复流程(审批/回票/超时) | durable 工单(`workflow_steps` 挂起恢复)+ pending_writes saga + ApprovalSeam(`session-consent.ts`,已在生产) | 主管审批结果 = 一次账本事件,pending → confirmed/compensated |

**推论(HITL 不需要新框架)**:「等待审批 24h」不是 pause/resume 机制,而是 **pending 状态的持久挂起**——账本即挂起态,进程可死可重启(ADR-15 崩溃安全),外部事件到达即沿边恢复;审批通道复用 dsh ApprovalSeam(会话闸已是生产形态,headless fail-closed)。

## 3. issue #17 三机理的归宿(映射表)

| issue #17 提议 | 归宿 | 状态 |
|---|---|---|
| 共享 State + 原子更新 | 账本单事务(events+投影同生) | ✅ ADR-15 |
| Checkpointers | events append-only + 投影 fold 重建 | ✅ |
| 长事务跨重启、防重复副作用 | workflow_steps exactly-once + `gotry_async_terminal.v1` + idem_key UNIQUE | ✅(D-21) |
| HITL 暂停-恢复 | durable 工单挂起恢复 + ApprovalSeam 审批卡 | ✅ 生产中(会话闸);企业审批为 M5 的 seam 接线 |
| 合规 Agent 条件边 | **deterministic-edge**:Z3 命名约束/unsat core,合规永不做成 LLM Agent 节点 | ✅ 已是架构纪律(不变量表 L2「LLM 不做算术判定」) |
| 状态机显式化(StateGraph 形态) | `booking_saga_fsm.v1`:字母表+边表+解析器+审计链校验,纯函数 | ✅ 本次落地 |
| LangGraph 框架引入 | 拒绝(ADR-4 被拒备选=自研状态机控制平面;复用矩阵外;RFC(transactional-state)§2.1 已扫) | 不采纳 |

## 4. M5 启封增量(触发 = M5 Entry:M4 exit + 供应链协议;未触发前零实现)

1. booking seam 落地:具名 seam 登记词汇 `<domain>-<action>-confirm`(如 `flight-order-confirm`;词汇表 M5 拍板冻结);
2. 空 receipt 物理闸:pending_writes 加 `receipt 非空(CHECK)`,随 schema 升版;
3. L2/L4 接线:建议态(只登记)与自动类(L4)的授权词汇按 RFC(loopx)S4 分级,每级可回滚;
4. 审批等待状态:企业审批(外部事件)若需跨会话可见,扩 `waiting-approval` no-spend 词汇(session-double-source 系 waiting-* 同族,不花费)。

**以上任何一项落地都改变系统形态,须走状态面六处同步 + 全栈回归;它们是 M5 的交付物,不是本文的兑现**。

## 5. 明确不做(边界)

- 不引入 LangGraph/Temporal/编排框架或任何新运行时(ADR-4 / 总纲刚性约束 1 / RFC §1.3);
- 不动 dsh harness 会话层、不新增 Python 面;
- 合规/政策检查**永不做成 LLM Agent 节点**(确定性归代码,violation 必须带 unsat core 或规则理由);
- 本状态机不含业务预订流程图(段序/审批人路由等)——那是 M5 交付时的 seam 设计,字母表只管 saga 状态推进。

## 6. 判定记录(为何此形态而非 LangGraph 形态)

1. ADR-4 的被拒备选即「自研状态机」控制平面——本状态机是**账本 saga 的词汇层**,不是控制平面,不动 L2 编排(loop.ts/dsh);
2. 复用矩阵:LangGraph 不在矩阵;引入外部编排框架先修总纲;
3. M5 Entry gate(M4 exit + 供应链协议)未开,交易闭环不做倒推实现(D-20);
4. 决定性机理(挂起恢复/幂等/补偿/审计)单 SQLite 账本已物理完备(RFC transactional-state §2/§4),LangGraph checkpointer 是同一学派的服务端形态。