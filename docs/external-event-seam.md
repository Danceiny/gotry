# 外部事件驱动接缝设计(#82 world2agent 兼容方向,issue #119 / D-31)

> 状态:**设计文档(2026-09-04,issue #119)**。本期只设计不承诺实现——落地序列见 §6,
> 触发式推进(第一个真实 sensor 出现时启动第一段)。原则:**消费既有接缝,不建新运行时**。
> 关联:issue #82(world2agent 协议集成)、ADR-18(效应解译器)/ADR-24(turn 预算)、
> D-8(静态平铺+健康态驱动动态建议)、`capabilities/channel-health.ts`(健康面)、
> `src/wish-pool.ts`(愿望池召回)、`capabilities/async-workorders*`/`turn-handoff-collect.ts`
> (跨进程工单闭环先例)。

## 1. 要回答什么

issue #82 的诉求:让**外部世界的事件**(站点改版/风控升级/接口下线/额度政策变化/
用户在别处的动作)能驱动 agent 的行为,而不是只靠用户会话"撞上"。本设计给出
gotry 侧的接缝形态:**外部事件作为两个既有面的新生产者**——

1. **通道健康面**(`channel-health.ts`):站点断 → 通道态置 `down` → routing 建议
   即时排除(既有逻辑零改动);
2. **愿望池 conditions**(`wish-pool.ts`):事件作为召回评估的新事实源(仍是 pull
   模型,不做 push)。

## 2. 现状:健康面的生产者只有一个,且是 in-band 的

今天 `channelState`/`routingAdvice` 的唯一事实来源是**工具调用 verdict**
(`noteChannelVerdict`:needs-setup→down、hit→清除、miss/error→不动、cooldown 过期)。
这意味着:

- flyai 达限、携程 challenged 这类**会话内**事实传导是通的(#106-#108 已收口);
- **带外**事实没有入口——12306 改版、携程风控策略升级、某接口下线,系统无从知晓,
  只能等下一次真实检索失败,由用户会话承担发现成本。

## 3. 接缝设计:事件 = 健康面与愿望池的新生产者

### 3.1 健康面生产者(核心,一段 PR 可落)

外部事件以**与工具 verdict 完全相同的落账形态**进入健康面:

```ts
recordChannelEvent(stateRoot, { channel: 'session:ctrip-flight', state: 'down',
                               reason: 'site-redesign', at: <iso> })
```

- `routingAdvice` 的 down-排除、doctor 配额可见行、persona 路由卡口径——**全部零改动
  生效**(它们只读事件面)。事件不是新机制,是既有机制的第二个生产者。
- 恢复同样走事件(`state: 'ok'`)或自然过期(与 cooldown 过期同语义)。

### 3.2 生产者三类(信任分级,决策点见 §5)

| 生产者 | 信任 | 说明 |
|---|---|---|
| 本地探针 tick(loopx/cron 驱动的只读健康检查) | 本地可信(owner 机器) | 不需鉴权;探针本身只读,写面走本地文件 |
| 用户/agent 手工 | 已有闸 | 经工具面调用,session-consent/审批卡同族 |
| world2agent 远程回调 | **需 auth(后置)** | 签名/通道绑定未定,等真实回调方出现再拍板 |

### 3.3 愿望池触发:事件是召回的新事实源,不是推送

- 愿望池召回是 **pull 模型**(`gotry_wish_pool_list` 0..1 召回,`WishMatchContext`
  = days/budget/month)。事件落账后,召回评估可把"通道事件"作为 context 的事实源
  (如「某航线 exact-date miss 事件」佐证/否证一个愿望的成行条件)。
- **不做 push**:M5 WriteGate 开闸前,gotry 没有任何主动触达通道——事件改变的是
  「下一次召回/下一次对话」的信息质量,不是打断用户。

### 3.4 工单面兑现(先例已备)

事件若需要**工作**(如站点改版后重校准适配器),开异步工单——跨进程闭环
(`async-collect` / `turn-handoff-collect`,「一小时后回来」形态)是既有机制,
sensor 事件只是新的工单来源。

## 4. 边界:不做的(边界即信任)

- **不建消息总线/常驻监听服务**:单机本地形态下,JSONL 文件面 + 心跳 tick 已覆盖;
  常驻进程是新的运维面与故障面。
- **不做 push 通知**:同 §3.3,M5 前无触达通道。
- **不做跨机事件复制**:多用户账本化(RFC §6.5)触发式后置(D-15),事件面随它走。
- **事件不进 turn-policy 分类器**:ADR-24 铁律(控制面判定纯函数零 IO)——事件经
  工具结果/召回进入模型视野,不进路由判定。

## 5. 决策点(D-31,触发式)

**外部事件写入权限与信任模型**:谁能置 `down`?本地探针免鉴权(写本地文件,与
incident 同级);world2agent 远程回调需要签名/通道绑定——**等第一个真实回调方
出现时拍板**,不预设。拍板前,远程面不开(接缝只存在于本地生产者)。

## 6. 落地序列(触发式,每段独立 PR)

1. **sensor 探针最小行**:一个只读探针 tick(可由 loopx/cron 驱动)对关键通道做
   无副 mustard 探测,异常时调 `recordChannelEvent`——routing/doctor 即时受益;
2. **愿望池消费**:召回 context 纳入通道事件事实(条件含航线/目的地的愿望用
   最新通道状态佐证);
3. **world2agent 回调**:auth 模型拍板后接远程生产者(D-31)。

## 7. 与既有判定的兼容性

- **ADR-18(解译器不做自动路由)**:事件改变的是「可用性事实」,routing 建议仍是
  建议非派发——正是 D-8「静态平铺 + 健康态驱动动态建议」的自然延伸;
- **D-8/persona (19)**:平铺不动,建议由健康态投影(事件丰富健康态);
- **WriteGate 边界**:事件面只读+落账,无任何写站点动作,M5 红线不受影响。
