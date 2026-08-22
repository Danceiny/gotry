# M2 数据源桥:hotelbyte-cli 命令缺口盘点(段 1 产出)

> 依据:tech-strategy §2.1(免费/开源优先)与 §2(酒店数据=import+extend hotelbyte-cli,已决 G4)。
> 方法:克隆 hotelbyte-com/hotelbyte-cli 源码,枚举实际命令,对照 GoTry 能力层需求。

## 一、hbcli 现有命令(vs GoTry 需求)

| GoTry 能力层需求 | hbcli 命令 | 覆盖度 | 缺口说明 |
|---|---|---|---|
| 城市搜索 | `search destinations` | ✅ 完整 | 直接可用 |
| 酒店搜索 | `search hotel-list` | ✅ 完整 | 直接可用 |
| 酒店报价 | `search hotel-rates` / `search check-avail` | ✅ 完整 | 直接可用 |
| 酒店详情 | `search hotel-detail` | ✅ 完整 | 直接可用 |
| 酒店静态数据 | `search hotels-metadata` | ✅ 完整 | 直接可用 |
| 订单查询 | `orders list/detail/dashboard/...` | ✅ | M5 交易闭环用 |
| **地理映射** | — | ❌ **缺口** | POI 坐标→酒店距离矩阵(engine 的 OfficeDistance/接驳时长数据源) |
| 机票数据 | — | ❌ **缺口(预期内)** | hbcli 仅酒店域;机票走 §2.1 的 Amadeus/aviationstack/公开数据集 |

## 二、结论与扩展计划

**缺口比预期小**:六项酒店域能力 hbcli 全部已有,`--json` 全命令支持(总结自源码 CLI-Anything 模式)。真正的缺口只有两项:

1. **地理映射命令(G4 备忘录中的「命令缺口」)**——扩展方向:`search geo-mapping`(输入:POI 坐标集+酒店 ID 集;输出:距离矩阵)。上游扩展,回馈 hotelbyte-com/hotelbyte-cli。
2. **机票数据源**——hbcli 域外,走免费路线(段 2):Amadeus 测试层(免费月额度)→ OpenFlights/OpenSky(静态骨架)→ 用户 bookedResources(真实锚点)。

**capability-hotelbe 插件的实现路径(段 3)**:dsh 插件内经子进程调 `hbcli search ... --json`,证据字段带 `[实时API:hbcli]` + 抓取时间——与 bridge.ts 延迟计量模式一致。**先决条件:hbcli 需要能跑通**(需 HotelByte API 环境/凭证,缺 uat/prod 凭证时命令会报 auth 错——段 3 首步验证 auth 是否可跳过或需 mock)。

## 三、后续段(M2 内)

- 段 2:机票免费数据源调研与选择(§7-1 决策门:创始人)
- 段 3:capability-hotelbe 插件(hbcli 桥 + 证据标注)
- 段 4:geo-mapping 命令扩展(回馈上游)
