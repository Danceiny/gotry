/**
 * Issue #359 — 政策锚点全字段内容指纹(注册 `gotry_fact_gate` 路径 E2E)。
 *
 * 真实执行面:在临时 stateRoot 下装载 gotry-tools 插件,通过 `apply(ctx, config)`
 * 装载注册定义,捕获 `gotry_fact_gate` 的 execute 函数,以 markdown 直接调用——
 * 经注册的 tool definition 走完 `loadFactRegistry(stateRoot)` → `gateArtifact`
 * → `itinerary.trip_start` 桥接(issue #359 finding 2),完整覆盖公开闸侧路径。
 * 不启动 dsh 宿主、不调用真实 ToolRuntime、不触碰供应商 / browser / policy
 * service / 共享状态。
 *
 * 运行(在 ts/ 下):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH GOTRY_SESSION_LIVE=0 \
 *     npx tsx scripts/policy-anchor-359-registered-e2e.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import {
  BOOKABLE_FACT_SCHEMA,
  makeFactId,
  renderPolicyFact,
  type PolicyFact,
} from '../src/bookable-facts.ts'
import { appendFacts } from '../capabilities/fact-log.ts'

const FETCHED = '2026-09-10T00:00:00.000Z'

interface ToolDef {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
  output: { render: (args: Record<string, unknown>, result: unknown) => Array<{ type?: string; text?: string }> }
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gotry-policy-359-registered-'))
  const stateRoot = join(home, 'state')
  const cwd = join(home, 'workspace')
  mkdirSync(stateRoot, { recursive: true })
  mkdirSync(cwd, { recursive: true })

  const policy: PolicyFact = {
    schema: BOOKABLE_FACT_SCHEMA,
    fact_id: makeFactId(['policy-359', 'reg', '泰国免签']),
    kind: 'policy',
    subject: '泰国入境(中国护照)',
    statement: '免签停留(口径以泰方公告为准);UAE 居民返程应优先校验 residence visa / Emirates ID 而非游客免签口径',
    source: 'web:official',
    query_id: 'web:policy:泰国免签',
    fetched_at: FETCHED,
    as_of: '2026-08-29',
  }

  // 走真实事实日志路径(append-only JSONL),与产品 gotry_flyai_search /
  // gotry_session_search 同款事实落账接口;闸侧 loadFactRegistry 直接读这里。
  await appendFacts(stateRoot, [policy])

  // 装载 gotry-tools 插件 → 捕获 gotry_fact_gate 的真实 execute。
  const registered: ToolDef[] = []
  const ctx = {
    tools: { register: (t: unknown) => registered.push(t as ToolDef) },
    systemPrompt: { section: () => undefined, variable: () => undefined },
    on: () => () => undefined,
  } as unknown as Context
  apply(ctx, {
    stateRoot,
    timeoutMs: 30_000,
    hbcliBin: 'hbcli-not-on-path',
    sessionAccess: 'off',
  })
  const factGate = registered.find(t => t.name === 'gotry_fact_gate')
  if (!factGate) throw new Error(`FAIL: 注册定义列表缺少 gotry_fact_gate,实际注册: ${registered.map(t => t.name).join(',')}`)
  const exec = { agent: { session: { header: { cwd } } } }

  // Case 1:canonical no-reminder 行经真实 gotry_fact_gate → pass。
  const canonicalLine = renderPolicyFact(policy)
  const c1Artifact = ['## 政策', canonicalLine].join('\n')
  const r1 = await factGate.execute({ markdown: c1Artifact }, exec) as { verdict?: string; traceable?: number; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r1.verdict, 'pass', `canonical no-reminder 经注册闸应 pass,实际: ${JSON.stringify({ verdict: r1.verdict, summary: r1.summary })}`)
  assert.equal(r1.traceable, 1)
  console.log(`  ok - 注册 gotry_fact_gate canonical no-reminder → pass`)

  // Case 2:legitimate review_by(事实自带)— 无 trip_start,canonical body 已含复核提醒。
  const reviewByPolicy: PolicyFact = { ...policy, fact_id: makeFactId(['policy-359', 'reg', 'review-by']), review_by: '2027-06-16' }
  await appendFacts(stateRoot, [reviewByPolicy])
  const reviewByLine = renderPolicyFact(reviewByPolicy)
  const r2 = await factGate.execute({ markdown: ['## 政策', reviewByLine].join('\n') }, exec) as { verdict?: string; traceable?: number; summary?: string }
  assert.equal(r2.verdict, 'pass', `legitimate review_by 经注册闸应 pass,实际: ${JSON.stringify({ verdict: r2.verdict, summary: r2.summary })}`)
  console.log(`  ok - 注册 gotry_fact_gate legitimate review_by → pass`)

  // Case 3:legitimate tripStart-derived reminder — 通过已加载 itinerary.trip_start 桥接
  // (不要求调用方额外传 opts.tripStart;闸侧自动从 itinerary 派)。
  // itinerary 必须保持自身不变量合法(nights/legs),否则闸会被 itineraryInvariants
  // 单独阻断,影响 policy 收口的可读性。这里给一个合法的同日往返零夜行程。
  const tripStart = '2027-07-16'
  const tripStartLine = renderPolicyFact(policy, tripStart)
  const r3 = await factGate.execute({
    markdown: ['## 政策', tripStartLine].join('\n'),
    itinerary: {
      trip_start: tripStart,
      trip_end: tripStart,
      stays: [],
      onboard_nights: 0,
      od_segments: [],
      budget_items: [],
    },
  }, exec) as { verdict?: string; traceable?: number; summary?: string }
  assert.equal(r3.verdict, 'pass', `legitimate tripStart-derived reminder 经注册闸应 pass,实际: ${JSON.stringify({ verdict: r3.verdict, summary: r3.summary })}`)
  console.log(`  ok - 注册 gotry_fact_gate legitimate tripStart reminder(经 itinerary.trip_start 桥接)→ pass`)

  // Case 4:trailing-after-anchor 攻击:合法 fact_id + 锚点后追加相反政策正文 → blocked。
  const trailingLine = `${canonicalLine} 反而是落地签,需提前办签证`
  const r4 = await factGate.execute({ markdown: ['## 政策', trailingLine].join('\n') }, exec) as { verdict?: string; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r4.verdict, 'blocked', `trailing-after-anchor 经注册闸应 blocked,实际: ${JSON.stringify({ verdict: r4.verdict, summary: r4.summary })}`)
  assert.ok(r4.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `trailing-after-anchor 应有 fact_anchor_unknown 违例,实际: ${JSON.stringify(r4.violations?.map(v => v.kind))}`)
  console.log(`  ok - 注册 gotry_fact_gate trailing-after-anchor 攻击 → blocked/fact_anchor_unknown`)

  // Case 5:subject 篡改(原 main 静默 pass 的反例)。
  const tamperedSubject = canonicalLine.replace('泰国入境(中国护照)', '另一对象的政策')
  const r5 = await factGate.execute({ markdown: ['## 政策', tamperedSubject].join('\n') }, exec) as { verdict?: string; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r5.verdict, 'blocked', `subject 篡改经注册闸应 blocked,实际: ${JSON.stringify({ verdict: r5.verdict, summary: r5.summary })}`)
  assert.ok(r5.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `subject 篡改应有 fact_anchor_unknown 违例,实际: ${JSON.stringify(r5.violations?.map(v => v.kind))}`)
  console.log(`  ok - 注册 gotry_fact_gate subject 篡改 → blocked/fact_anchor_unknown`)

  // Case 6:opposite statement 篡改 — 现实威胁:沿用合法 fact_id + 锚点改写 statement 方向。
  const oppositeStatement = canonicalLine.replace('免签停留', '不免签,需提前办签证')
  const r6 = await factGate.execute({ markdown: ['## 政策', oppositeStatement].join('\n') }, exec) as { verdict?: string; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r6.verdict, 'blocked', `opposite statement 篡改经注册闸应 blocked,实际: ${JSON.stringify({ verdict: r6.verdict, summary: r6.summary })}`)
  assert.ok(r6.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `opposite statement 应有 fact_anchor_unknown 违例,实际: ${JSON.stringify(r6.violations?.map(v => v.kind))}`)
  console.log(`  ok - 注册 gotry_fact_gate opposite statement 篡改 → blocked/fact_anchor_unknown`)

  // Case 7:provenance 篡改(source / fetched_at / query_id 任一)→ blocked。
  const tamperedProv = canonicalLine
    .replace('[web:official@', '[synthetic:official@')
    .replace(FETCHED, '2026-09-01T00:00:00.000Z')
    .replace('#web:policy:泰国免签', '#synthetic:policy:泰国免签')
  const r7 = await factGate.execute({ markdown: ['## 政策', tamperedProv].join('\n') }, exec) as { verdict?: string; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r7.verdict, 'blocked', `provenance 篡改经注册闸应 blocked,实际: ${JSON.stringify({ verdict: r7.verdict, summary: r7.summary })}`)
  assert.ok(r7.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `provenance 篡改应有 fact_anchor_unknown 违例,实际: ${JSON.stringify(r7.violations?.map(v => v.kind))}`)
  console.log(`  ok - 注册 gotry_fact_gate provenance(source/fetched_at/query_id)篡改 → blocked/fact_anchor_unknown`)

  // Compatibility(issue #359 final repair):注册闸侧既不传 itinerary、调用方也不显式
  // opts.tripStart 时,renderer 给的两类合法 canonical form 必须经真实 gotry_fact_gate
  // pass;否则(伪 reminder 日期、body 篡改、review_by 改写、trailing-after-anchor)
  // 必须仍走 fact_anchor_unknown。证明兼容性回退收敛于 renderer 自身的输出空间,
  // 不引入新公共 API,也不放行任意政策文本。
  const compatExec = exec

  // Case 8:context-free canonical no-reminder 经注册闸 → pass
  //   (renderer 不接 tripStart,policy 也无 review_by → 不应出现 reminder 段)
  const r8 = await factGate.execute({ markdown: ['## 政策', canonicalLine].join('\n') }, compatExec) as { verdict?: string; traceable?: number; summary?: string }
  assert.equal(r8.verdict, 'pass', `context-free no-reminder 经注册闸应 pass,实际: ${JSON.stringify({ verdict: r8.verdict, summary: r8.summary })}`)
  assert.equal(r8.traceable, 1)
  console.log(`  ok - 注册 gotry_fact_gate context-free canonical no-reminder → pass`)

  // Case 9:context-free canonical reminder(renderer 默认 defaultReviewBy(as_of))→ pass
  //   这是 issue #273 已有的历史形态,最终修复必须恢复。
  const compatTripStart = '2027-08-01'
  const compatTripStartLine = renderPolicyFact(policy, compatTripStart)
  const r9 = await factGate.execute({ markdown: ['## 政策', compatTripStartLine].join('\n') }, compatExec) as { verdict?: string; traceable?: number; summary?: string }
  assert.equal(r9.verdict, 'pass', `context-free derived reminder(无 itinerary 桥接)经注册闸应 pass,实际: ${JSON.stringify({ verdict: r9.verdict, summary: r9.summary })}`)
  assert.equal(r9.traceable, 1)
  console.log(`  ok - 注册 gotry_fact_gate context-free canonical derived reminder(无 itinerary 桥接)→ pass`)

  // Case 10:context-free canonical reminder(review_by 已知)→ pass
  //   reviewByPolicy 已在 Case 2 装载;这里只重复调用同一锚定行,证明无 itinerary 仍合法
  const r10 = await factGate.execute({ markdown: ['## 政策', reviewByLine].join('\n') }, compatExec) as { verdict?: string; traceable?: number; summary?: string }
  assert.equal(r10.verdict, 'pass', `context-free canonical reminder(review_by 已知)经注册闸应 pass,实际: ${JSON.stringify({ verdict: r10.verdict, summary: r10.summary })}`)
  assert.equal(r10.traceable, 1)
  console.log(`  ok - 注册 gotry_fact_gate context-free canonical reminder(review_by 已知)→ pass`)

  // Case 11:context-free 伪 reminder 日期(1999-01-01,renderer 不会用)→ blocked
  const compatBadDateLine = `${canonicalLine};远期政策须复核——到 1999-01-01 再核验一次 <!-- fact:${policy.fact_id} -->`
  const r11 = await factGate.execute({ markdown: ['## 政策', compatBadDateLine].join('\n') }, compatExec) as { verdict?: string; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r11.verdict, 'blocked', `伪 reminder 日期经注册闸应 blocked,实际: ${JSON.stringify({ verdict: r11.verdict, summary: r11.summary })}`)
  assert.ok(r11.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `伪 reminder 日期应有 fact_anchor_unknown 违例,实际: ${JSON.stringify(r11.violations?.map(v => v.kind))}`)
  console.log(`  ok - 注册 gotry_fact_gate context-free 伪 reminder 日期 → blocked/fact_anchor_unknown`)

  // Case 12:context-free body 篡改(免签停留 → 不免签停留,保留 fact_id 锚点)→ blocked
  const compatBadBodyLine = canonicalLine.replace('免签停留', '不免签停留')
  const r12 = await factGate.execute({ markdown: ['## 政策', compatBadBodyLine].join('\n') }, compatExec) as { verdict?: string; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r12.verdict, 'blocked', `body 篡改经注册闸应 blocked,实际: ${JSON.stringify({ verdict: r12.verdict, summary: r12.summary })}`)
  assert.ok(r12.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `body 篡改应有 fact_anchor_unknown 违例,实际: ${JSON.stringify(r12.violations?.map(v => v.kind))}`)
  console.log(`  ok - 注册 gotry_fact_gate context-free body 篡改 → blocked/fact_anchor_unknown`)

  // Case 13:context-free review_by 篡改(事实带 review_by,改 reminder 日期)→ blocked
  //   根 contract 第 2 条:若事实自带 review_by,renderer 优先级 review_by > tripStart,
  //   reminder 日期必须 == f.review_by;改了就是伪造。这里注册的是带 review_by 的事实。
  const fReviewBy: PolicyFact = { ...policy, fact_id: makeFactId(['policy-359', 'reg', 'review-by-tamper']), review_by: '2027-06-16' }
  await appendFacts(stateRoot, [fReviewBy])
  const compatReviewByTamperedLine = renderPolicyFact(fReviewBy).replace('2027-06-16', '2027-12-31')
  const r13 = await factGate.execute({ markdown: ['## 政策', compatReviewByTamperedLine].join('\n') }, compatExec) as { verdict?: string; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r13.verdict, 'blocked', `事实带 review_by 时改 reminder 日期经注册闸应 blocked,实际: ${JSON.stringify({ verdict: r13.verdict, summary: r13.summary })}`)
  assert.ok(r13.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `事实带 review_by 时改 reminder 日期应有 fact_anchor_unknown 违例,实际: ${JSON.stringify(r13.violations?.map(v => v.kind))}`)
  console.log(`  ok - 注册 gotry_fact_gate 事实带 review_by 改 reminder 日期 → blocked/fact_anchor_unknown`)

  // Case 14:context-free trailing-after-anchor(锚点后追加非空)→ blocked
  const compatTrailingLine = `${canonicalLine} 反而是落地签`
  const r14 = await factGate.execute({ markdown: ['## 政策', compatTrailingLine].join('\n') }, compatExec) as { verdict?: string; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r14.verdict, 'blocked', `trailing-after-anchor 经注册闸应 blocked,实际: ${JSON.stringify({ verdict: r14.verdict, summary: r14.summary })}`)
  assert.ok(r14.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `trailing-after-anchor 应有 fact_anchor_unknown 违例,实际: ${JSON.stringify(r14.violations?.map(v => v.kind))}`)
  console.log(`  ok - 注册 gotry_fact_gate context-free trailing-after-anchor → blocked/fact_anchor_unknown`)

  // Case 15:itinerary.trip_start 与 renderer reminder 不一致 → blocked
  //   闸侧走 itinerary 派发后不再回退兼容,renderer 给的是 2027-08-01 而 itinerary
  //   给的是 2027-08-15 → 必 fail-closed。
  const r15 = await factGate.execute({
    markdown: ['## 政策', compatTripStartLine].join('\n'),
    itinerary: {
      trip_start: '2027-08-15',
      trip_end: '2027-08-15',
      stays: [],
      onboard_nights: 0,
      od_segments: [],
      budget_items: [],
    },
  }, compatExec) as { verdict?: string; violations?: Array<{ kind?: string }>; summary?: string }
  assert.equal(r15.verdict, 'blocked', `itinerary 与 reminder 不一致经注册闸应 blocked,实际: ${JSON.stringify({ verdict: r15.verdict, summary: r15.summary })}`)
  assert.ok(r15.violations?.some(v => v.kind === 'fact_anchor_unknown'),
    `itinerary 与 reminder 不一致应有 fact_anchor_unknown 违例,实际: ${JSON.stringify(r15.violations?.map(v => v.kind))}`)
  console.log(`  ok - 注册 gotry_fact_gate itinerary 与 reminder 不一致 → blocked/fact_anchor_unknown`)

  // Case 16:itinerary.trip_start 存在时 canonical no-reminder 仍合法 → pass
  //   renderer 没接 tripStart 时,policy 文本里没有 reminder 段,与 itinerary 共存
  //   仍是合法的 canonical body。
  const r16 = await factGate.execute({
    markdown: ['## 政策', canonicalLine].join('\n'),
    itinerary: {
      trip_start: '2027-08-15',
      trip_end: '2027-08-15',
      stays: [],
      onboard_nights: 0,
      od_segments: [],
      budget_items: [],
    },
  }, compatExec) as { verdict?: string; traceable?: number; summary?: string }
  assert.equal(r16.verdict, 'pass', `itinerary 存在时 canonical no-reminder 经注册闸应 pass,实际: ${JSON.stringify({ verdict: r16.verdict, summary: r16.summary })}`)
  assert.equal(r16.traceable, 1)
  console.log(`  ok - 注册 gotry_fact_gate itinerary 存在时 canonical no-reminder → pass`)

  rmSync(home, { recursive: true, force: true })
  console.log('\nPOLICY ANCHOR #359 REGISTERED E2E: pass (deterministic synthetic, isolated stateRoot, registered gotry_fact_gate execute())')
}

await main()
