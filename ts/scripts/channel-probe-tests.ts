/**
 * 通道探针 tick 测试(外部事件接缝第 1 段,issue #82 兼容方向;全离线):
 *  1. evaluateProbeResults 纯函数:fail→down / ok+此前down→'ok'恢复 / ok+健康→零写 / skip→不产事件
 *  2. readLatestChannelEvents latest-wins:'ok' 事件超越同通道更早的 down(恢复语义落地)
 *  3. doctor 消费口径:恢复后 `state === 'down'` 判定不再命中(飞行可达性注释消失)
 *  4. metrics aggregateChannels:'ok' 超越后 newest 不含该通道,down 事件计数保留(历史频率面)
 *  5. CLI:--list 列探测面(session 系与 flyai 显式 skip);--only 未匹配 exit 2
 *  6. requireValidTimestamp opt-in(#436):坏时间戳行(未来/缺/坏)不得在 latest-wins
 *     覆盖前顶掉同通道更早的有效 down;默认口径(doctor/metrics/探针)不变
 *
 * 运行: cd ts && npx tsx scripts/channel-probe-tests.ts
 */

import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateProbeResults, defaultProbes, parseArgs, main } from './channel-probe.ts'
import { readLatestChannelEvents, recordChannelEvent } from '../capabilities/channel-health.ts'
import { aggregateChannels } from './build-metrics-report.ts'

const tmp = await mkdtemp(join(tmpdir(), 'gotry-probe-test-'))

// ── 1. evaluateProbeResults 纯函数 ───────────────────────────────────────────
const probes = defaultProbes()
const hb = probes.find((p) => p.channel === 'hbcli-hotel')!
const om = probes.find((p) => p.channel === 'open-meteo')!
const fly = probes.find((p) => p.channel === 'flyai')!
const now = new Date('2026-09-07T12:00:00Z')

const evs = evaluateProbeResults([
  { probe: hb, result: { ok: false, reason: 'auth-denied', ms: 5 } },
  { probe: om, result: { ok: true, ms: 100 } },
  { probe: fly, result: { ok: true, ms: 0 } },
], new Set(['open-meteo']), now)
assert.equal(evs.length, 2, `fail→down + ok恢复→'ok' 共 2 条,实际 ${evs.length}`)
assert.deepEqual(
  { channel: evs[0].channel, state: evs[0].state, reason: evs[0].reason },
  { channel: 'hbcli-hotel', state: 'down', reason: 'auth-denied' },
  'fail 应产 down 事件带 reason',
)
assert.deepEqual(
  { channel: evs[1].channel, state: evs[1].state },
  { channel: 'open-meteo', state: 'ok' },
  'ok 且此前 down 应产 ok 恢复事件',
)
const noWrites = evaluateProbeResults([{ probe: om, result: { ok: true, ms: 90 } }], new Set(), now)
assert.equal(noWrites.length, 0, 'ok 且此前健康 → 零写放大')

// ── 2. latest-wins:'ok' 超越更早的 down ──────────────────────────────────────
const stateRoot = join(tmp, 'state')
await mkdir(join(stateRoot, 'gotry-state'), { recursive: true })
const jsonl = join(stateRoot, 'gotry-state', 'channel-health.jsonl')
await writeFile(jsonl, [
  JSON.stringify({ channel: 'opensky', state: 'down', reason: 'http-503', at: '2026-09-07T10:00:00.000Z' }),
  JSON.stringify({ channel: 'opensky', state: 'ok', at: '2026-09-07T11:00:00.000Z' }),
  JSON.stringify({ channel: 'hbcli-hotel', state: 'down', reason: 'auth-denied', at: '2026-09-07T10:30:00.000Z' }),
  'not-json-garbage',
  '',
].join('\n'), 'utf-8')
const latest = await readLatestChannelEvents(stateRoot, { now: Date.parse('2026-09-07T12:00:00Z') })
assert.equal(latest.get('opensky')?.state, 'ok', "'ok' 应超越同通道更早的 down")
assert.equal(latest.get('hbcli-hotel')?.state, 'down', '未恢复通道保持 down')
assert.equal(latest.size, 2, '坏行跳过,latest 只含两通道')

// ── 3. doctor 消费口径:恢复后 '=== down' 不命中 ─────────────────────────────
const openskyEv = latest.get('opensky')
assert.ok(openskyEv && openskyEv.state !== 'down', 'doctor 的 down 判定应不再命中已恢复通道')

