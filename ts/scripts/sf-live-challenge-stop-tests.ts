/**
 * sf live benchmark 挑战截断离线 E2E(issue #411,RFC §3.5 挑战红线)。
 *
 * 真实 CLI 路径:spawn 真 runner(scripts/sf-live-benchmark.ts,Node24 原生 type stripping),只在 /tmp
 * overlay 副本里把 capabilities/session-search.ts 替换为脚本化确定性响应——
 *   challenge@all  首条即 challenged → 期望整批在 1 次调用后截断;
 *   challenge@2    首条 hit、第二条 challenged → 期望 2 次调用后截断;
 *   challenge@8    前七条 hit、第八条 challenged → 8 条证据齐全但仍非完整批次;
 *   hit@all        普通 8 条批次 → 期望跑满且 sf-summary 仍标完整/有效校准。
 * comparator(flyai CLI)经 PATH shim(npx 即败 + 计数)证明「停止后不再调用」;
 * globalThis.fetch 陷阱兜底断言零网络。HOME/evidence root 全部临时,零真实
 * 网站/浏览器/供应商请求,不触碰共享 founder state。
 *
 * 同时断言:challenged 的结构化语义(session.verdict / doubleSource=challenge_stop /
 * no_spend_stop)不被改写;部分批次落盘 stop_reason + attempted/not_attempted 清单;
 * sf-summary 对挑战批次 status=fail_closed(即使 8 条证据齐全也不标完整/有效校准)。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const REAL_TS = join(import.meta.dirname, '..')
// macOS 的 /tmp 是 /private/tmp 符号链接:sf-summary 以 argv[1]===import.meta.url 判定
// 直跑入口,overlay 路径必须先规范化,否则 argv[1](/tmp/...)与模块 URL(/private/tmp/...)不等,main() 会被静默跳过
const TMP_ROOT = realpathSync(tmpdir())
const EXPECTED_QUERY_IDS = Array.from({ length: 8 }, (_, index) => `sf-${(index + 1).toString().padStart(2, '0')}`)
const IDS_AFTER_FIRST = EXPECTED_QUERY_IDS.slice(1)

interface Overlay {
  base: string
  home: string
  ts: string
  evidenceRoot: string
  defaultEvidenceRoot: string
  sessionCallCounter: string
  npxCounter: string
  netCounter: string
  timerPreload: string
}

function readLines(path: string): string[] {
  try {
    const text = readFileSync(path, 'utf8')
    return text.length === 0 ? [] : text.split('\n').filter((line) => line.length > 0)
  } catch {
    return []
  }
}

/** overlay = 仓库 ts 源副本(脚本/能力/数据)+ 真 node_modules 符号链接 + 确定性 session 模块 */
function buildOverlay(tag: string): Overlay {
  const base = mkdtempSync(join(TMP_ROOT, `gotry-sf411-${tag}-`))
  const home = join(base, 'home')
  const overlayTs = join(base, 'ts')
  mkdirSync(home, { recursive: true })
  for (const entry of ['scripts', 'capabilities', 'data'] as const) {
    cpSync(join(REAL_TS, entry), join(overlayTs, entry), { recursive: true })
  }
  cpSync(join(REAL_TS, 'package.json'), join(overlayTs, 'package.json'))
  cpSync(join(REAL_TS, 'tsconfig.json'), join(overlayTs, 'tsconfig.json'))
  symlinkSync(join(REAL_TS, 'node_modules'), join(overlayTs, 'node_modules'), 'dir')

  // Keep the explicit destination outside HOME so the test proves that the
  // new flag, rather than the default, owns every benchmark artifact.
  const explicitEvidenceRoot = join(base, 'explicit evidence root')
  const defaultEvidenceRoot = join(home, '.gotry', 'evidence', 'session')

  // Optional local baseline mode lets the harness prove that main@20d728e
  // fails the explicit-root contract without touching the live worktree.
  if (process.env.SF503_BASELINE === '1') {
    const baseline = execFileSync('git', [
      'show',
      '20d728e3668d302821bad0f8687ca8ef55d29ed5:ts/scripts/sf-live-benchmark.ts',
    ], { cwd: join(REAL_TS, '..'), encoding: 'utf8' })
    writeFileSync(join(overlayTs, 'scripts', 'sf-live-benchmark.ts'), baseline)
  }

  // 确定性 session 模块:每次调用计数并按 SF411_SCRIPT 返回 hit/challenged
  writeFileSync(join(overlayTs, 'capabilities', 'session-search.ts'), `// sf411 E2E 确定性 session 模块(仅存在于临时 overlay;真模块不参与本测试)
import { appendFileSync } from 'node:fs'

export type SessionVerdict = 'hit' | 'miss' | 'error' | 'challenged' | 'cooldown' | 'needs-login' | 'needs-attach' | 'needs-extension'

export interface SessionSearchResult {
  ok: boolean
  via: 'session-ctrip-flight' | 'session-ctrip-flight-error'
  evidence: string
  latencyMs: number
  verdict: SessionVerdict
  options?: Array<{ depDateTime: string; arrDateTime: string; flightNo: string; price: number }>
  error?: string
}

export interface SessionFlightQuery { from: string; to: string; date: string }

let calls = 0
export async function sessionFlightSearch(q: SessionFlightQuery): Promise<SessionSearchResult> {
  calls += 1
  const counter = process.env.SF411_CALL_COUNTER
  if (counter) appendFileSync(counter, JSON.stringify({ call: calls, query_id: q.from + '->' + q.to, date: q.date }) + '\\n')
  const script = process.env.SF411_SCRIPT ?? 'challenge@all'
  const challengeFrom = script === 'challenge@all'
    ? 1
    : script.startsWith('challenge@')
      ? Number(script.slice('challenge@'.length))
      : Number.POSITIVE_INFINITY
  if (Number.isInteger(challengeFrom) && challengeFrom >= 1 && calls >= challengeFrom) {
    return {
      ok: false,
      via: 'session-ctrip-flight-error',
      evidence: '[stub] challenged #' + String(calls),
      latencyMs: 1,
      verdict: 'challenged',
      error: '风控/验证码命中(stub);按红线不重试不绕过,交还用户',
    }
  }
  return {
    ok: true,
    via: 'session-ctrip-flight',
    evidence: '[stub] hit #' + String(calls),
    latencyMs: 1,
    verdict: 'hit',
    options: [{ depDateTime: '2026-10-01T08:30:00+08:00', arrDateTime: '2026-10-01T11:40:00+08:00', flightNo: 'MU9999', price: 1234 }],
  }
}
`)

  // comparator 计数 shim:npx 即败(退出 97),计数即 comparator 尝试数
  const shimDir = join(base, 'shim')
  mkdirSync(shimDir, { recursive: true })
  const npxShim = join(shimDir, 'npx')
  writeFileSync(npxShim, `#!/bin/sh
printf '1\\n' >> "$SF411_NPX_COUNTER"
echo 'sf411 shim: flyai CLI must not run in offline proof' >&2
exit 97
`)
  chmodSync(npxShim, 0o755)

  // 零网络兜底:fetch 陷阱(记录并抛错)
  const netTrap = join(base, 'net-trap.mjs')
  writeFileSync(netTrap, `import { appendFileSync } from 'node:fs'
globalThis.fetch = async (...args) => {
  if (process.env.SF411_NET_COUNTER) appendFileSync(process.env.SF411_NET_COUNTER, JSON.stringify(String(args[0])) + '\\n')
  throw new Error('blocked network in sf411 offline proof')
}
`)
  const timerPreload = join(base, 'timer-preload.mjs')
  writeFileSync(timerPreload, `const nativeSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay === 35000) return nativeSetTimeout(callback, 0, ...args)
  return nativeSetTimeout(callback, delay, ...args)
}
`)

  return {
    base,
    home,
    ts: overlayTs,
    evidenceRoot: explicitEvidenceRoot,
    defaultEvidenceRoot,
    sessionCallCounter: join(base, 'session-calls.jsonl'),
    npxCounter: join(base, 'npx-calls.txt'),
    netCounter: join(base, 'net-attempts.jsonl'),
    timerPreload,
  }
}

