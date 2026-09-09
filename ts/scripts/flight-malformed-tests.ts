/**
 * Flight malformed fixture (#279):
 *   隔离扩展传输车道:注入临时端口桥 + 进程内假扩展客户端(回环直 fetch)。
 *   证明 sessionFlightSearch 的扩展分支对以下 batchSearch 响应都按合同收果:
 *     - JSON null body                    → verdict=error(非合法空,不静默收敛为 miss)
 *     - 非数组 flightItineraryList(对象)   → verdict=error
 *     - 非数组 priceList(item 局部非法)    → verdict=error(不暴露畸形行)
 *     - 合法空(data.flightItineraryList=[])→ verdict=miss(已识别合法空)
 *     - 合法命中                          → verdict=hit
 *     - 挑战页(title 命 CHALLENGE_RE)      → verdict=challenged(红线优先于解析)
 *     - 混合有效+畸形行                    → verdict=hit(保留有效项)
 *   全程:不开浏览器、不碰登录态、不写共享状态;唯一慢例=扩展会话桥自检(no-spend)。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSessionBridge, __resetSessionBridgeForTest, __setSessionBridgeForTest, EXTENSION_ORIGIN } from '../capabilities/session/extension-bridge.ts'
import { sessionFlightSearch, __resetRateLimiterForTest } from '../capabilities/session-search.ts'
import { buildEntryUrl } from '../capabilities/session/adapters/ctrip-flight.ts'

let passed = 0
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  await fn()
  passed += 1
  console.log(`  ok - ${label}`)
}

interface FakeJob {
  jobId: string
  kind: string
  site?: string
  url?: string
  timeoutMs?: number
}

async function claimOnce(port: number, respond: (job: FakeJob) => Record<string, unknown> | null): Promise<{ job: FakeJob | null }> {
  const r = await fetch(`http://127.0.0.1:${port}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
    body: JSON.stringify({ extensionVersion: 'flight-malformed-test', capabilities: ['ctrip-flight'] }),
  })
  const data = (await r.json()) as { job: FakeJob | null }
  if (data.job && respond) {
    const result = respond(data.job)
    if (result) {
      await fetch(`http://127.0.0.1:${port}/results/${encodeURIComponent(data.job.jobId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
        body: JSON.stringify(result),
      })
    }
  }
  return data
}

async function heartbeat(port: number): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/health`, { headers: { origin: EXTENSION_ORIGIN } })
}

async function main(): Promise<void> {
  console.log('§279 flight-malformed fixture(扩展传输车道注入,全离线)')

  // 入口 URL 校验;不查时报 unresolved 错误(这是早于解析的闸)
  const entry = buildEntryUrl('上海', '丽江', '2026-12-01')
  assert.ok(entry.ok && entry.url)
  const url = entry.url!

  // 隔离临时目录(本测试不写真实 profile)
  const tmp = mkdtempSync(join(tmpdir(), 'gotry-flight-malformed-'))

  const bridge = await createSessionBridge({ ports: [0] })
  assert.ok(bridge.ok, `临时桥创建成功: ${bridge.ok ? '' : bridge.summary}`)
  if (!bridge.ok) {
    rmSync(tmp, { recursive: true, force: true })
    process.exit(1)
  }
  const port = bridge.bridge.port
  __setSessionBridgeForTest(bridge.bridge)
  await heartbeat(port)

  // 单次长跑假扩展客户端:
  //   cookie-names → 票据名(用户已登录态)
  //   search       → 用当前 testCase.body/testCase.title 回包
  // testCase 是可变闭包;每次 expectVerdict 改写它后调用 sessionFlightSearch。
  let testCase: { body: string; title: string } = { body: '', title: '' }
  let done = false
  const claimLoop = (async () => {
    while (!done) {
      const ac = new AbortController()
      const bail = setTimeout(() => ac.abort(), 1_500)
      try {
        await claimOnce(port, (job) => {
          if (job.kind === 'cookie-names') return { ok: true, kind: 'cookie-names', names: ['cticket'] }
          if (job.kind === 'search') return { ok: true, kind: 'search', body: testCase.body, title: testCase.title }
          return null
        })
      } catch { /* park 中止=常态 */ }
      clearTimeout(bail)
    }
  })()

  try {
    const expectVerdict = async (label: string, body: string, title: string, expected: 'hit' | 'miss' | 'error' | 'challenged', extra?: (r: Awaited<ReturnType<typeof sessionFlightSearch>>) => void): Promise<void> => {
      __resetRateLimiterForTest()
      testCase = { body, title }
      const r = await sessionFlightSearch({ from: '上海', to: '丽江', date: '2026-12-01', timeoutMs: 5_000 })
      await check(label, () => {
        assert.equal(r.verdict, expected, `verdict 期望 ${expected},实 ${r.verdict} (${r.error ?? ''})`)
        if (extra) extra(r)
      })
    }

    await expectVerdict('JSON null body → error(非合法空,不静默收敛为 miss)', 'null', '机票列表', 'error', (r) => {
      assert.ok(r.error?.includes('形状异常'), 'error 文案点明形状异常')
      assert.ok(!r.options, 'error 不带 options')
      assert.ok(r.evidence.includes('[会话:ctrip-flight@error@'), '证据链为错误形')
    })

    await expectVerdict('非数组 flightItineraryList(对象) → error', JSON.stringify({ data: { flightItineraryList: { foo: 1 } } }), '机票列表', 'error', (r) => {
      assert.ok(r.error?.includes('形状异常'), 'error 文案点明形状异常')
    })

    await expectVerdict('非数组 flightItineraryList(字符串) → error', JSON.stringify({ data: { flightItineraryList: 'abc' } }), '机票列表', 'error')

    await expectVerdict('非数组 priceList(item 局部非法) → error(不暴露畸形行)',
      JSON.stringify({ data: { flightItineraryList: [{
        flightSegments: [{ airlineName: '吉祥航空', duration: 200, flightList: [{ flightNo: 'HO1', departureAirportName: '虹桥', arrivalAirportName: '三义', departureDateTime: '2026-12-01 07:35:00', arrivalDateTime: '2026-12-01 10:55:00' }] }],
        priceList: 'not-an-array',
      }] } }),
      '机票列表', 'error', (r) => {
        assert.ok(r.error?.includes('形状异常'), 'error 文案点明形状异常')
        assert.ok(!r.options, 'error 不带 options')
        assert.ok(r.evidence.includes('@error@'), '错误证据锚点存在')
      })

    await expectVerdict('合法空(flightItineraryList=[]) → miss(已识别合法空)', JSON.stringify({ data: { flightItineraryList: [] } }), '机票列表', 'miss', (r) => {
      assert.equal(r.options?.length ?? 0, 0)
      assert.ok(!r.error, '合法空不带 error')
      assert.ok(r.evidence.includes('[会话:ctrip-flight@'), '证据链正常')
    })

    const validHit = JSON.stringify({ data: { flightItineraryList: [{
      flightSegments: [{ airlineName: '吉祥航空', duration: 200, flightList: [{ flightNo: 'HO5577', departureAirportName: '虹桥国际机场', arrivalAirportName: '三义机场', departureDateTime: '2026-12-01 07:35:00', arrivalDateTime: '2026-12-01 10:55:00' }] }],
      priceList: [{ adultPrice: 3240 }, { adultPrice: 2980 }],
    }] } })
    await expectVerdict('合法命中 → hit(flightNo+最低价)', validHit, '机票列表', 'hit', (r) => {
      assert.equal(r.options?.length, 1)
      assert.equal(r.options?.[0]?.flightNo, 'HO5577')
      assert.equal(r.options?.[0]?.price, 2980)
      assert.ok(r.evidence.includes('1 options'), '证据链含选项数')
    })

    await expectVerdict('挑战页(title 命中 验证/滑块) → challenged(红线优先于解析)', 'null', '请完成滑块验证', 'challenged', (r) => {
      assert.ok(r.error?.includes('风控') || r.error?.includes('验证码'))
    })

    await expectVerdict('行全畸形 + 非空数组 → error(不伪装成 miss)',
      JSON.stringify({ data: { flightItineraryList: [{ flightSegments: [{}] }, 'not-object', null] } }),
      '机票列表', 'error', (r) => {
        assert.ok(r.error?.includes('形状异常'), 'error 文案点明形状异常')
        assert.ok(!r.options, 'error 不带 options')
        assert.ok(r.evidence.includes('@error@'), '错误证据锚点存在')
      })

    await expectVerdict('混合有效+畸形行 → hit(保留有效项,price=0)',
      JSON.stringify({ data: { flightItineraryList: [
        { flightSegments: [{}], priceList: [{ adultPrice: 'bad' }] },
        { flightSegments: [{ flightList: [{ flightNo: 'HO2', departureDateTime: '2026-12-01 08:00:00' }] }], priceList: [] },
      ] } }),
      '机票列表', 'hit', (r) => {
        assert.equal(r.options?.length, 1)
        assert.equal(r.options?.[0]?.flightNo, 'HO2')
        assert.equal(r.options?.[0]?.price, 0)
      })
  } finally {
    done = true
    await claimLoop
    await __resetSessionBridgeForTest()
    __setSessionBridgeForTest(null)
    await bridge.bridge.close()
    rmSync(tmp, { recursive: true, force: true })
  }

  console.log(`\n§279 flight-malformed fixture: ${passed} 段全绿`)
}

await main()
