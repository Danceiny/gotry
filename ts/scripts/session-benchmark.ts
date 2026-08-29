/**
 * #21 首切片的确定性验收：字段级 fixture scorer、双源合同与 waiting gate。
 *
 * 只构造脱敏内存 fixture；不访问网络、Chrome、登录态或共享产品状态。
 */

import assert from 'node:assert/strict'

import {
  evaluateDoubleSource,
  scoreSessionFixture,
  type SessionComparableRecord,
} from '../capabilities/session/benchmark.ts'
import { parseFlyaiItemList } from '../capabilities/flyai.ts'
import { classifyTransportFailure } from '../capabilities/session-search.ts'

let passed = 0

function check(label: string, assertion: () => void): void {
  assertion()
  passed += 1
  console.log(`  ok - ${label}`)
}

const sessionFixture: SessionComparableRecord = {
  query_id: 'sf-01',
  route_segments: [{
    from: '上海虹桥',
    to: '丽江三义',
    departure_at: '2026-10-01T07:35:00+08:00',
    arrival_at: '2026-10-01T10:55:00+08:00',
    transport_number: 'HO5577',
  }],
  journey_type: 'direct',
  currency: 'CNY',
  price: 1611,
  source: 'ctrip-flight',
  fetched_at: '2026-08-28T16:00:00Z',
  verdict: 'hit',
  latency_ms: 4200,
  read_guard_blocked: 0,
}

const officialFixture: SessionComparableRecord = {
  ...structuredClone(sessionFixture),
  price: 230,
  source: 'flyai',
  fetched_at: '2026-08-28T15:59:00Z',
}

console.log('SESSION DOUBLE-SOURCE CONTRACT')

check('完整单段 fixture 为 13/13', () => {
  const score = scoreSessionFixture(sessionFixture, structuredClone(sessionFixture))
  assert.equal(score.pass, true)
  assert.equal(score.accuracy, 1)
  assert.equal(score.total, 13)
})

check('缺失 required 字段与错误价格都进入准确率分母', () => {
  const actual = structuredClone(sessionFixture) as Partial<SessionComparableRecord>
  actual.currency = ''
  actual.price = 999
  const score = scoreSessionFixture(sessionFixture, actual)
  assert.equal(score.pass, false)
  assert.deepEqual(score.missing, ['currency'])
  assert.deepEqual(score.incorrect, ['price'])
  assert.equal(score.accuracy, 11 / 13)
})

check('字段类型不一致不能靠字符串化蒙混过关', () => {
  const actual = { ...structuredClone(sessionFixture), price: '1611' }
  const score = scoreSessionFixture(sessionFixture, actual)
  assert.equal(score.accuracy, 12 / 13)
  assert.deepEqual(score.incorrect, ['price'])
})

check('非法 golden fixture 自身 fail-closed', () => {
  const expected = { ...structuredClone(sessionFixture), price: 0 }
  const score = scoreSessionFixture(expected, structuredClone(expected))
  assert.equal(score.pass, false)
  assert.deepEqual(score.fixture_errors, ['price'])
})

check('中转 fixture 逐段计分', () => {
  const transfer: SessionComparableRecord = {
    ...structuredClone(sessionFixture),
    query_id: 'sf-02',
    journey_type: 'transfer',
    route_segments: [
      structuredClone(sessionFixture.route_segments[0]!),
      {
        from: '丽江三义',
        to: '西双版纳嘎洒',
        departure_at: '2026-10-02T08:20:00+08:00',
        arrival_at: '2026-10-02T09:35:00+08:00',
        transport_number: '8L9608',
      },
    ],
  }
  const score = scoreSessionFixture(transfer, structuredClone(transfer))
  assert.equal(score.pass, true)
  assert.equal(score.total, 18)
})

check('同路线班次可比，价格差只记录不判错', () => {
  const result = evaluateDoubleSource({ official: officialFixture, session: sessionFixture })
  assert.equal(result.state, 'comparable')
  assert.deepEqual(result.mismatches, [])
  assert.equal(result.price_delta, 1381)
  assert.equal(result.quota_disposition, 'evidence_ready')
})

check('时刻不一致投影 divergent', () => {
  const session = structuredClone(sessionFixture)
  session.route_segments[0]!.arrival_at = '2026-10-01T11:15:00+08:00'
  const result = evaluateDoubleSource({ official: officialFixture, session })
  assert.equal(result.state, 'divergent')
  assert.deepEqual(result.mismatches, ['route_segments[0].arrival_at'])
})