interface RunOutcome {
  status: number | null
  stdout: string
  stderr: string
  overlay: Overlay
}

type RootMode = 'equals-relative' | 'split-absolute' | 'default'

function runRunner(overlay: Overlay, golden: string, script: string, rootMode: RootMode = 'split-absolute'): RunOutcome {
  const rootArgs = rootMode === 'equals-relative'
    ? [`--evidence-root=${relative(overlay.ts, overlay.evidenceRoot)}`]
    : rootMode === 'split-absolute'
      ? ['--evidence-root', overlay.evidenceRoot]
      : []
  const result = spawnSync(process.execPath, [
    join(overlay.ts, 'scripts', 'sf-live-benchmark.ts'),
    `--golden=${golden}`,
    ...rootArgs,
  ], {
    cwd: overlay.ts,
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      HOME: overlay.home,
      PATH: `${join(overlay.base, 'shim')}:${process.env.PATH ?? ''}`,
      NODE_OPTIONS: `--import=${join(overlay.base, 'net-trap.mjs')} --import=${overlay.timerPreload}`,
      GOTRY_SESSION_LIVE: '0',
      GOTRY_HBCLI_LIVE: '0',
      SF411_SCRIPT: script,
      SF411_CALL_COUNTER: overlay.sessionCallCounter,
      SF411_NPX_COUNTER: overlay.npxCounter,
      SF411_NET_COUNTER: overlay.netCounter,
    },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', overlay }
}

function readRecord(overlay: Overlay, queryId: string, evidenceRoot = overlay.evidenceRoot): Record<string, unknown> {
  const dir = join(evidenceRoot, queryId)
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  assert.equal(files.length, 1, `${queryId} 应恰有一个证据文件`)
  return JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as Record<string, unknown>
}

/** 跑 overlay 里的真 sf-summary,返回(stdout, 解析后的 summary JSON) */
function runSfSummary(overlay: Overlay, evidenceRoot = overlay.evidenceRoot): { status: number | null; stdout: string; summary: Record<string, unknown>; summaryPath: string } {
  const result = spawnSync(process.execPath, [
    join(overlay.ts, 'scripts', 'sf-summary.ts'),
    '--evidence-root', evidenceRoot,
  ], {
    cwd: overlay.ts,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, HOME: overlay.home, GOTRY_SESSION_LIVE: '0', GOTRY_HBCLI_LIVE: '0' },
  })
  const match = /summary: (.+\.json)/.exec(result.stdout ?? '')
  assert.notEqual(match, null, `sf-summary 应输出 summary 路径,stdout=${result.stdout}`)
  const summaryPath = match![1]!
  assert.equal(summaryPath.startsWith(`${join(evidenceRoot, 'sf-summary')}/`), true, 'sf-summary 输出必须落在传入 evidence root')
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, unknown>
  return { status: result.status, stdout: result.stdout ?? '', summary, summaryPath }
}

