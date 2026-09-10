/**
 * Issue #359 — 政策渲染锚点全字段内容指纹(锚点 + 篡改 subject/statement/provenance)
 * 孤立 E2E:调用 public registered fact-gate 路径(`gotry_fact_gate` 的 registered
 * definition `gateArtifact` 在 `ts/src/artifact-gate.ts`),不启动 dsh 宿主。
 *
 * 关键纪律:
 *   - 不执行真实 ToolRuntime(`dsh` 进程 + tools/pre-execute + approval 等总线),
 *     直接 import 注册定义 `gateArtifact` —— 不把 registered definition 标成
 *     real host ToolRuntime,亦不把真 ToolRuntime 标成 registered definition;
 *   - 走真实事实日志路径:写一条合成 PolicyFact 到隔离 stateRoot 的
 *     `gotry-state/bookable-facts.jsonl`(append-only JSONL),再经
 *     `loadFactRegistry` 读取并跑闸;
 *   - 不调真实供应商 / browser / policy service / 共享状态;
 *   - 全部断言以合成 fixture 为输入;若 main 路径被改,这里应当同步失败并保留原违例。
 *
 * 运行(在 ts/ 下):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH GOTRY_SESSION_LIVE=0 \
 *     npx tsx scripts/policy-anchor-359-e2e.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BOOKABLE_FACT_SCHEMA,
  makeFactId,
  renderPolicyFact,
  type PolicyFact,
} from '../src/bookable-facts.ts'
import { gateArtifact, type AirlineAirportMap } from '../src/artifact-gate.ts'
import { appendFacts, loadFactRegistry } from '../capabilities/fact-log.ts'

const FETCHED = '2026-09-10T00:00:00.000Z'

const map = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'data', 'airline-airports.json'), 'utf-8')) as AirlineAirportMap

const smokeRoot = mkdtempSync(join(tmpdir(), 'gotry-policy-359-e2e-'))
const originalCwd = process.cwd()

async function main(): Promise<void> {
  try {
    const policy: PolicyFact = {
      schema: BOOKABLE_FACT_SCHEMA,
      fact_id: makeFactId(['policy-359', 'e2e', '泰国免签']),
      kind: 'policy',
      subject: '泰国入境(中国护照)',
      statement: '免签停留(口径以泰方公告为准);UAE 居民返程应优先校验 residence visa / Emirates ID 而非游客免签口径',
      source: 'web:official',
      query_id: 'web:policy:泰国免签',
      fetched_at: FETCHED,
      as_of: '2026-08-29',
    }

    // 走真实事实日志路径:append-only JSONL → loadFactRegistry
    await appendFacts(smokeRoot, [policy])
    const registry = await loadFactRegistry(smokeRoot)
    const persisted = registry.find((f): f is PolicyFact => f.kind === 'policy' && f.fact_id === policy.fact_id)
    if (!persisted) throw new Error('FAIL: 合成 PolicyFact 未落账到事实日志')
    assert.equal(persisted.subject, policy.subject, '事实日志保真:subject')
    assert.equal(persisted.as_of, policy.as_of, '事实日志保真:as_of')
    assert.equal(persisted.fetched_at, policy.fetched_at, '事实日志保真:fetched_at')
    console.log(`  ok - 合成 PolicyFact 经 appendFacts → loadFactRegistry 持久保真(${policy.fact_id})`)

    // public registered fact-gate 路径:registered definition = gateArtifact
    // 直接 import 调用,不启动 dsh 宿主;这是 registered definition,非 real ToolRuntime。
    const canonicalLine = renderPolicyFact(policy)
    const canonicalArtifact = ['## 政策', canonicalLine].join('\n')
    const canonicalReport = gateArtifact(canonicalArtifact, registry, map, { trip_year: 2026 })
    assert.equal(canonicalReport.verdict, 'pass', 'canonical anchored policy → pass')
    assert.equal(canonicalReport.traceable, 1, 'canonical anchored policy → traceable=1')
    console.log('  ok - canonical anchored policy 经 registered fact-gate definition → pass')

    // failing-before #359:改 subject 而保留 fact_id+as_of(provenance 全套不变)
    const changedSubjectArtifact = ['## 政策', canonicalLine.replace('泰国入境(中国护照)', '另一对象的政策')].join('\n')
    const subjReport = gateArtifact(changedSubjectArtifact, registry, map, { trip_year: 2026 })
    assert.equal(subjReport.verdict, 'blocked', '改 subject 保留 fact_id+as_of → blocked')
    assert.ok(subjReport.violations.some(v => v.kind === 'fact_anchor_unknown' && /另一对象的政策/.test(v.detail)),
      `改 subject → fact_anchor_unknown(违例:${JSON.stringify(subjReport.violations.map(v => v.kind))})`)
    console.log('  ok - 改 subject 保留 fact_id+as_of → blocked/fact_anchor_unknown')

    // failing-before #359:相反 statement
    const oppositeStatementArtifact = ['## 政策', canonicalLine.replace('免签停留', '不免签,需提前办签证')].join('\n')
    const oppReport = gateArtifact(oppositeStatementArtifact, registry, map, { trip_year: 2026 })
    assert.equal(oppReport.verdict, 'blocked', '相反 statement → blocked')
    assert.ok(oppReport.violations.some(v => v.kind === 'fact_anchor_unknown'),
      `相反 statement → fact_anchor_unknown(违例:${JSON.stringify(oppReport.violations.map(v => v.kind))})`)
    console.log('  ok - 相反 statement 保留 fact_id+as_of → blocked/fact_anchor_unknown')

    // failing-before #359:改 provenance(source / fetched_at / query_id 任一)
    const changedProvenanceArtifact = ['## 政策', canonicalLine
      .replace('[web:official@', '[synthetic:official@')
      .replace(FETCHED, '2026-09-01T00:00:00.000Z')
      .replace('#web:policy:泰国免签', '#synthetic:policy:泰国免签')].join('\n')
    const provReport = gateArtifact(changedProvenanceArtifact, registry, map, { trip_year: 2026 })
    assert.equal(provReport.verdict, 'blocked', '改 provenance 三件套 → blocked')
    assert.ok(provReport.violations.some(v => v.kind === 'fact_anchor_unknown'),
      `改 provenance → fact_anchor_unknown(违例:${JSON.stringify(provReport.violations.map(v => v.kind))})`)
    console.log('  ok - 改 source/fetched_at/query_id 任一 → blocked/fact_anchor_unknown')

    // legitimate review_by 与 tripStart-derived reminder 保留
    const reviewByPolicy: PolicyFact = { ...policy, review_by: '2027-06-16' }
    const reviewByLine = renderPolicyFact(reviewByPolicy)
    const reviewByReport = gateArtifact(['## 政策', reviewByLine].join('\n'), [reviewByPolicy], map, { trip_year: 2026 })
    assert.equal(reviewByReport.verdict, 'pass', 'legitimate review_by → pass')
    console.log('  ok - legitimate review_by 形态保留')

    const tripStart = '2027-07-16'
    const tripStartLine = renderPolicyFact(policy, tripStart)
    const tripStartReport = gateArtifact(['## 政策', tripStartLine].join('\n'), [policy], map, { trip_year: 2026, tripStart })
    assert.equal(tripStartReport.verdict, 'pass', 'legitimate tripStart reminder → pass')
    console.log('  ok - legitimate tripStart-derived reminder 形态保留')

    console.log('\nPOLICY ANCHOR #359 E2E: pass (deterministic synthetic, isolated stateRoot, registered fact-gate definition)')
  } finally {
    process.chdir(originalCwd)
    rmSync(smokeRoot, { recursive: true, force: true })
  }
}

await main()
