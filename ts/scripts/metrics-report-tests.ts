/**
 * #138 指标面板第一切片测试(全离线,隔离 mkdtemp stateRoot;绝不触真实状态目录):
 * 聚合正确性(去重/blocked 率/窗口过滤/百分位)、坏行容忍、空根成型、只读纪律
 * (collect 前后目录条目集合不变)、--out 落盘形态。
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aggregateFacts, aggregateChannels, aggregateIncidents, aggregateLatency, collectMetrics, renderMetricsReport, main } from './build-metrics-report.ts'

// fixture 时间戳必须相对真实时钟:聚合器(main)按真实 now 取 --days 窗口,
// 硬编码绝对日期会随日历自然老化出窗(2026-09-11 起 iso(1) 跌出 7 天窗,§6 假红)。
const DAY = 86_400_000
const NOW = new Date(Date.now() - 1 * DAY)
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString()

let checkCount = 0
function check(name: string, fn: () => void): void {
  fn()
  checkCount += 1
  console.log(`  ok ${checkCount} ${name}`)
}

async function withRoot<T>(fn: (root: string, stateDir: string) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'gotry-metrics-'))
  const stateDir = join(root, 'gotry-state')
  mkdirSync(stateDir, { recursive: true })
  try {
    return await fn(root, stateDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeJsonl(dir: string, name: string, lines: unknown[]): void {
  writeFileSync(join(dir, name), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', 'utf-8')
}

// 1. 事实闸:同 fact_id 取最新 + 坏行跳过 + blocked 率
check('事实闸聚合:去重/blocked 率/坏行容忍', () => {
  const stats = aggregateFacts([
    { schema: 'gotry_bookable_fact.v1', fact_id: 'f1', kind: 'flight_like', verdict: 'hit' },
    'NOT JSON',
    { schema: 'gotry_bookable_fact.v1', fact_id: 'f1', kind: 'flight_like', verdict: 'error' }, // 重查后翻转为 error,后者胜
    { schema: 'gotry_bookable_fact.v1', fact_id: 'f2', kind: 'flight_like', verdict: 'hit' },
    { schema: 'gotry_bookable_fact.v1', fact_id: 'f3', kind: 'hotel', verdict: 'needs-setup' },
    { schema: 'gotry_bookable_fact.v1', fact_id: 'f4', kind: 'hotel', verdict: 'miss' },
    { fact_id: 'f5', kind: 'hotel' }, // 无 verdict → n/a 桶,不计 blocked
  ])
  assert.equal(stats.lines, 7)
  assert.equal(stats.deduped, 5)
  const flight = stats.byKind.flight_like
  assert.equal(flight.total, 2)
  assert.equal(flight.verdicts.error, 1)
  assert.equal(flight.verdicts.hit, 1)
  assert.equal(flight.blocked, 1)
  const hotel = stats.byKind.hotel
  assert.equal(hotel.total, 3)
  assert.equal(hotel.blocked, 1)
  assert.equal(hotel.verdicts['n/a'], 1)
})

// 2. 通道健康:窗口过滤 + 每通道最新 + 事件计数
check('通道健康聚合:30 天窗/最新事件/计数', () => {
  const stats = aggregateChannels([
    { channel: 'flyai', state: 'down', reason: 'trial-exhausted', at: iso(40) }, // 窗外 → 滤掉
    { channel: 'flyai', state: 'down', reason: '429', at: iso(2) },
    { channel: 'flyai', state: 'cooldown', reason: 'retry-after', at: iso(1) }, // 更新 → 最新
    { channel: 'session:ctrip-hotel', state: 'down', reason: 'needs-login', at: iso(5) },
    'BROKEN',
  ], { now: NOW })
  assert.equal(stats.latest.length, 2)
  const flyai = stats.latest.find((c) => c.channel === 'flyai')
  assert.equal(flyai?.state, 'cooldown')
  assert.equal(flyai?.events, 2)
  const ctrip = stats.latest.find((c) => c.channel === 'session:ctrip-hotel')
  assert.equal(ctrip?.events, 1)
})

// 3. 事故面:窗口过滤 + byKind + 最近一条 + top 来源
check('事故面聚合:窗口/kind 计数/最近一条/top 来源', () => {
  const stats = aggregateIncidents([
    { ts: iso(10), kind: 'uncaughtException', message: '太旧不计', source: 'old-plugin' },
    { ts: iso(1), kind: 'plugin_error', message: 'z3 wasm boom', source: 'z3' },
    { ts: iso(0.2), kind: 'plugin_error', message: 'second boom', source: 'z3' },
    { ts: iso(0.1), kind: 'tool_execute_error', message: 'flyai 429', source: 'flyai' },
  ], { now: NOW, windowDays: 7 })
  assert.equal(stats.totalInWindow, 3)
  assert.equal(stats.byKind.plugin_error.count, 2)
  assert.equal(stats.byKind.plugin_error.lastMessage, 'second boom')
  assert.deepEqual(stats.topSources[0], { source: 'z3', count: 2 })
})

// 4. 桥延迟:百分位与超预算计数
check('桥延迟聚合:p50/p95/max/超预算', () => {
  const stats = aggregateLatency([
    { ts: iso(1), kind: 'hotel_search:hbcli', latencyMs: 100 },
    { ts: iso(1), kind: 'hotel_search:hbcli', latencyMs: 200 },
    { ts: iso(0.5), kind: 'weather:open-meteo', latencyMs: 300 },
    { ts: iso(0.4), kind: 'weather:open-meteo', latencyMs: 400 },
    { ts: iso(0.3), kind: 'hotel_search:session', latencyMs: 501 }, // 超预算
    { ts: iso(9), kind: 'old', latencyMs: 999_999 }, // 窗外
    { ts: iso(0.2), kind: 'bad', latencyMs: Number.NaN }, // 非数 → 跳过
  ], { now: NOW, windowDays: 7 })
  assert.equal(stats.count, 5)
  assert.equal(stats.p50, 300)
  assert.equal(stats.p95, 501)
  assert.equal(stats.max, 501)
  assert.equal(stats.overBudget, 1)
  assert.deepEqual(stats.topKinds[0], { kind: 'hotel_search:hbcli', count: 2 })
})

// 5. 空根:collect+render 成型、零写入
await withRoot(async (root) => {
  const before = readdirSync(root).sort()
  const snap = await collectMetrics(root, { now: NOW })
  const md = renderMetricsReport(snap)
  assert.match(md, /事实闸 verdict 分布/)
  assert.match(md, /通道健康/)
  assert.match(md, /事故面/)
  assert.match(md, /桥延迟/)
  assert.match(md, /\(空:窗口内无事故\)/)
  assert.match(md, /不存在\(该 stateRoot 无账本\)/)
  assert.deepEqual(readdirSync(root).sort(), before, 'collect 不得在 stateRoot 新建任何文件')
  checkCount += 1
  console.log(`  ok ${checkCount} 空 stateRoot:报告成型且零写入`)
})

// 6. 全量端到端:写各侧车 → 聚合进报告;--out 落盘;gotry-state 目录零改动
await withRoot(async (root, stateDir) => {
  writeJsonl(stateDir, 'bookable-facts.jsonl', [
    { schema: 'gotry_bookable_fact.v1', fact_id: 'a', kind: 'hotel', verdict: 'hit' },
    { schema: 'gotry_bookable_fact.v1', fact_id: 'b', kind: 'hotel', verdict: 'error' },
  ])
  writeJsonl(stateDir, 'channel-health.jsonl', [
    { channel: 'flyai', state: 'down', reason: 'trial-exhausted', at: iso(1) },
  ])
  writeJsonl(stateDir, 'incidents.jsonl', [
    { ts: iso(1), kind: 'plugin_error', message: 'boom', source: 'z3' },
  ])
  writeJsonl(stateDir, 'bridge-latency.jsonl', [
    { ts: iso(1), kind: 'hotel_search:hbcli', latencyMs: 120 },
  ])
  writeFileSync(join(stateDir, 'doctor-report.md'), '# doctor\n', 'utf-8')
  const before = readdirSync(stateDir).sort()
  const outPath = join(root, 'report.md')
  await main(['--state-root', root, '--out', outPath, '--days', '7'], NOW)
  const md = readFileSync(outPath, 'utf-8')
  assert.match(md, /hotel \| 2 \| hit:1 \/ error:1 \| 1\/2\(50%\)/)
  assert.match(md, /\| flyai \| down \| trial-exhausted \|/)
  assert.match(md, /plugin_error \| 1 /)
  assert.match(md, /p50=120ms/)
  assert.match(md, /doctor 报告 doctor-report\.md:存在/)
  assert.deepEqual(readdirSync(stateDir).sort(), before, '报告生成不得改动 gotry-state 目录')
  assert.ok(existsSync(outPath))
  checkCount += 1
  console.log(`  ok ${checkCount} 端到端:侧车聚合→--out 落盘,stateRoot 只读`)
})

console.log(`\nMETRICS REPORT TESTS OK(${checkCount} checks)`)