function assertZeroNetwork(overlay: Overlay): void {
  assert.deepEqual(readLines(overlay.netCounter), [], '零网络断言失败:fetch 陷阱被触发')
}

function assertBatchArtifacts(overlay: Overlay, evidenceRoot = overlay.evidenceRoot): { raw: Record<string, unknown>; stem: string } {
  const summaryDir = join(evidenceRoot, 'sf-summary')
  const summaryFiles = readdirSync(summaryDir).filter((name) => name.endsWith('.json'))
  assert.equal(summaryFiles.length, 1, `benchmark raw summary 应唯一,实际 ${summaryFiles.join(',')}`)
  const summaryFile = summaryFiles[0]!
  const stem = summaryFile.slice(0, -'.json'.length)
  const identity = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stem)
  assert.notEqual(identity, null, 'benchmark raw summary 必须使用 canonical run filename')
  const captureAt = `${identity![1]}:${identity![2]}:${identity![3]}.${identity![4]}Z`
  const raw = JSON.parse(readFileSync(join(summaryDir, summaryFile), 'utf8')) as Record<string, unknown>
  assert.equal(raw.started_at, captureAt, 'raw summary.started_at 必须与 canonical run filename 同一 run identity')
  const rawRecords = raw.records as Array<Record<string, unknown>>
  assert.equal(rawRecords.length, raw.total, 'raw summary total 必须与 records 一致')
  assert.deepEqual(rawRecords.map((record) => record.query_id), raw.attempted_query_ids, 'raw summary records 必须按 attempted 顺序落账')

  for (const queryId of raw.attempted_query_ids as string[]) {
    const queryDir = join(evidenceRoot, queryId)
    const files = readdirSync(queryDir).filter((name) => name.endsWith('.json'))
    assert.deepEqual(files, [summaryFile], `${queryId} 必须使用同一 canonical run stem`)
    const record = JSON.parse(readFileSync(join(queryDir, summaryFile), 'utf8')) as Record<string, unknown>
    const rawRecord = rawRecords.find((candidate) => candidate.query_id === queryId)
    assert.deepEqual(record, rawRecord, `${queryId} 文件必须与 raw summary.records 深相等`)
  }
  return { raw, stem }
}

