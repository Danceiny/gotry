[English](decisions-needed.md) | [简体中文](decisions-needed.zh-CN.md)

# Decisions Needed — 创始人拍板项汇总

> 定位：当前所有需 founder 拍板才能解锁的事项入口；每条含路径、上下文、影响范围、建议，各项独立、按优先级逐条回。
> 状态：living（拍板队列；已结算项原地标注归档）
> 上游：拍板触发的设计/里程碑文档——[`milestones/m6-b2b-reuse-walkthrough.md`](milestones/m6-b2b-reuse-walkthrough.md)（P6 walkthrough）、[`design/milestone-delivery-plan.md`](design/milestone-delivery-plan.md)（M4→M6 任务图）、[`design/external-event-seam.md`](design/external-event-seam.md)（D-31 接缝）。
> 下游：按回执推进的实现/Exit 证据与 issue gate 更新；founder YES 只满足对应决策门，不自动改写里程碑 Entry。
> 各项独立——你可以按优先级逐条回；按回执推进。

**速览：当前 1 项待拍板——#137 P6 founder review（整体方案批准）。** P6 明确 YES 仍不满足 M6 Entry：M5 Exit 仍是前置门，P6 批准不旁路 M5。M5 Entry 的进入条件在 #136 跟踪。D-1~D-9、D-4a 均已结算；D-31 为触发式（等第一个真实 world2agent 回调方再拍，见下），当前非开放运行时面。

## 未决

### #137 P6 founder review（整体方案批准）

**当前待拍板**：founder 尚未明确批准 M6 整体方案或修改稿。只有明确 YES 或对修改稿明确批准才满足 P6 Exit。**P6 YES 仍不满足 M6 Entry**——M5 Exit 仍是前置门，P6 批准不旁路 M5；两者并列前置，任一未满足则 M6 不开闸。
**位置**：[`milestones/m6-b2b-reuse-walkthrough.md`](milestones/m6-b2b-reuse-walkthrough.md)（draft，待 founder 评审）；issue #137；任务图见 [`design/milestone-delivery-plan.md`](design/milestone-delivery-plan.md) M6-1/M6-2。

### D-31 外部事件写入信任模型

**触发式**：等第一个真实 world2agent 回调方出现再拍。本地探针免鉴权，远程回调需签名/通道绑定；拍板前远程面不开。开放触发跟踪见 issue #82；issue #119 为已关闭的设计记录。
**位置**：[`design/external-event-seam.md`](design/external-event-seam.md)；开放触发跟踪 issue #82；设计记录 issue #119（已关闭）。

---

## 已结算（归档，新置顶的决策在最上）

