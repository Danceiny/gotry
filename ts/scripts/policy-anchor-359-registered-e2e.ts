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

  rmSync(home, { recursive: true, force: true })
  console.log('\nPOLICY ANCHOR #359 REGISTERED E2E: pass (deterministic synthetic, isolated stateRoot, registered gotry_fact_gate execute())')
}

await main()
