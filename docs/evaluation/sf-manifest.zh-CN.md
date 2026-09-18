[English](sf-manifest.md) | [简体中文](sf-manifest.zh-CN.md)

# sf-01..08 冻结清单——用例、通道与真实会话需求（issue #272 离线段）

> 定位：8 条 session 航班基准用例的冻结 v1 清单，整合 `ts/data/sf-golden-manifest.json`（评分 golden）、RFC P3.6–P3.8 证据链与逐 case 通道/真实会话分类。状态：冻结 v1（2026-09-18）；用例增改须走新 manifest 修订。

## 冻结用例表（源自 `ts/data/sf-golden-manifest.json`，阈值 0.9）

| Case | 航线 | 日期 | 已知航班（子串匹配） | 价格带（CNY） |
|---|---|---|---|---|
| sf-01 | 上海 → 丽江 | 2026-10-01 | HO5577, MU6145, 9C8779 | 800–4000 |
| sf-02 | 北京 → 大理 | 2026-10-02 | CA1441, MU5712, 3U8831 | 800–4500 |
| sf-03 | 上海 → 三亚 | 2026-11-11 | 9C8779, MU5377, HU7177, CZ6766 | 500–3000 |
| sf-04 | 广州 → 昆明 | 2026-12-20 | CZ3497, MU5738, 3U8805, 8L9628 | 400–2500 |
| sf-05 | 深圳 → 成都 | 2026-10-05 | CZ3453, MU5402, CA4314, 3U8744 | 400–2500 |
| sf-06 | 杭州 → 厦门 | 2026-10-06 | GJ7153, MU5520, CZ6955 | 300–2000 |
| sf-07 | 西安 → 桂林 | 2026-10-07 | JD5143, MU2176, CZ6319 | 400–2500 |
| sf-08 | 重庆 → 贵阳 | 2026-10-08 | G52667, CZ5817, MU2146, GY7122 | 250–1800 |

评分合同：硬字段（`query_id`/`from`/`to`/`currency`/`source`/`verdict`）精确匹配；软字段 ±60 min 时间 / ±15 % 价格带 / 班次子串。

## 通道矩阵——哪些需要显式授权的真实浏览器会话

| 通道 | 需要真实登录？ | 覆盖 | 状态 |
|---|---|---|---|
| manual golden（`--golden` 默认，`sf-golden-manifest.json`） | **否** | 全部 8 条，离线评分对照 | ✅ 冻结（P3.7） |
| static golden（`--golden=static`，OpenFlights 固定修订+估算带） | **否** | 全部 8 条，航线/承运+估算班期 | ✅ 冻结（P3.8） |
| session-benchmark 离线 fixture（`session-benchmark.ts`） | **否** | sf-01 fixture 自测 | ✅ 达成 |
| session 适配器 **live**（携程登录态经扩展桥） | **是——需显式授权的真实浏览器会话** | 全部 8 条真实 verdict | ⏳ 待：一次性扩展安装+登录态（P3.6 gate） |
| flyai 对照（`--golden=flyai`） | 否（官方 key，配额受限） | 全部 8 条（sf-07/sf-08 历史上为 flyai hit） | ✅ 已演练（trial-limit 风险已记录） |

**分类结论**：全部 8 条用例均可离线回归覆盖（manual/static golden+离线 fixture）——回归保护不需要任何真实会话。唯一需要显式授权真实浏览器会话的是 **真实会话双源批量重跑**（P3.6/P3.7 的「待登录态」gate），且需用户一次性安装扩展；运行窗口内风控触发计数必须保持 0（RFC §3.5 红线）。

## 证据现状（已入账）

- **P3.6 本地 live 测试**：8 查询，7/8 verdict=hit，6/6 manual-golden 软命中 100 %（sf-01 MU6145 ¥3240 7.9 s … sf-08 miss 25 s flyai）；ReadGuard 8/8 零写入；challenge 0/8。
- **P3.7 双源**：flyai trial-limit → 可插拔 golden 交付；批量重跑待登录态。
- **P3.8 static 生命周期**：连续两轮登录态 8 查询，官方 8/8 hit，可评分命中 13/13 = 100 %。

证据文件 owner-local 存于 `~/.gotry/evidence/session/sf-XX/<ts>.json`；`sf-summary.ts` 一条命令重建统一汇总。cookie 值与个人行程数据不入 git/issues。