function assertDefaultRootAbsent(overlay: Overlay): void {
  assert.equal(existsSync(overlay.defaultEvidenceRoot), false, '显式 root 场景不得写入 HOME 默认 evidence root')
}

function assertExplicitRootAbsent(overlay: Overlay): void {
  assert.equal(existsSync(overlay.evidenceRoot), false, '默认兼容场景不得创建显式 evidence root')
}

function assertRebuiltBatch(summary: Record<string, unknown>, raw: Record<string, unknown>, stem: string): void {
  const selected = summary.selected_batch as { batch_id: string; identity_source: string; record_count: number; query_ids: string[] }
  assert.equal(selected.batch_id, stem, 'sf-summary 必须回读 benchmark canonical filename batch')
  assert.equal(selected.identity_source, 'canonical_filename')
  assert.equal(selected.record_count, (raw.records as unknown[]).length)
  assert.deepEqual(selected.query_ids, (raw.records as Array<Record<string, unknown>>).map((record) => record.query_id))
  assert.equal((summary.records as Array<Record<string, unknown>>).length, selected.record_count)
  for (const record of summary.records as Array<Record<string, unknown>>) assert.equal(record.batch_id, stem)
}

function cleanupOverlay(overlay: Overlay): void {
  rmSync(overlay.base, { recursive: true, force: true })
  assert.equal(existsSync(overlay.base), false, 'overlay 必须在场景结束时清理')
}

function scenario(name: string): Overlay {
  const overlay = buildOverlay(name)
  console.log(`\n── scenario ${name} ──`)
  return overlay
}