// ── 4. metrics:ok 超越后 newest 不含该通道,计数保留 ─────────────────────────
const rows = (await readFile(jsonl, 'utf-8')).split('\n').filter((l) => l.trim()).flatMap((l) => {
  try { return [JSON.parse(l)] } catch { return [] }
})
const stats = aggregateChannels(rows, { now: new Date('2026-09-07T12:00:00Z'), windowDays: 30 })
const openskyStat = stats.latest.find((c) => c.channel === 'opensky')
assert.equal(openskyStat, undefined, 'ok 超越的通道不应出现在当前 down/cooldown newest 面')
const hbStat = stats.latest.find((c) => c.channel === 'hbcli-hotel')
assert.ok(hbStat && hbStat.state === 'down', '未恢复通道仍在 newest 面')

// ── 5. CLI 面 ────────────────────────────────────────────────────────────────
const listed = defaultProbes()
assert.ok(listed.find((p) => p.channel === 'flyai')?.probeable === false, 'flyai 默认不探(共享额度)')
assert.ok(listed.filter((p) => p.channel.startsWith('session:')).every((p) => !p.probeable), 'session:* 全部 skip')
assert.deepEqual(
  parseArgs(['--state-root', '/tmp/x', '--only', 'a, b', '--dry-run']),
  { stateRoot: '/tmp/x', only: ['a', 'b'], dryRun: true, list: false },
  'parseArgs 解析',
)
const rcList = await main(['--list'])
assert.equal(rcList, 0, '--list exit 0')
const rcBad = await main(['--only', 'no-such-channel'])
assert.equal(rcBad, 2, '--only 未匹配 exit 2')

// ── 6. requireValidTimestamp opt-in(#436):坏时间戳不得顶掉更早的有效 down ────
const strictRoot = join(tmp, 'strict')
await mkdir(join(strictRoot, 'gotry-state'), { recursive: true })
const strictJsonl = join(strictRoot, 'gotry-state', 'channel-health.jsonl')
const strictNow = Date.parse('2026-09-07T12:00:00Z')
const validDownRow = JSON.stringify({ channel: 'session:ctrip-flight', state: 'down', reason: 'challenged', at: '2026-09-07T10:00:00.000Z' })
const unusableRows: [string, string][] = [
  ['未来 down', JSON.stringify({ channel: 'session:ctrip-flight', state: 'down', reason: 'clock-skew', at: '2026-09-08T10:00:00.000Z' })],
  ['未来 ok', JSON.stringify({ channel: 'session:ctrip-flight', state: 'ok', at: '2026-09-08T10:00:00.000Z' })],
  ['缺时间戳 ok', JSON.stringify({ channel: 'session:ctrip-flight', state: 'ok' })],
  ['坏时间戳 down', JSON.stringify({ channel: 'session:ctrip-flight', state: 'down', reason: 'bad-at', at: 'not-a-date' })],
  ['过期 down', JSON.stringify({ channel: 'session:ctrip-flight', state: 'down', reason: 'stale', at: '2026-08-01T10:00:00.000Z' })],
]
for (const [label, badRow] of unusableRows) {
  await writeFile(strictJsonl, `${validDownRow}\n${badRow}\n`, 'utf-8')
  const strict = await readLatestChannelEvents(strictRoot, { now: strictNow, requireValidTimestamp: true })
  assert.equal(strict.get('session:ctrip-flight')?.state, 'down', `有效 down 之后的${label}行不得顶掉它(严格模式)`)
  const legacy = await readLatestChannelEvents(strictRoot, { now: strictNow })
  assert.ok(legacy.has('session:ctrip-flight'), '默认口径仍读得到该通道(未改老消费者)')
}
await writeFile(strictJsonl, `${validDownRow}\n${JSON.stringify({ channel: 'session:ctrip-flight', state: 'ok', at: '2026-09-07T11:30:00.000Z' })}\n`, 'utf-8')
assert.equal(
  (await readLatestChannelEvents(strictRoot, { now: strictNow, requireValidTimestamp: true })).get('session:ctrip-flight')?.state,
  'ok',
  '保留期内的有效 ok 仍能恢复(latest-wins 不变)',
)
await writeFile(strictJsonl, `${JSON.stringify({ channel: 'session:ctrip-flight', state: 'down', at: '2026-09-08T10:00:00.000Z' })}\n`, 'utf-8')
assert.ok(
  !(await readLatestChannelEvents(strictRoot, { now: strictNow, requireValidTimestamp: true })).has('session:ctrip-flight'),
  '全坏行文件在严格模式下不产生该通道的行(不压制)',
)
assert.ok(
  (await readLatestChannelEvents(strictRoot, { now: strictNow })).get('session:ctrip-flight')?.state === 'down',
  '默认口径保持旧行为:未来 down 仍被读出(opt-in 才改)',
)

console.log('CHANNEL PROBE TESTS: 6/6 OK(evaluate 纯函数 / latest-wins 恢复 / doctor 口径 / metrics 超越 / CLI 面 / 严格时间戳 opt-in #436)')
