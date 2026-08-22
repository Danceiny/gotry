# M2 段 2:机票免费数据源选型建议(§7-1 决策门材料)

> 关键事实(2026-08 调研):**Amadeus Self-Service 已于 2026-07-17 关停**(新注册更早暂停,现仅剩 Enterprise 门户)——tech-strategy §2.1 列出的第一候选已失效,本备忘录据此重排。

## 一、候选对比(免费层)

| 数据源 | 免费额度 | 覆盖 | 限制 | 对 GoTry 的适配点 |
|---|---|---|---|---|
| **OpenSky Network** | 4,000 credits/天,开源 | 实时 ADS-B 航迹 | 无票价/班期表,是「飞机在哪」不是「有哪些航班」 | 校验源:验证某航班真实执飞(引擎证据链的 [实时API] 标注) |
| **aviationstack** | 100 请求/月 | 实时班期+历史+航线 | 免费层 HTTP 明文;量极小 | 补充抽样:真实班期样本(月 100 次慎用) |
| **OpenFlights** | 静态数据库整包下载 | 机场/航司/航线/机型 | 无时刻无价格 | **骨架层**:城市对通航性(引擎候选集的合法性校验) |
| 用户 bookedResources | 无限额 | 用户已出票行程 | 需用户给 | **锚点源**:真实班期+价格(零成本,高保真) |
| 人工提炼静态包(现状) | — | 金标准用例 | 需人工 | 基线维持 |

## 二、建议(呈 §7-1)

**三层组合,全部免费,零新代码依赖**(数据经 CLI/JSON 桥进能力层,符合 ADR-3 桥接收敛):

1. **骨架层 = OpenFlights 静态包**(一次性导入 data/ 层,城市对通航性校验);
2. **锚点层 = 用户 bookedResources**(契约已有该字段;M3 种子用户开始自然积累);
3. **校验层 = OpenSky(主力,量足)+ aviationstack(月度小样本)**——证据链标注 [实时API:opensky/aviationstack]。

**明确不做**:票价聚合(Skyscanner/Kiwi 等均商业授权)——M2 期价格继续用静态包估算+显式标注,M5 交易闭环时随供应链协议解决。

## 三、若创始人批准后的段 3 落地序

T3-1 capability-hotelbe(hbcli 桥,酒店六能力已全)→ T3-2 opensky 校验桥(单文件脚本,不进插件)→ T3-3 OpenFlights 静态包导入与通航性校验接入引擎候选集。

来源:[PhocusWire: Amadeus self-service 关停](https://www.phocuswire.com/amadeus-shut-down-self-service-apis-portal-developers)、[Amadeus for Developers](https://developers.amadeus.com/)、[aviationstack pricing](https://aviationstack.com/pricing)、[OpenSky API](https://opensky-network.org/data/api)、[Thunderbit 对比](https://thunderbit.com/blog/best-flight-api-with-free-tiers)、[Geekflare](https://geekflare.com/dev/flight-data-api/)