// ── A. 首条 challenge:1 次调用即截断,语义保持 challenge_stop/no_spend_stop ──
{
  const overlay = scenario('first-challenge')
  try {
    const run = runRunner(overlay, 'flyai', 'challenge@all', 'equals-relative')
    assert.equal(run.status, 0, `挑战截断应正常收尾(exit 0),stderr=${run.stderr}`)
    assert.match(run.stdout, /stop reason: challenge_stop/)
    const artifacts = assertBatchArtifacts(overlay)
    assertDefaultRootAbsent(overlay)
    const sessionCalls = readLines(overlay.sessionCallCounter)
    assert.equal(sessionCalls.length, 1, `首条 challenged 后必须停止,期望 1 次 session 调用,实际 ${sessionCalls.length}`)
    const npxCalls = readLines(overlay.npxCounter)
    assert.equal(npxCalls.length, 1, `comparator 不得为未尝试 query 调用,期望 1 次,实际 ${npxCalls.length}`)
    assertZeroNetwork(overlay)

    const record = readRecord(overlay, 'sf-01') as {
      session: { verdict: string }
      sessionVerdict: string
      doubleSource: { state: string; quota_disposition: string }
    }
    assert.equal(record.session.verdict, 'challenged', 'challenged 结构化语义不得被改写成 error')
    assert.equal(record.sessionVerdict, 'challenged')
    assert.equal(record.doubleSource.state, 'challenge_stop')
    assert.equal(record.doubleSource.quota_disposition, 'no_spend_stop')

    const summary = artifacts.raw as {
      total: number
      batch_complete: boolean
      stop_reason: string
      attempted_query_ids: string[]
      not_attempted_query_ids: string[]
    }
    assert.equal(summary.total, 1)
    assert.equal(summary.batch_complete, false)
    assert.equal(summary.stop_reason, 'challenge_stop')
    assert.deepEqual(summary.attempted_query_ids, ['sf-01'])
    assert.deepEqual(summary.not_attempted_query_ids, IDS_AFTER_FIRST)

    // sf-summary:缺七条的批次绝不标完整/有效校准
    const sfSummary = runSfSummary(overlay)
    assert.equal(sfSummary.status, 1, '部分批次必须 fail_closed')
    assert.equal(sfSummary.summary.status, 'fail_closed')
    assert.equal(sfSummary.summary.challenge_stop_detected, true)
    assert.equal(sfSummary.summary.total, 1)
    assert.equal((sfSummary.summary.missing_query_ids as string[]).length, 7)
    assertRebuiltBatch(sfSummary.summary, artifacts.raw, artifacts.stem)
    assertDefaultRootAbsent(overlay)
    console.log('A. 首条 challenge 截断 OK(1 次调用/comparator 1 次/fail_closed/challenge_stop 语义保留)')
  } finally {
    cleanupOverlay(overlay)
  }
}

// ── B. 中途 challenge:首条 hit,第二条 challenged → 2 次调用后截断 ──
{
  const overlay = scenario('mid-challenge')
  try {
    const run = runRunner(overlay, 'flyai', 'challenge@2')
    assert.equal(run.status, 0, `挑战截断应正常收尾(exit 0),stderr=${run.stderr}`)
    assert.match(run.stdout, /stop reason: challenge_stop/)
    const artifacts = assertBatchArtifacts(overlay)
    assertDefaultRootAbsent(overlay)
    const sessionCalls = readLines(overlay.sessionCallCounter)
    assert.equal(sessionCalls.length, 2, `中途 challenged 后必须停止,期望 2 次 session 调用,实际 ${sessionCalls.length}`)
    const npxCalls = readLines(overlay.npxCounter)
    assert.equal(npxCalls.length, 2, `comparator 调用数须等于已尝试 query 数,期望 2 次,实际 ${npxCalls.length}`)
    assertZeroNetwork(overlay)

    const hitRecord = readRecord(overlay, 'sf-01') as { session: { verdict: string } }
    assert.equal(hitRecord.session.verdict, 'hit', '截断前已尝试的 query 证据不受影响')
    const challengedRecord = readRecord(overlay, 'sf-02') as {
      session: { verdict: string }
      doubleSource: { state: string; quota_disposition: string }
    }
    assert.equal(challengedRecord.session.verdict, 'challenged')
    assert.equal(challengedRecord.doubleSource.state, 'challenge_stop')
    assert.equal(challengedRecord.doubleSource.quota_disposition, 'no_spend_stop')
    assert.equal(existsSync(join(overlay.evidenceRoot, 'sf-03')), false, '未尝试 query 不得产生证据')

    const summary = artifacts.raw as {
      total: number
      batch_complete: boolean
      stop_reason: string
      attempted_query_ids: string[]
      not_attempted_query_ids: string[]
    }
    assert.equal(summary.total, 2)
    assert.equal(summary.batch_complete, false)
    assert.equal(summary.stop_reason, 'challenge_stop')
    assert.deepEqual(summary.attempted_query_ids, ['sf-01', 'sf-02'])
    assert.deepEqual(summary.not_attempted_query_ids, EXPECTED_QUERY_IDS.slice(2))
    const sfSummary = runSfSummary(overlay)
    assertRebuiltBatch(sfSummary.summary, artifacts.raw, artifacts.stem)
    assertDefaultRootAbsent(overlay)
    console.log('B. 中途 challenge 截断 OK(2 次调用;sf-01 hit 证据保留;sf-03 起零证据)')
  } finally {
    cleanupOverlay(overlay)
  }
}

