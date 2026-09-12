[English](external-event-seam.md) | [简体中文](external-event-seam.zh-CN.md)

# 外部事件驱动接缝设计（#82 world2agent 兼容方向，issue #119 / D-31）

> 状态：**设计文档（2026-09-04，issue #119；2026-09-12 更新）**。本文只设计，不承诺任何运行时实现——落地序列见 §6，
> 其中第 1、2 段已落地（本地探针 + 愿望池消费），仅剩 w2a sensor 生产者为触发式。原则：**消费既有接缝，不建新运行时**。
> 本地已落地并保留：通道探针（§6.1）与愿望池消费（§6.2）。w2a/0.1 envelope 的**纯契约**切片已获批，
> 定位为惰性、默认关闭的类型/校验契约（§5.1），不激活任何真实链路；真实 bridge/sensor/auth/消费者接入
> 仍由 issue #82 触发式推进。本文不声称任何远程 sensor 路径已实现或已验证。
> 关联：issue #82（world2agent 协议集成）、ADR-18（效应解译器）/ADR-24（turn 预算）、
> D-8（静态平铺+健康态驱动动态建议）、`capabilities/channel-health.ts`（健康面）、
> `src/wish-pool.ts`（愿望池召回）、`capabilities/async-workorders*`/`turn-handoff-collect.ts`
> （跨进程工单闭环先例）。

## 1. 要回答什么

issue #82 的诉求：让**外部世界的事件**（站点改版/风控升级/接口下线/额度政策变化/
用户在别处的动作）能驱动 agent 的行为，而不是只靠用户会话"撞上"。本设计给出
gotry 侧的接缝形态：**外部事件作为两个既有面的新生产者**——

1. **通道健康面**（`channel-health.ts`）：站点断 → 通道态置 `down` → routing 建议
   即时排除（既有逻辑零改动）；
2. **愿望池 conditions**（`wish-pool.ts`）：事件作为召回评估的新事实源（仍是 pull
   模型，不做 push）。

## 2. 现状：in-process 路由态与已落地的持久化带外事件，w2a 生产者尚未接入

两个面容易混为一谈，分开说：

- **会话 verdict → in-process 路由态**：`noteChannelVerdict` 写 in-process `channelState` map
  （needs-setup→down、hit→清除、miss/error→不动、cooldown 过期），而 `routingAdvice` **只读这张 map**；
- **本地探针 → 持久化健康事件**：已落地的只读探针（`ts/scripts/channel-probe.ts`，§6.1）本身就是**带外本地生产者**：
  异常时调 `recordChannelEvent`（down），恢复写 `'ok'`（latest-wins 超越），落持久化健康面。今天读持久化健康面的是
  愿望池召回（`ts/src/index.ts:780`）与 doctor 既有持久化健康读取路径——**不含** `routingAdvice`。

仍开放的部分：

- flyai 达限、携程 challenged 这类**会话内**事实经 verdict 路径传导正常（#106-#108 已收口）；
- 12306 改版、携程风控策略升级、某接口下线，只在本地探针覆盖到的范围内被落账；**远程 w2a sensor 生产者尚未接入**（issue #82）；
- **持久化健康的 routing 传导未实现**：持久化的 `down` 事件当前不改变 `routingAdvice`。root 在 `main` `8fed347` 上的
  Node 24 临时状态反例（2026-09-12T12:29:45Z，exit 0）显示：持久化 `down` 仍被 routing 建议采纳，而 `markChannelDown` 会摘除。
  由 **#436** 跟踪，本文不声称更多。

## 3. 接缝设计：事件 = 健康面与愿望池的新生产者

### 3.1 健康面生产者（核心，一段 PR 可落）

外部事件以**与工具 verdict 完全相同的落账形态**进入健康面：

```ts
recordChannelEvent(stateRoot, { channel: 'session:ctrip-flight', state: 'down',
                               reason: 'site-redesign', at: <iso> })
```

- 事件不是新机制，是既有落账形态的第二个生产者；但今天各消费方并不齐整：愿望池召回（`ts/src/index.ts:780`）与
  doctor 既有持久化健康读取路径已读持久化健康面，而 **`routingAdvice` 只读 in-process `channelState` map**——
  故持久化事件当前到不了 routing 与 persona 路由卡口径。该 routing 传导是期望项，标记为 **TODO #436**。
- 恢复同样走事件（`state: 'ok'`）或自然过期（与 cooldown 过期同语义）。

### 3.2 生产者三类（信任分级，决策点见 §5）

| 生产者 | 信任 | 说明 |
|---|---|---|
| 本地探针 tick（loopx/cron 驱动的只读健康检查） | 本地可信（owner 机器） | 不需鉴权；探针本身只读，写面走本地文件 |
| 用户/agent 手工 | 已有闸 | 经工具面调用，session-consent/审批卡同族 |
| world2agent 远程回调 | **需 auth（后置）** | 签名/通道绑定未定，等真实回调方出现再拍板 |