check('等价时区时刻保持 comparable', () => {
  const session = structuredClone(sessionFixture)
  session.route_segments[0]!.departure_at = '2026-09-30T23:35:00Z'
  session.route_segments[0]!.arrival_at = '2026-10-01T02:55:00Z'
  const result = evaluateDoubleSource({ official: officialFixture, session })
  assert.equal(result.state, 'comparable')
})

check('needs-attach 为 waiting-user no-spend', () => {
  const session = { ...structuredClone(sessionFixture), verdict: 'needs-attach' as const }
  const result = evaluateDoubleSource({ official: officialFixture, session })
  assert.equal(result.state, 'waiting_attach')
  assert.equal(result.retry_allowed, false)
  assert.equal(result.quota_disposition, 'no_spend_waiting_user')
})

check('CDP 缺席与握手失败稳定投影 needs-attach', () => {
  assert.equal(classifyTransportFailure('日常 Chrome 未开调试端口', true), 'needs-attach')
  assert.equal(classifyTransportFailure('cdp attach 失败:socket closed', true), 'needs-attach')
  assert.equal(classifyTransportFailure('chrome launch failed', false), 'error')
})

check('needs-login 为 waiting-user no-spend', () => {
  const session = { ...structuredClone(sessionFixture), verdict: 'needs-login' as const }
  const result = evaluateDoubleSource({ official: officialFixture, session })
  assert.equal(result.state, 'waiting_login')
  assert.equal(result.retry_allowed, false)
  assert.equal(result.quota_disposition, 'no_spend_waiting_user')
})

check('缺失 session 证据不擅自投影用户 gate', () => {
  const result = evaluateDoubleSource({ official: officialFixture })
  assert.equal(result.state, 'source_unavailable')
  assert.equal(result.quota_disposition, 'no_spend_stop')
})

check('challenge 立即停止', () => {
  const session = { ...structuredClone(sessionFixture), verdict: 'challenged' as const }
  const result = evaluateDoubleSource({ official: officialFixture, session })
  assert.equal(result.state, 'challenge_stop')
  assert.equal(result.quota_disposition, 'no_spend_stop')
})

check('challenge 与 ReadGuard 优先于 waiting-user', () => {
  const challengedOfficial = { ...structuredClone(officialFixture), verdict: 'challenged' as const }
  const waitingSession = { ...structuredClone(sessionFixture), verdict: 'needs-attach' as const }
  assert.equal(evaluateDoubleSource({ official: challengedOfficial, session: waitingSession }).state, 'challenge_stop')
  waitingSession.read_guard_blocked = 1
  assert.equal(evaluateDoubleSource({ official: officialFixture, session: waitingSession }).state, 'guard_violation')
})

check('ReadGuard 非零 fail-closed', () => {
  const session = { ...structuredClone(sessionFixture), read_guard_blocked: 1 }
  const result = evaluateDoubleSource({ official: officialFixture, session })
  assert.equal(result.state, 'guard_violation')
  assert.equal(result.quota_disposition, 'no_spend_stop')
})

check('缺 required 合同字段时 fail-closed', () => {
  const session = { ...structuredClone(sessionFixture), currency: '' }
  const result = evaluateDoubleSource({ official: officialFixture, session })
  assert.equal(result.state, 'invalid_contract')
  assert.deepEqual(result.missing, ['session.currency'])
  assert.equal(result.quota_disposition, 'no_spend_stop')
})

check('FlyAI stdout 前后噪声不污染完整业务 JSON', () => {
  const payload = {
    data: {
      itemList: [{
        journeys: [],
        systemMessage: '提示含花括号 {limited} 与引号 "quoted" 仍属于 JSON 字符串',
      }],
    },
  }
  const noisy = `npm notice {not-json}\n${JSON.stringify(payload)}\npostflight log {done}`
  assert.deepEqual(parseFlyaiItemList(noisy), payload.data.itemList)
})

check('FlyAI stdout 可跳过前置诊断 JSON', () => {
  const payload = { data: { itemList: [{ ticketPrice: '230.00' }] } }
  assert.deepEqual(
    parseFlyaiItemList(`{"level":"info","message":"warmup"}\n${JSON.stringify(payload)}\n`),
    payload.data.itemList,
  )
})

check('FlyAI 无完整 itemList 对象时保持 fail-closed', () => {
  assert.throws(() => parseFlyaiItemList('{"data":{"itemList":['), /incomplete FlyAI JSON object/)
  assert.throws(() => parseFlyaiItemList('{"message":"SentinelBlockException"}'), /no complete FlyAI itemList JSON object/)
})

console.log(`SESSION DOUBLE-SOURCE CONTRACT: ${passed} pass`)