// ── C. 末条 challenge:八条证据齐全,仍必须 batch_complete=false 且 summary fail_closed ──
{
  const overlay = scenario('last-challenge')
  try {
    const run = runRunner(overlay, 'flyai', 'challenge@8')
    assert.equal(run.status, 0, `末条挑战应正常收尾(exit 0),stderr=${run.stderr}`)
    assert.match(run.stdout, /stop reason: challenge_stop/)
    const artifacts = assertBatchArtifacts(overlay)
    assertDefaultRootAbsent(overlay)
    assert.match(run.stdout, /attempted=\[sf-01,sf-02,sf-03,sf-04,sf-05,sf-06,sf-07,sf-08\]/)
    assert.match(run.stdout, /not_attempted=\[\]/)
    assert.equal(readLines(overlay.sessionCallCounter).length, 8, '末条 challenged 后 session 应恰调用 8 次')
    assert.equal(readLines(overlay.npxCounter).length, 8, '末条 challenged 后 comparator 应恰调用 8 次')
    assertZeroNetwork(overlay)

    const challengedRecord = readRecord(overlay, 'sf-08') as {
      session: { verdict: string }
      sessionVerdict: string
      doubleSource: { state: string; quota_disposition: string }
    }
    assert.equal(challengedRecord.session.verdict, 'challenged')
    assert.equal(challengedRecord.sessionVerdict, 'challenged')
    assert.equal(challengedRecord.doubleSource.state, 'challenge_stop')
    assert.equal(challengedRecord.doubleSource.quota_disposition, 'no_spend_stop')

    const summary = artifacts.raw as {
      total: number
      batch_complete: boolean
      stop_reason: string
      attempted_query_ids: string[]
      not_attempted_query_ids: string[]
    }
    assert.equal(summary.total, 8)
    assert.equal(summary.batch_complete, false)
    assert.equal(summary.stop_reason, 'challenge_stop')
    assert.deepEqual(summary.attempted_query_ids, EXPECTED_QUERY_IDS)
    assert.deepEqual(summary.not_attempted_query_ids, [])

    const sfSummary = runSfSummary(overlay)
    assert.equal(sfSummary.status, 1, `完整证据但挑战批次必须 fail_closed,stdout=${sfSummary.stdout}`)
    assert.equal(sfSummary.summary.status, 'fail_closed')
    assert.equal(sfSummary.summary.total, 8)
    assert.deepEqual(sfSummary.summary.missing_query_ids, [])
    assert.equal(sfSummary.summary.challenge_stop_detected, true)
    assert.ok((sfSummary.summary.errors as string[]).some((error) => error.includes('challenge/guard stop evidence')))
    assertRebuiltBatch(sfSummary.summary, artifacts.raw, artifacts.stem)
    assertDefaultRootAbsent(overlay)
    console.log('C. 末条 challenge 截断 OK(8 条证据/0 未尝试/8+8 请求/fail_closed)')
  } finally {
    cleanupOverlay(overlay)
  }
}