### 3.3 愿望池触发：事件是召回的新事实源，不是推送

- 愿望池召回是 **pull 模型**（`gotry_wish_pool_list` 0..1 召回，`WishMatchContext`
  = days/budget/month）。事件落账后，召回评估可把"通道事件"作为 context 的事实源
  （如「某航线 exact-date miss 事件」佐证/否证一个愿望的成行条件）。
- **不做 push**：M5 WriteGate 开闸前，gotry 没有任何主动触达通道——事件改变的是
  「下一次召回/下一次对话」的信息质量，不是打断用户。

### 3.4 工单面兑现（先例已备）

事件若需要**工作**（如站点改版后重校准适配器），开异步工单——跨进程闭环
（`async-collect` / `turn-handoff-collect`，「一小时后回来」形态）是既有机制，
sensor 事件只是新的工单来源。

## 4. 边界：不做的（边界即信任）

- **不建消息总线/常驻监听服务**：单机本地形态下，JSONL 文件面 + 心跳 tick 已覆盖；
  常驻进程是新的运维面与故障面。
- **不做 push 通知**：同 §3.3，M5 前无触达通道。
- **不做跨机事件复制**：多用户账本化（RFC §6.5）触发式后置（D-15），事件面随它走。
- **事件不进 turn-policy 分类器**：ADR-24 铁律（控制面判定纯函数零 IO）——事件经
  工具结果/召回进入模型视野，不进路由判定。

## 5. 决策点（D-31，触发式）

**外部事件写入权限与信任模型**：谁能置 `down`？本地探针免鉴权（写本地文件，与
incident 同级）；world2agent 远程回调需要签名/通道绑定——**等第一个真实回调方
出现时拍板**，不预设。拍板前，远程面不开（接缝只存在于本地生产者）。

### 5.1 已获批的纯契约切片（2026-09-12，issue #432）

founder 已授权 w2a/0.1 envelope 的**纯契约**切片，参考基准钉在
[`schema/0.1/schema.ts`](https://github.com/machinepulse-ai/world2agent/blob/7e5fc4d441699993b8f1ef7d3b9776065b7a93e0/schema/0.1/schema.ts)
（`machinepulse-ai/world2agent` commit `7e5fc4d441699993b8f1ef7d3b9776065b7a93e0`）。按获批范围，该切片是一个纯函数式、确定性的适配器，
只投影惰性的不可信事件元数据；不发明 sensor 专用 wire schema，不安装任何运行时依赖。其边界：

- **默认关闭**：仅在调用方显式传入 enabled 选项时可达——无基于环境变量的产品开关、无常驻监听、无 token、无消费者/运行时注册；
- **精确白名单四元组**：仅当已评审的 source/package/version/type 四元组精确匹配时才做映射，否则给出稳定拒绝结果；
- **声明即不可信**：envelope 上的 sender/source 字段是不可信数据，四元组匹配**不是**鉴权；
- **不写不派发**：通道健康面写入、账本/事实/愿望池变更、planner/工具派发、预订与支付均不可达。

批准契约**不激活任何真实链路**：真实 bridge/sensor 选型、auth/token 归属与消费者接入仍由 issue #82
触发式推进，M4/M5/M6 入场判定不变。已落地的本地探针与愿望池消费（§6.1/§6.2）保留不受影响。
实现与验证进展由 issue #432 跟踪。

## 6. 落地序列（触发式，每段独立 PR）

1. **sensor 探针最小行** ✅（2026-09-07 落地：`ts/scripts/channel-probe.ts`，run-all §52）：只读探针 tick（可由 loopx/cron 驱动）对关键通道做
   无副作用探测，异常时调 `recordChannelEvent`（down），恢复写 `'ok'`（latest-wins 超越），落持久化健康面。
   持久化健康读取方（愿望池召回、doctor）即时受益；**routing 传导未实现——TODO #436**；
2. **愿望池消费** ✅（2026-09-07 落地：`conditions.channels` 可选条件 + 召回时
   命名通道处于 down 即否证成行条件，run-all §53；「佐证」渲染面留后续切片）；
3. **w2a/0.1 envelope 纯契约适配器**（2026-09-12 获批，issue #432）：即 §5.1 的惰性、默认关闭切片——只落契约，
   不接生产者、不接消费者；
4. **world2agent 回调（真实链路）**：auth 模型拍板后接远程生产者（D-31）；真实 sensor/bridge/消费者接入
   仍开放于 #82。

## 7. 与既有判定的兼容性

- **ADR-18（解译器不做自动路由）**：事件改变的是「可用性事实」，routing 建议仍是
  建议非派发——正是 D-8「静态平铺 + 健康态驱动动态建议」的自然延伸；
- **D-8/persona （19）**：平铺不动，建议由健康态投影（事件丰富健康态）；
- **WriteGate 边界**：事件面只读+落账，无任何写站点动作，M5 红线不受影响。
