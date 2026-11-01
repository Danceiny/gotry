/**
 * rc.33 行程实测(2026-11-01)的证据日期绑定夹具:exact-date 查询结果 + R1/R2 产物。
 *
 * 事实取自实测会话的 flyai 结果(航班号/时刻/价格/取数时刻与实测一致);产物只保留与本闸
 * 有关的航班行和标题,个人行程内容已去掉,行形状与实测产物逐字一致。供
 * evidence-date-binding-tests.ts(纯规则 + apply() 产品缝)与 evidence-date-guard-e2e.ts
 * (安装包真实运行)共用。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AirlineAirportMap } from '../../src/artifact-gate.ts'
import { factsFromFlyai, type FlightFact, type FlyaiLikeOption } from '../../src/bookable-facts.ts'

export const map = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'data', 'airline-airports.json'), 'utf-8')) as AirlineAirportMap
/** 实测当天(宿主当地);无年份的 12/1 据此解析为 2026-12-01 */
export const TODAY = '2026-11-01'

// ---- 夹具:rc.33 行程实测的 exact-date 查询结果(flyai 形状,取数时刻同实测) ----

function flyai(origin: string, destination: string, date: string, fetchedAt: string, options: FlyaiLikeOption[]): FlightFact[] {
  return factsFromFlyai({ kind: 'flight', origin, destination, date }, { verdict: 'hit', options }, fetchedAt, map.city_alias)
}

export const R1_FACTS: FlightFact[] = [
  ...flyai('迪拜', '上海', '2026-11-30', '2026-11-01T05:55:18.225Z', [
    { no: 'QR1019', name: '卡塔尔航空', depDateTime: '2026-11-30 22:50', arrDateTime: '2026-12-01 14:40', price: 5747, nonstop: false },
    { no: 'EK302', name: '阿联酋航空', depDateTime: '2026-11-30 03:10', arrDateTime: '2026-11-30 15:05', price: 5317 },
  ]),
  ...flyai('迪拜', '上海', '2026-12-02', '2026-11-01T05:54:18.962Z', [
    { no: 'QR1019', name: '卡塔尔航空', depDateTime: '2026-12-02 22:50', arrDateTime: '2026-12-03 14:40', price: 4515, nonstop: false },
    { no: 'EK302', name: '阿联酋航空', depDateTime: '2026-12-02 03:10', arrDateTime: '2026-12-02 15:05', price: 5317 },
  ]),
  ...flyai('深圳', '迪拜', '2026-12-16', '2026-11-01T05:54:57.722Z', [
    { no: 'EK329', name: '阿联酋航空', depDateTime: '2026-12-16 00:45', arrDateTime: '2026-12-16 05:20', price: 2568 },
  ]),
  ...flyai('深圳', '长春', '2026-12-02', '2026-11-01T05:54:04.000Z', [
    { no: '9C6481', name: '春秋航空', depDateTime: '2026-12-02 06:40', arrDateTime: '2026-12-02 12:05', price: 859 },
  ]),
  ...flyai('哈尔滨', '深圳', '2026-12-14', '2026-11-01T05:55:13.000Z', [
    { no: '9C8672', name: '春秋航空', depDateTime: '2026-12-14 11:25', arrDateTime: '2026-12-14 17:40', price: 840 },
  ]),
  ...flyai('哈尔滨', '深圳', '2026-12-15', '2026-11-01T05:54:22.000Z', [
    { no: '9C8672', name: '春秋航空', depDateTime: '2026-12-15 11:25', arrDateTime: '2026-12-15 17:40', price: 730 },
  ]),
]
// R2 补查的 12/17(价格与 12/16 不同:¥2615)
export const EK329_1217 = flyai('深圳', '迪拜', '2026-12-17', '2026-11-01T07:05:40.146Z', [
  { no: 'EK329', name: '阿联酋航空', depDateTime: '2026-12-17 00:45', arrDateTime: '2026-12-17 05:20', price: 2615 },
])
export const EK329_1216 = R1_FACTS.find(f => f.flight_no === 'EK329')!

// ---- 夹具:rc.33 R1 产物(去掉与本闸无关的个人行程内容;行形状与实测产物逐字一致) ----