// ── D. 普通八条批次:全 hit → 跑满,sf-summary 仍标完整/有效校准(既有契约) ──
{
  const overlay = scenario('normal-batch')
  try {
    const run = runRunner(overlay, 'manual', 'hit@all')
    assert.equal(run.status, 0, `普通批次应跑满,stderr=${run.stderr}`)
    assert.match(run.stdout, /stop reason: completed/)
    const artifacts = assertBatchArtifacts(overlay)
    assertDefaultRootAbsent(overlay)
    const sessionCalls = readLines(overlay.sessionCallCounter)
    assert.equal(sessionCalls.length, 8, `普通批次应完整跑 8 条,实际 ${sessionCalls.length}`)
    assert.equal(readLines(overlay.npxCounter).length, 0, 'manual golden 不经 comparator 进程')
    assertZeroNetwork(overlay)

    const summary = artifacts.raw as {
      total: number
      batch_complete: boolean
      stop_reason: string
      attempted_query_ids: string[]
      not_attempted_query_ids: string[]
    }
    assert.equal(summary.total, 8)
    assert.equal(summary.batch_complete, true)
    assert.equal(summary.stop_reason, 'completed')
    assert.deepEqual(summary.attempted_query_ids, EXPECTED_QUERY_IDS)
    assert.deepEqual(summary.not_attempted_query_ids, [])

    const sfSummary = runSfSummary(overlay)
    assert.equal(sfSummary.status, 0, `完整八条批次须保持 ok 契约,stdout=${sfSummary.stdout}`)
    assert.equal(sfSummary.summary.status, 'ok')
    assert.equal(sfSummary.summary.total, 8)
    assert.equal(sfSummary.summary.challenge_stop_detected, false)
    assertRebuiltBatch(sfSummary.summary, artifacts.raw, artifacts.stem)
    assertDefaultRootAbsent(overlay)
    console.log('D. 普通八条批次保留 OK(sf-summary 仍 ok/完整)')
  } finally {
    cleanupOverlay(overlay)
  }
}

// ── E. 默认目录兼容：仅允许写入隔离 HOME，不得触碰显式 root ──
{
  const overlay = scenario('default-root-compat')
  try {
    const run = runRunner(overlay, 'manual', 'hit@all', 'default')
    assert.equal(run.status, 0, `默认 root 批次应跑满,stderr=${run.stderr}`)
    assert.match(run.stdout, /stop reason: completed/)
    assert.equal(readLines(overlay.sessionCallCounter).length, 8, '默认路径保持完整八条查询')
    assert.equal(readLines(overlay.npxCounter).length, 0, 'manual golden 不调用外部 comparator')
    assertZeroNetwork(overlay)
    const artifacts = assertBatchArtifacts(overlay, overlay.defaultEvidenceRoot)
    assert.equal(existsSync(overlay.defaultEvidenceRoot), true)
    assertExplicitRootAbsent(overlay)

    const sfSummary = runSfSummary(overlay, overlay.defaultEvidenceRoot)
    assert.equal(sfSummary.status, 0, `默认 root summary 应保持 ok,stdout=${sfSummary.stdout}`)
    assert.equal(sfSummary.summary.status, 'ok')
    assertRebuiltBatch(sfSummary.summary, artifacts.raw, artifacts.stem)
    assertExplicitRootAbsent(overlay)
    console.log('E. 默认 root 兼容 OK(仅临时 HOME/显式 root 未创建)')
  } finally {
    cleanupOverlay(overlay)
  }
}

console.log('\nSF LIVE CHALLENGE STOP TESTS: 5 scenarios OK (first-challenge / mid-challenge / last-challenge / normal-batch / default-root-compat; offline, explicit roots, request counts and summary readback asserted)')