| # | 事项 | 决策 | 结算 |
|---|---|---|---|
| D-9 | dsh-calendar 分发面 | **默认不挂载**；挂载与否进 setup 状态面（`~/.gotry/calendar.json`，`npx @danceiny/gotry setup calendar` on/off），禁止环境变量控制产品行为（founder 2026-09-03 纠偏）；doctor 增宿主插件节 | ✅ 2026-09-03（ADR-25，run-all §50） |
| D-8 | 工具编排策略 | **静态平铺 + 健康态驱动的动态建议**：工具面平铺不变、解译器不做隐藏派发；通道健康面 + verdict≠hit 时结果内注入 `routing` 顺位表（可用性>证据级>效率）；persona （19） 收缩为注册表生成片段 | ✅ 2026-09-03（同上） |
| D-7 | 有额度工具的配额归属 | **分层归属**：匿名 trial 池=首次体验导流层，正式使用升级 user-key/user-session；产品统一 key 池暂缓，M3 真实 cohort 规模出现时复审；doctor 增配额探测 | ✅ 2026-09-03（同上） |
| D-2 | M4 校准七题 | auto-guess 5/7 + founder 提供剩余 4 题（2026-08-26）：f1~16:xx 起飞 23:00 落/f4 实际昆明→珠海+顺风车返深/Rawai 公寓首夜失败次日换酒店/EK329 后按摩店过夜；附带原则：校准永不阻塞，动态 follow 动机 | ✅ 真值吸收进 data/*.json meta.reconcil |
| D-6 | OSM 兜底 | **删 OSM 计划**——Anything/agent-reach 已统一，OSM 是兜底的兜底，过度工程；M4 scale-up 视 HBc 配额再议 | ✅ 2026-08-24 |
| D-5 | OpenSky 实时观测 | 保留 1 tick | ✅ |
| D-4a | agent-reach 残余渠道 | 100% follow → wrapper 化（反射桥，删 13 渠道 switch）；8 渠道需 cookie（founder 0 工作记 pending，谁有 cookie 接谁） | ✅ 2026-08-22/23 |
| D-4 | hotel-be Anything 通用搜索接入 | 选 A：复用 hotel-be 既有 Anything + hbcli 当统一 transport | ✅ 2026-08-23 三仓 commit 闭环 |
| D-3 | npm publish | 已打通 2026-08-22：`@danceiny/gotry` scoped 发布（gotry 裸名撞 go-try）；founder 开 2FA + 恢复码当 OTP；发布命令全隔离 NPM_CONFIG_USERCONFIG | ✅ scripts/publish-npm.sh |
| D-1 | License | **MIT** | ✅ 2026-08-23 |

## 已结算详情（留有后续操作价值的三项）

### D-2 校准真值（YAML 快照，已吸收进引擎）

```yaml
# f1 实际 HKG→HKT 班次
f1_actual: "HX741 20:20"          # (b)HX741 晚班:Kimi 7.18 当天飞撞早高峰,CX773 12:15 太紧
# f4 8.9 KMG→SZX 实际到达时间
f4_szx_arrival: "22:00"             # 中间值 — EK328/DZ6252 跨日,给 EK329 红眼留 4h 缓冲
# Rawai 房型 + 价格档(你长住+工作型)
rawai_room_type: "Studio"          # (a) 单房舒适档;非套间
rawai_nightly_price: 400           # 约 ¥400/晚
# 8.10 凌晨 EK329 落地→躺床上
szt_arrival_hours: 1.5             # SZX→南山车程(你住南山)
# 8.10 凌晨红眼→办公室精力自评(0-100,基线 D-6 落地模型)
energy_8_10: 80                    # 估算:红眼 11h 落地精力 75% + 1.5h 路上补眠 10% 80%;>70 算"可行"
# 全程总花费拆分(2 周 普吉+云南+迪拜往返;Kimi 7.18-8.10)
total_spend_breakdown:
  flights_international: 4000     # SZX-HKG 1k + HKG-OMDB 1.6k + OMDB-HKT 0.5k + KMG-SZX 0.9k
  accommodation_2w: 4200          # Rawai 6 晚*¥400 + 甲米周末 2 晚*¥600 + 云南 5 晚*¥300
  ground_transport: 1200           # 普吉+甲米包车 + 云南段包车 + 机场接送
  meals_2w: 1500
  activities_diving_hot_spring: 1000
  total: 11900                      # 上 4 项加总(实测典型预算 ≈¥12k,落在 demo 预算分层 ¥12.6k/¥16.3k 中间)
```

### D-4 架构链路（实测通）

```
dsh LLM
  └─(gotry_anything_search 工具)→ gotry capabilities/anything.ts
    └─(spawn hbcli search anything --json)─→ hotelbyte-cli
      └─(POST /api/search/anything)─→ hotel-be api/dispatcher
        └─(go-zero analyzer + @path注解)─→ search/service.Anything
          └─(混合 城市+酒店 search)─→ candidates[]
```

落地位置：`hotel-be/search/service/geography.go`（@path 注解暴露 `/api/search/anything`）、`hotelbyte-cli/src/commands/search.ts`（anything 子命令）、`gotry/ts/capabilities/anything.ts` + `ts/scripts/anything-tests.ts`（5/5）+ `ts/src/index.ts` 挂工具。遗留（不挡 go-live）：hotel-be `registerInternalServices` 可加 `SearchSrv` 走 internal 路径（M4 scale-up 后再说）；Anything 无 `lat/lng` fallback（`region.latitude` 已够用）。

### D-7/D-8/D-9 选项记录（2026-09-03，设计全文 `docs/design/tool-orchestration-design.md`）

- **D-7 配额归属**：选 A 分层归属。否决 B（产品统一 key 池——成本/滥用面/上游 ToS 三个未定量立即到期）与 C（维持现状，配额不可见）。起因：flyai 匿名试用共享池 429 达限（2026-09-02 迪拜 session 实测）暴露「额度归属」无定义。
- **D-8 编排策略**：选 A 静态平铺+动态建议。否决 B（解译器层自动改道——模型调 A 实际走 B，破坏调用可审计性，推翻 ADR-18 判定记录）与 C（反转静态优先级——每个新用户先付一次扩展安装成本）。A 下「session bridge 优先级」从常量变为健康面投影：flyai 健康时首荐 flyai（零摩擦），429 当刻 session 升首荐并附安装/登录指引。
- **D-9 calendar 分发**：选 A 默认不挂载。否决 B（保留默认挂载+doctor 引导——治标：模型仍会先撞一次报错）。起因：dsh-calendar 在 gotry 分发面内且未配置时工具报错降级，模型会话中段撞「未配置 username」；gotry 对 calendar 的唯一诉求是工作窗口读取，而 persona （1） 访谈本就首轮必问工作窗口。
