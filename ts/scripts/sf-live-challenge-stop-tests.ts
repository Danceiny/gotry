/**
 * sf live benchmark 挑战截断离线 E2E(issue #411,RFC §3.5 挑战红线)。
 *
 * 真实 CLI 路径:spawn 真 runner(scripts/sf-live-benchmark.ts,经 tsx),只在 /tmp
 * overlay 副本里把 capabilities/session-search.ts 替换为脚本化确定性响应——
 *   challenge@all  首条即 challenged → 期望整批在 1 次调用后截断;
 *   challenge@2    首条 hit、第二条 challenged → 期望 2 次调用后截断;
 *   hit@all        普通 8 条批次 → 期望跑满且 sf-summary 仍标完整/有效校准。
 * comparator(flyai CLI)经 PATH shim(npx 即败 + 计数)证明「停止后不再调用」;
 * globalThis.fetch 陷阱兜底断言零网络。HOME/evidence root 全部临时,零真实
 * 网站/浏览器/供应商请求,不触碰共享 founder state。
 *
 * 同时断言:challenged 的结构化语义(session.verdict / doubleSource=challenge_stop /
 * no_spend_stop)不被改写;部分批次落盘 stop_reason + attempted/not_attempted 清单;
 * sf-summary 对缺七条的批次 status=fail_closed(不标完整/有效校准)。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  const evidenceRoot = join(home, '.gotry', 'evidence', 'session')
  mkdirSync(home, { recursive: true })
  for (const entry of ['scripts', 'capabilities', 'data'] as const) {
    cpSync(join(REAL_TS, entry), join(overlayTs, entry), { recursive: true })
  }
  cpSync(join(REAL_TS, 'package.json'), join(overlayTs, 'package.json'))
  cpSync(join(REAL_TS, 'tsconfig.json'), join(overlayTs, 'tsconfig.json'))
  symlinkSync(join(REAL_TS, 'node_modules'), join(overlayTs, 'node_modules'), 'dir')

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
  writeFileSync(timerPreload, `globalThis.setTimeout = (callback, _delay, ...args) => { callback(...args); return 0 }\n`)

  return {
    base,
    home,
    ts: overlayTs,
    evidenceRoot,
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

function runRunner(overlay: Overlay, golden: string, script: string): RunOutcome {
  const result = spawnSync(process.execPath, [
    join(overlay.ts, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(overlay.ts, 'scripts', 'sf-live-benchmark.ts'),
    `--golden=${golden}`,
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

function readRunSummary(overlay: Overlay): Record<string, unknown> {
  const dir = join(overlay.evidenceRoot, 'sf-summary')
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  assert.equal(files.length, 1, `runner 应落盘唯一 run summary,实际 ${files.join(',')}`)
  return JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as Record<string, unknown>
}

function readRecord(overlay: Overlay, queryId: string): Record<string, unknown> {
  const dir = join(overlay.evidenceRoot, queryId)
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  assert.equal(files.length, 1, `${queryId} 应恰有一个证据文件`)
  return JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) as Record<string, unknown>
}

/** 跑 overlay 里的真 sf-summary,返回(stdout, 解析后的 summary JSON) */
function runSfSummary(overlay: Overlay): { status: number | null; stdout: string; summary: Record<string, unknown> } {
  const result = spawnSync(process.execPath, [
    join(overlay.ts, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(overlay.ts, 'scripts', 'sf-summary.ts'),
    '--evidence-root', overlay.evidenceRoot,
  ], {
    cwd: overlay.ts,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, HOME: overlay.home, GOTRY_SESSION_LIVE: '0', GOTRY_HBCLI_LIVE: '0' },
  })
  const match = /summary: (.+\.json)/.exec(result.stdout ?? '')
  assert.notEqual(match, null, `sf-summary 应输出 summary 路径,stdout=${result.stdout}`)
  const summary = JSON.parse(readFileSync(match![1]!, 'utf8')) as Record<string, unknown>
  return { status: result.status, stdout: result.stdout ?? '', summary }
}

function assertZeroNetwork(overlay: Overlay): void {
  assert.deepEqual(readLines(overlay.netCounter), [], '零网络断言失败:fetch 陷阱被触发')
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
    const run = runRunner(overlay, 'flyai', 'challenge@all')
    assert.equal(run.status, 0, `挑战截断应正常收尾(exit 0),stderr=${run.stderr}`)
    assert.match(run.stdout, /stop reason: challenge_stop/)
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

    const summary = readRunSummary(overlay) as {
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
    console.log('A. 首条 challenge 截断 OK(1 次调用/comparator 1 次/fail_closed/challenge_stop 语义保留)')
  } finally {
    rmSync(overlay.base, { recursive: true, force: true })
  }
}

// ── B. 中途 challenge:首条 hit,第二条 challenged → 2 次调用后截断 ──
{
  const overlay = scenario('mid-challenge')
  try {
    const run = runRunner(overlay, 'flyai', 'challenge@2')
    assert.equal(run.status, 0, `挑战截断应正常收尾(exit 0),stderr=${run.stderr}`)
    assert.match(run.stdout, /stop reason: challenge_stop/)
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

    const summary = readRunSummary(overlay) as {
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
    console.log('B. 中途 challenge 截断 OK(2 次调用;sf-01 hit 证据保留;sf-03 起零证据)')
  } finally {
    rmSync(overlay.base, { recursive: true, force: true })
  }
}

// ── C. 普通八条批次:全 hit → 跑满,sf-summary 仍标完整/有效校准(既有契约) ──
{
  const overlay = scenario('normal-batch')
  try {
    const run = runRunner(overlay, 'manual', 'hit@all')
    assert.equal(run.status, 0, `普通批次应跑满,stderr=${run.stderr}`)
    assert.match(run.stdout, /stop reason: completed/)
    const sessionCalls = readLines(overlay.sessionCallCounter)
    assert.equal(sessionCalls.length, 8, `普通批次应完整跑 8 条,实际 ${sessionCalls.length}`)
    assert.equal(readLines(overlay.npxCounter).length, 0, 'manual golden 不经 comparator 进程')
    assertZeroNetwork(overlay)

    const summary = readRunSummary(overlay) as {
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
    console.log('C. 普通八条批次保留 OK(sf-summary 仍 ok/完整)')
  } finally {
    rmSync(overlay.base, { recursive: true, force: true })
  }
}

console.log('\nSF LIVE CHALLENGE STOP TESTS: 3 scenarios OK (first-challenge / mid-challenge / normal-batch; offline, temp roots, request counts asserted)')