export const R1_MD = `# 12 月初行程（2026-12-01 → 12-16）

> 生成日期 2026-11-01。所有带「✅ 实证」的价格/班次来自 flyai 实时查询，无标记者不可下单。

## 二、逐日骨架

| 日期 | 星期 | 安排 |
|---|---|---|
| 12/1 | 二 | 白天上班 → **22:50 迪拜 ✈ 上海**（QR1019 经多哈） |
| 12/16 | 三 | 上午办事 → 陆路回深圳 → **00:45 深圳 ✈ 迪拜** |
| 12/17 | 四 | 05:20 抵迪拜 |

## 四、实时班次与价格（2026-11-01 查询）

### ✅ 出境（迪拜 → 上海，12/1）
- \`QR1019\` 22:50 → 12/2 14:40 浦东，经多哈中转，**¥5747**
- \`EK302\` 03:10 → 15:05 浦东，直飞，**¥5317**

### ✅ 回程（深圳 → 迪拜，12/17 00:45）
- \`EK329\` 00:45 → 05:20 迪拜，**直飞 ¥2568** ← 最优，凌晨走不占白天

### ✅ 国内段
- 深圳→长春 12/2：\`9C6481\` 06:40→12:05 **¥859**
- 哈尔滨→深圳 12/15：\`9C8672\` 11:25→17:40 **¥730**

## 七、会消耗假期时间的坑

1. 若坐 \`EK302\` 03:10，12/2 的一半就在飞机上。

## 八、下一步

1. 订 **迪拜→上海 12/1（QR1019 或 EK302/304）** 与 **深圳→迪拜 12/17 00:45（EK329 ¥2568）**
`

export const R1_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>12 月初行程</title>
<style>.tag{color:#0a7d3c}</style></head>
<body>
<h1>12 月初行程</h1>
<h2>2 · 逐日骨架</h2>
<div class="day"><div class="d">12/1<small>周二</small></div><div class="c">白天上班 &rarr; <strong>22:50 迪拜 ✈ 上海</strong>（QR1019 经多哈）</div></div>
<h2>4 · 实时班次与价格 <span class="tag t-ok">2026-11-01 实证</span></h2>
<h3>出境 · 迪拜 → 上海（12/1）</h3>
<table>
<tr><th>航班</th><th>时间</th><th>时长</th><th>中转</th><th>价格</th></tr>
<tr><td><code>QR1019</code> 卡航</td><td>22:50 → 12/2 14:40 浦东</td><td>11h50m</td><td>多哈</td><td><strong>¥5747</strong></td></tr>
</table>
<h3>回程 · 深圳 → 迪拜（12/17 00:45）</h3>
<table>
<tr><th>航班</th><th>时间</th><th>时长</th><th>中转</th><th>价格</th></tr>
<tr><td><code>EK329</code> 阿联酋</td><td>00:45 → 05:20 迪拜</td><td>8h35m</td><td><span class="tag t-ok">直飞</span></td><td><strong>¥2568</strong> ★最优</td></tr>
</table>
<h3>国内段</h3>
<table>
<tr><th>航段</th><th>日期</th><th>推荐</th><th>时间</th><th>价格</th></tr>
<tr><td>深圳→长春</td><td>12/2</td><td><code>9C6481</code></td><td>06:40 → 12:05</td><td>¥859</td></tr>
</table>
</body></html>
`

// R2 修正版(模型被告知后自己改对的版本):✅ 行全部与同日事实对齐;勘误表引用 R1 的错行但带 ❌
export const R2_MD = `# 12 月初行程（2026-12-01 → 12-17）

> 生成 2026-11-01 · 修订版 R2
> 每条 ✅ 的日期已与行程日期逐条对齐；对不上的一律降级为 ⚠️/❌。

## 0 · R2 修订记录（两处实证错误）

| # | R1 的错误 | 事实 | 处理 |
|---|---|---|---|
| 1 | 写「\`QR1019\` 22:50→次日14:40 **¥5747**，12/1 出行」 | 该班次实际是 **11/30** 的；**12/2 那班是 ¥4515**；**12/1 当天从未查过** | ❌ 从行程删除，12/1 出境段标「**未查得**」 |
| 2 | 写「\`EK329\` ¥2568，12/17 00:45」并标 ✅ | 查到的其实是 **12/16 00:45** 那班；12/17 那班从未查询 | ❌ 降级：¥2568 只对 **12/16 00:45** 有效；12/17 标「**未查得**」 |

## 2 · 逐日骨架（R2）

| 日期 | 星期 | 安排 |
|---|---|---|
| 12/15 | 二 | 哈尔滨 ✈ 深圳（✅\`9C8672\` 11:25→17:40 ¥730）→ 陆路进香港，下午办事 |
| 12/16 | 三 | 回深圳 → **00:45 \`EK329\` 直飞迪拜 ✅¥2568** |

## 3 · 实证清单（每条日期已对齐）

### ✅ 可直接下单
| 航段 | 日期 | 航班 | 时间 | 价格 |
|---|---|---|---|---|
| 哈尔滨→深圳 | **12/15** | \`9C8672\` 春秋 | 11:25 → 17:40 | **¥730** |
| 深圳→迪拜 | **12/16** | \`EK329\` 阿联酋 | 00:45 → 05:20 | **¥2568** 直飞 |
| 深圳→长春 | 12/2 | \`9C6481\` | 06:40 → 12:05 | ¥859 |

### ❌ 未查得（不得下单，不得标 ✅）
| 航段 | 日期 | 状态 |
|---|---|---|
| 迪拜→上海 | **12/1** | 查询报 \`搜索机票低价行业失败\` |
| 深圳→迪拜 | **12/17** | 查询报 \`搜索机票低价行业失败\` |
`
