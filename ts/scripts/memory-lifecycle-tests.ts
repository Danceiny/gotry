/**
 * M4 planning lifecycle collector tests(issue #228):显式 opt-in、HMAC 脱敏、等待边界、
 * source_review candidate/synthetic 导出、子进程采集→scorer 链。
 * 运行:cd ts && npx tsx scripts/memory-lifecycle-tests.ts
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  buildMemoryValueFixture,
  completeMemoryLifecycleFlow,
  endExternalWait,
  exportMemoryLifecycleFixture,
  fileMode,
  HMAC_REF_PATTERN,
  initMemoryLifecycleDataset,
  MemoryLifecycleError,
  memoryValueSummaryDigest,
  pseudonymousRef,
  readStoreForTests,
  startExternalWait,
  startMemoryLifecycleFlow,
  storeRootForStateRoot,
  type Clock,
  type MemoryLifecycleEvent,
  type MemoryLifecycleManifest,
} from '../src/memory-lifecycle.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TS_ROOT = resolve(__dirname, '..')
const TSX = join(TS_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
const MODULE_URL = pathToFileURL(join(TS_ROOT, 'src', 'memory-lifecycle.ts')).href
const KEY = '0123456789abcdef0123456789abcdef'
const OTHER_KEY = 'abcdef0123456789abcdef0123456789'
const CONSENT = 'operator-consent-for-issue-228'
const SENTINEL = 'PRIVACY_SENTINEL_228@example.com'

let n = 0
async function pass(name: string, body: () => void | Promise<void>): Promise<void> {
  await body()
  console.log(`  ${++n}. ${name} OK`)
}

interface CliRunOptions {
  key?: string
  extraEnv?: Record<string, string | undefined>
}

function runCli(args: string[], options: CliRunOptions = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.extraEnv }
  if (options.key === undefined) delete env.GOTRY_MEMORY_LIFECYCLE_HMAC_KEY
  else env.GOTRY_MEMORY_LIFECYCLE_HMAC_KEY = options.key
  return spawnSync(TSX, ['scripts/memory-lifecycle.ts', ...args], {
    cwd: TS_ROOT,
    env,
    encoding: 'utf8',
  })
}

function runScorer(inputPath: string) {
  return spawnSync(TSX, ['scripts/memory-value-report.ts', inputPath], {
    cwd: TS_ROOT,
    encoding: 'utf8',
  })
}

function common(root: string): string[] {
  return ['--state-root', root, '--consent', CONSENT]
}

function initArgs(root: string, source = 'synthetic_fixture'): string[] {
  return [...common(root), '--source', source, '--dataset', `dataset-${source}`, '--wait-code', 'tool_latency', '--wait-code', 'user_pause']
}

function jsonStdout<T = any>(run: ReturnType<typeof runCli>): T {
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout) as T
}

function assertCliError(run: ReturnType<typeof runCli>, code: string): void {
  assert.equal(run.status, 2)
  assert.equal(run.stdout, '')
  assert.equal(run.stderr.trim(), `memory_lifecycle_error:${code}`)
}

function assertNoLeak(text: string): void {
  assert.equal(text.includes(SENTINEL), false, 'privacy sentinel leaked')
  assert.equal(text.includes(KEY), false, 'HMAC key leaked')
}

function allFileText(root: string): string {
  const parts: string[] = []
  function walk(path: string): void {
    if (!existsSync(path)) return
    for (const name of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, name.name)
      if (name.isDirectory()) walk(child)
      else parts.push(readFileSync(child, 'utf8'))
    }
  }
  walk(root)
  return parts.join('\n')
}

function eventCount(root: string): number {
  return readStoreForTests(root).events.length
}

function eventLogPath(root: string): string {
  return join(storeRootForStateRoot(root), 'events.jsonl')
}

function eventLogBytes(root: string): Buffer {
  const path = eventLogPath(root)
  return existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
}

function assertMemoryError(body: () => unknown, code: string): void {
  assert.throws(body, (error) => error instanceof MemoryLifecycleError && error.code === code)
}

function fixed(iso: string): Clock {
  return { now: () => new Date(iso) }
}

function runFaultScript(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'gotry-memory-lifecycle-fault-script-'))
  const script = join(root, 'fault.mts')
  writeFileSync(script, source)
  const run = spawnSync(TSX, [script], { cwd: TS_ROOT, encoding: 'utf8' })
  rmSync(root, { recursive: true, force: true })
  return run
}

await pass('纯函数:引用均为 HMAC,source_review digest 排除 source_review 自身', () => {
  const subject = pseudonymousRef(KEY, 'subject', [SENTINEL])
  assert.match(subject, HMAC_REF_PATTERN)
  assertNoLeak(subject)
  const digestA = memoryValueSummaryDigest({ b: 1, a: 2, source_review: { reviewed_summary_digest_sha256: 'x' } })
  const digestB = memoryValueSummaryDigest({ a: 2, b: 1, source_review: { reviewed_summary_digest_sha256: 'y' } })
  assert.equal(digestA, digestB)

  const manifest: MemoryLifecycleManifest = {
    schema_version: 'memory_lifecycle_manifest.v1',
    collector_schema: 'memory_lifecycle_observations.v1',
    dataset_ref: pseudonymousRef(KEY, 'dataset', ['pure-fixture']),
    dataset_key_verifier: pseudonymousRef(KEY, 'dataset-key-verifier', ['memory_lifecycle_observations.v1']),
    source_kind: 'observed_private',
    created_at: '2026-09-08T00:00:00.000Z',
    consent_ref: pseudonymousRef(KEY, 'consent', [CONSENT]),
    measurement_policy: {
      quantile_method: 'nearest_rank',
      predeclared_external_wait_codes: ['tool_latency'],
      minimum_pair_count_for_exit: 5,
      target_median_reduction_ratio: 0.5,
    },
    p4: { state: 'closed', triggers: { real_usage: false, multi_user: false } },
  }
  const flowA = pseudonymousRef(KEY, 'flow', [subject, 'first'])
  const flowB = pseudonymousRef(KEY, 'flow', [subject, 'returning'])
  const events: MemoryLifecycleEvent[] = [
    {
      schema_version: 'memory_lifecycle_event.v1',
      event_ref: pseudonymousRef(KEY, 'event:flow_started', [subject, flowA]),
      kind: 'flow_started',
      occurred_at: '2026-09-08T00:00:00.000Z',
      consent_ref: manifest.consent_ref,
      subject_ref: subject,
      flow_ref: flowA,
      eligible: true,
    },
    {
      schema_version: 'memory_lifecycle_event.v1',
      event_ref: pseudonymousRef(KEY, 'event:flow_completed', [subject, flowA]),
      kind: 'flow_completed',
      occurred_at: '2026-09-08T00:10:00.000Z',
      consent_ref: manifest.consent_ref,
      subject_ref: subject,
      flow_ref: flowA,
      status: 'completed',
    },
    {
      schema_version: 'memory_lifecycle_event.v1',
      event_ref: pseudonymousRef(KEY, 'event:flow_started', [subject, flowB]),
      kind: 'flow_started',
      occurred_at: '2026-09-09T00:00:00.000Z',
      consent_ref: manifest.consent_ref,
      subject_ref: subject,
      flow_ref: flowB,
      eligible: true,
    },
    {
      schema_version: 'memory_lifecycle_event.v1',
      event_ref: pseudonymousRef(KEY, 'event:flow_completed', [subject, flowB]),
      kind: 'flow_completed',
      occurred_at: '2026-09-09T00:04:00.000Z',
      consent_ref: manifest.consent_ref,
      subject_ref: subject,
      flow_ref: flowB,
      status: 'completed',
    },
  ]
  const fixture = buildMemoryValueFixture(manifest, events, KEY)
  assert.equal(fixture.source_review.state, 'candidate')
  assert.equal(fixture.source_review.reviewed_summary_digest_sha256, memoryValueSummaryDigest(fixture))
  assert.notEqual(fixture.source_review.state, 'manual_attested')
})

await pass('opt-in off/无 key/坏输入:退出 2 且不建采集文件', () => {
  for (const scenario of ['no-key', 'no-consent', 'bad-input'] as const) {
    const root = mkdtempSync(join(tmpdir(), `gotry-memory-lifecycle-${scenario}-`))
    const args = scenario === 'no-consent'
      ? ['init', '--state-root', root, '--source', 'synthetic_fixture', '--dataset', SENTINEL, '--wait-code', 'tool_latency']
      : ['init', ...initArgs(root), ...(scenario === 'bad-input' ? ['--wait-code', `bad-${SENTINEL}`] : [])]
    const run = runCli(args, { key: scenario === 'no-key' ? undefined : KEY })
    assertCliError(run, scenario === 'no-key' ? 'missing_hmac_key' : scenario === 'no-consent' ? 'missing_consent' : 'invalid_input')
    assertNoLeak(run.stdout + run.stderr)
    assert.deepEqual(readdirSync(root), [])
    rmSync(root, { recursive: true, force: true })
  }
})

await pass('子进程 E2E:采集→脱敏→导出→scorer 链,重复操作不增计数', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gotry-memory-lifecycle-e2e-'))
  const out = join(root, 'export.json')
  jsonStdout(runCli(['init', ...initArgs(root)], { key: KEY }))
  jsonStdout(runCli(['start', ...common(root), '--subject', SENTINEL, '--flow', 'first-planning', '--eligible-planning'], { key: KEY }))
  jsonStdout(runCli(['start', ...common(root), '--subject', SENTINEL, '--flow', 'first-planning', '--eligible-planning'], { key: KEY }))
  await delay(8)
  jsonStdout(runCli(['wait-start', ...common(root), '--subject', SENTINEL, '--flow', 'first-planning', '--wait', 'w1', '--code', 'tool_latency'], { key: KEY }))
  await delay(8)
  jsonStdout(runCli(['wait-end', ...common(root), '--subject', SENTINEL, '--flow', 'first-planning', '--wait', 'w1'], { key: KEY }))
  await delay(8)
  jsonStdout(runCli(['complete', ...common(root), '--subject', SENTINEL, '--flow', 'first-planning'], { key: KEY }))
  jsonStdout(runCli(['complete', ...common(root), '--subject', SENTINEL, '--flow', 'first-planning'], { key: KEY }))
  await delay(8)
  jsonStdout(runCli(['start', ...common(root), '--subject', SENTINEL, '--flow', 'returning-planning', '--eligible-planning'], { key: KEY }))
  await delay(8)
  jsonStdout(runCli(['complete', ...common(root), '--subject', SENTINEL, '--flow', 'returning-planning'], { key: KEY }))
  jsonStdout(runCli(['record-reflux', ...common(root), '--experience', 'dali-erhai-reflux', '--kind', 'recalled', '--evidence', `${SENTINEL}:recalled`], { key: KEY }))
  jsonStdout(runCli(['record-reflux', ...common(root), '--experience', 'dali-erhai-reflux', '--kind', 'verified_outcome', '--evidence', `${SENTINEL}:verified`], { key: KEY }))
  jsonStdout(runCli(['record-preference', ...common(root), '--assertion', 'likes-slower-pace', '--evidence', `${SENTINEL}:preference-source`, '--consumer', 'ranking'], { key: KEY }))
  jsonStdout(runCli(['record-preference', ...common(root), '--assertion', 'likes-waterfront', '--evidence', `${SENTINEL}:preference-source`, '--consumer', 'explanation'], { key: KEY }))

  assert.equal(eventCount(root), 10)
  const exportResult = jsonStdout<{ output_written: boolean; pair_count: number }>(runCli(['export', ...common(root), '--out', out], { key: KEY }))
  assert.equal(exportResult.output_written, true)
  assert.equal(exportResult.pair_count, 1)
  assert.equal(fileMode(out), 0o600)
  const fixture = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(fixture.schema, 'memory_value_fixture.v1')
  assert.equal(fixture.evidence_kind, 'synthetic_fixture')
  assert.equal(fixture.source_review.state, 'not_required_for_synthetic')
  assert.equal(fixture.pairs.length, 1)
  assert.match(fixture.pairs[0].pair_id, HMAC_REF_PATTERN)
  assert.match(fixture.pairs[0].subject_ref, HMAC_REF_PATTERN)
  assert.match(fixture.pairs[0].first.flow_id, HMAC_REF_PATTERN)
  assert.equal(fixture.pairs[0].first.external_waits[0].code, 'tool_latency')
  assert.equal(fixture.preference_assertions.length, 2)
  assert.equal(fixture.preference_assertions[0].evidence_ref, fixture.preference_assertions[1].evidence_ref)
  assertNoLeak(JSON.stringify(fixture) + allFileText(root))

  const scorer = runScorer(out)
  assert.equal(scorer.status, 0, `${scorer.stderr}\n${scorer.stdout}`)
  const report = JSON.parse(scorer.stdout)
  assert.equal(report.contract_valid, true)
  assert.equal(report.cohort.eligible_pair_count, 1)
  assert.equal(report.cohort.sample_size_met, false)
  assert.equal(report.exit_ready, false)

  const overwrite = runCli(['export', ...common(root), '--out', out], { key: KEY })
  assertCliError(overwrite, 'output_exists')
  assertNoLeak(overwrite.stdout + overwrite.stderr)
  rmSync(root, { recursive: true, force: true })
})

await pass('负例:重叠/倒序/开放等待/第三条 eligible flow/来源提升均被拒', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gotry-memory-lifecycle-negative-'))
  jsonStdout(runCli(['init', ...initArgs(root)], { key: KEY }))
  jsonStdout(runCli(['start', ...common(root), '--subject', 'subject-a', '--flow', 'first', '--eligible-planning'], { key: KEY }))
  const beforeOverlap = eventCount(root)
  assertCliError(runCli(['start', ...common(root), '--subject', 'subject-a', '--flow', 'overlap', '--eligible-planning'], { key: KEY }), 'invalid_transition')
  assert.equal(eventCount(root), beforeOverlap)
  assertCliError(runCli(['wait-start', ...common(root), '--subject', 'subject-a', '--flow', 'first', '--wait', 'bad', '--code', 'undeclared_wait'], { key: KEY }), 'invalid_input')
  await delay(6)
  jsonStdout(runCli(['wait-start', ...common(root), '--subject', 'subject-a', '--flow', 'first', '--wait', 'w1', '--code', 'user_pause'], { key: KEY }))
  assertCliError(runCli(['complete', ...common(root), '--subject', 'subject-a', '--flow', 'first'], { key: KEY }), 'invalid_transition')
  await delay(6)
  jsonStdout(runCli(['wait-end', ...common(root), '--subject', 'subject-a', '--flow', 'first', '--wait', 'w1'], { key: KEY }))
  await delay(6)
  jsonStdout(runCli(['complete', ...common(root), '--subject', 'subject-a', '--flow', 'first'], { key: KEY }))
  assertCliError(runCli(['wait-start', ...common(root), '--subject', 'subject-a', '--flow', 'first', '--wait', 'after-terminal', '--code', 'user_pause'], { key: KEY }), 'invalid_transition')
  await delay(6)
  jsonStdout(runCli(['start', ...common(root), '--subject', 'subject-a', '--flow', 'returning', '--eligible-planning'], { key: KEY }))
  await delay(6)
  jsonStdout(runCli(['complete', ...common(root), '--subject', 'subject-a', '--flow', 'returning'], { key: KEY }))
  assertCliError(runCli(['start', ...common(root), '--subject', 'subject-a', '--flow', 'third', '--eligible-planning'], { key: KEY }), 'flow_limit_reached')
  assertCliError(runCli(['init', ...initArgs(root, 'observed_private')], { key: KEY }), 'dataset_source_mismatch')
  assert.equal(readStoreForTests(root).manifest.source_kind, 'synthetic_fixture')
  rmSync(root, { recursive: true, force: true })
})

await pass('HMAC key 绑定数据集:换 key 拒绝且不改 pair_id/事件文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'gotry-memory-lifecycle-key-'))
  initMemoryLifecycleDataset({ stateRoot: root, consent: CONSENT, hmacKey: KEY, sourceKind: 'synthetic_fixture', dataset: 'key-dataset', waitCodes: ['tool_latency'] }, fixed('2026-09-08T00:00:00.000Z'))
  startMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'subject-key', flow: 'first' }, fixed('2026-09-08T00:00:01.000Z'))
  completeMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'subject-key', flow: 'first' }, fixed('2026-09-08T00:00:10.000Z'))
  startMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'subject-key', flow: 'returning' }, fixed('2026-09-08T00:00:11.000Z'))
  completeMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'subject-key', flow: 'returning' }, fixed('2026-09-08T00:00:20.000Z'))
  const before = eventLogBytes(root)
  const firstExport = exportMemoryLifecycleFixture({ stateRoot: root, consent: CONSENT, hmacKey: KEY }).fixture
  const pairId = firstExport.pairs[0]?.pair_id
  assert.match(pairId!, HMAC_REF_PATTERN)

  assertMemoryError(() => exportMemoryLifecycleFixture({ stateRoot: root, consent: CONSENT, hmacKey: OTHER_KEY }), 'dataset_key_mismatch')
  assertMemoryError(() => startMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: OTHER_KEY, subject: 'subject-key', flow: 'wrong-key-flow' }, fixed('2026-09-08T00:00:21.000Z')), 'dataset_key_mismatch')
  assertMemoryError(() => initMemoryLifecycleDataset({ stateRoot: root, consent: CONSENT, hmacKey: OTHER_KEY, sourceKind: 'synthetic_fixture', dataset: 'key-dataset', waitCodes: ['tool_latency'] }, fixed('2026-09-08T00:00:22.000Z')), 'dataset_key_mismatch')
  assert.deepEqual(eventLogBytes(root), before)
  assert.equal(exportMemoryLifecycleFixture({ stateRoot: root, consent: CONSENT, hmacKey: KEY }).fixture.pairs[0]?.pair_id, pairId)
  assertNoLeak(readFileSync(join(storeRootForStateRoot(root), 'manifest.json'), 'utf8'))
  rmSync(root, { recursive: true, force: true })
})

await pass('写前完整时间投影:倒序 complete/return/wait 均拒绝且事件文件不变', () => {
  const rootA = mkdtempSync(join(tmpdir(), 'gotry-memory-lifecycle-time-complete-'))
  initMemoryLifecycleDataset({ stateRoot: rootA, consent: CONSENT, hmacKey: KEY, sourceKind: 'synthetic_fixture', dataset: 'time-a', waitCodes: ['tool_latency'] }, fixed('2026-09-08T00:00:00.000Z'))
  startMemoryLifecycleFlow({ stateRoot: rootA, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'first' }, fixed('2026-09-08T00:00:01.000Z'))
  startExternalWait({ stateRoot: rootA, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'first', wait: 'w1', code: 'tool_latency' }, fixed('2026-09-08T00:00:02.000Z'))
  endExternalWait({ stateRoot: rootA, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'first', wait: 'w1' }, fixed('2026-09-08T00:00:10.000Z'))
  const beforeComplete = eventLogBytes(rootA)
  assertMemoryError(() => completeMemoryLifecycleFlow({ stateRoot: rootA, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'first' }, fixed('2026-09-08T00:00:05.000Z')), 'invalid_transition')
  assert.deepEqual(eventLogBytes(rootA), beforeComplete)
  completeMemoryLifecycleFlow({ stateRoot: rootA, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'first' }, fixed('2026-09-08T00:00:11.000Z'))
  rmSync(rootA, { recursive: true, force: true })

  const rootB = mkdtempSync(join(tmpdir(), 'gotry-memory-lifecycle-time-return-'))
  initMemoryLifecycleDataset({ stateRoot: rootB, consent: CONSENT, hmacKey: KEY, sourceKind: 'synthetic_fixture', dataset: 'time-b', waitCodes: ['tool_latency'] }, fixed('2026-09-08T00:00:00.000Z'))
  startMemoryLifecycleFlow({ stateRoot: rootB, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'first' }, fixed('2026-09-08T00:00:01.000Z'))
  completeMemoryLifecycleFlow({ stateRoot: rootB, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'first' }, fixed('2026-09-08T00:00:10.000Z'))
  const beforeReturn = eventLogBytes(rootB)
  assertMemoryError(() => startMemoryLifecycleFlow({ stateRoot: rootB, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'returning' }, fixed('2026-09-08T00:00:05.000Z')), 'invalid_transition')
  assert.deepEqual(eventLogBytes(rootB), beforeReturn)
  startMemoryLifecycleFlow({ stateRoot: rootB, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'returning' }, fixed('2026-09-08T00:00:11.000Z'))
  completeMemoryLifecycleFlow({ stateRoot: rootB, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'returning' }, fixed('2026-09-08T00:00:12.000Z'))
  assert.equal(exportMemoryLifecycleFixture({ stateRoot: rootB, consent: CONSENT, hmacKey: KEY }).fixture.pairs.length, 1)
  rmSync(rootB, { recursive: true, force: true })

  const rootC = mkdtempSync(join(tmpdir(), 'gotry-memory-lifecycle-time-wait-'))
  initMemoryLifecycleDataset({ stateRoot: rootC, consent: CONSENT, hmacKey: KEY, sourceKind: 'synthetic_fixture', dataset: 'time-c', waitCodes: ['tool_latency'] }, fixed('2026-09-08T00:00:00.000Z'))
  startMemoryLifecycleFlow({ stateRoot: rootC, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'first' }, fixed('2026-09-08T00:00:01.000Z'))
  startExternalWait({ stateRoot: rootC, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'first', wait: 'w1', code: 'tool_latency' }, fixed('2026-09-08T00:00:02.000Z'))
  endExternalWait({ stateRoot: rootC, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'first', wait: 'w1' }, fixed('2026-09-08T00:00:08.000Z'))
  const beforeWait = eventLogBytes(rootC)
  assertMemoryError(() => startExternalWait({ stateRoot: rootC, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'first', wait: 'w2', code: 'tool_latency' }, fixed('2026-09-08T00:00:05.000Z')), 'invalid_transition')
  assert.deepEqual(eventLogBytes(rootC), beforeWait)
  startExternalWait({ stateRoot: rootC, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'first', wait: 'w2', code: 'tool_latency' }, fixed('2026-09-08T00:00:08.000Z'))
  endExternalWait({ stateRoot: rootC, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'first', wait: 'w2' }, fixed('2026-09-08T00:00:09.000Z'))
  completeMemoryLifecycleFlow({ stateRoot: rootC, consent: CONSENT, hmacKey: KEY, subject: 'subject-time', flow: 'first' }, fixed('2026-09-08T00:00:10.000Z'))
  rmSync(rootC, { recursive: true, force: true })
})

await pass('stateRoot realpath/子路径符号链接隔离:模拟 dsh-runtime alias 与 store symlink 均拒绝', () => {
  const temp = mkdtempSync(join(tmpdir(), 'gotry-memory-lifecycle-symlink-'))
  const simulatedRuntime = join(temp, 'simulated', 'ts', 'dsh-runtime')
  mkdirSync(simulatedRuntime, { recursive: true })
  const alias = join(temp, 'safe-looking-alias')
  symlinkSync(simulatedRuntime, alias)
  assertCliError(runCli(['init', ...initArgs(simulatedRuntime)], { key: KEY }), 'unsafe_state_root')
  assertCliError(runCli(['init', ...initArgs(alias)], { key: KEY }), 'unsafe_state_root')
  assert.equal(existsSync(join(simulatedRuntime, 'gotry-state')), false)

  const root = join(temp, 'root')
  const external = join(temp, 'external-store')
  mkdirSync(root, { recursive: true })
  mkdirSync(external, { recursive: true })
  symlinkSync(external, join(root, 'gotry-state'))
  assertCliError(runCli(['init', ...initArgs(root)], { key: KEY }), 'unsafe_state_root')
  assert.deepEqual(readdirSync(external), [])

  const safeRoot = join(temp, 'safe-root')
  const protectedRuntime = join(temp, 'protected', 'ts', 'dsh-runtime')
  mkdirSync(protectedRuntime, { recursive: true })
  jsonStdout(runCli(['init', ...initArgs(safeRoot)], { key: KEY }))
  const outsideEvents = join(protectedRuntime, 'outside-events.jsonl')
  writeFileSync(outsideEvents, '')
  symlinkSync(outsideEvents, eventLogPath(safeRoot))
  assertCliError(runCli(['start', ...common(safeRoot), '--subject', 'symlink-subject', '--flow', 'first', '--eligible-planning'], { key: KEY }), 'unsafe_state_root')
  assert.equal(readFileSync(outsideEvents, 'utf8'), '')
  unlinkSync(eventLogPath(safeRoot))

  const outputAlias = join(temp, 'output-alias')
  symlinkSync(protectedRuntime, outputAlias)
  assertCliError(runCli(['export', ...common(safeRoot), '--out', join(outputAlias, 'new-export.json')], { key: KEY }), 'unsafe_state_root')
  assert.equal(existsSync(join(protectedRuntime, 'new-export.json')), false)
  rmSync(temp, { recursive: true, force: true })
})

await pass('短写由 write-all 补齐;零字节写拒绝且旧前缀不变', () => {
  const run = runFaultScript(`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import os from 'node:os'
    import path from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const KEY = ${JSON.stringify(KEY)}
    const CONSENT = ${JSON.stringify(CONSENT)}
    const originalWriteSync = fs.writeSync
    function requestedText(data, args) {
      if (Buffer.isBuffer(data)) {
        const offset = args[0] ?? 0
        const length = args[1] ?? data.length - offset
        return data.subarray(offset, offset + length).toString('utf8')
      }
      return String(data)
    }
    function shortWrite(fd, data, args) {
      if (Buffer.isBuffer(data)) {
        const offset = args[0] ?? 0
        const length = args[1] ?? data.length - offset
        const slice = data.subarray(offset, offset + Math.max(0, length - 1))
        return originalWriteSync.call(fs, fd, slice, 0, slice.length)
      }
      return originalWriteSync.call(fs, fd, String(data).slice(0, -1))
    }
    let shortComplete = true
    let zeroComplete = false
    fs.writeSync = function patchedWriteSync(fd, data, ...args) {
      const text = requestedText(data, args)
      if (shortComplete && text.includes('"kind":"flow_completed"')) {
        shortComplete = false
        return shortWrite(fd, data, args)
      }
      if (zeroComplete && text.includes('"kind":"flow_completed"')) {
        zeroComplete = false
        return 0
      }
      return originalWriteSync.call(this, fd, data, ...args)
    }
    syncBuiltinESMExports()
    const mod = await import(${JSON.stringify(MODULE_URL)})
    const clock = iso => ({ now: () => new Date(iso) })
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gotry-memory-lifecycle-short-write-'))
    try {
      mod.initMemoryLifecycleDataset({ stateRoot: root, consent: CONSENT, hmacKey: KEY, sourceKind: 'synthetic_fixture', dataset: 'short-write', waitCodes: ['tool_latency'] }, clock('2026-09-08T00:00:00.000Z'))
      mod.startMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'short-subject', flow: 'first' }, clock('2026-09-08T00:00:01.000Z'))
      const logPath = path.join(mod.storeRootForStateRoot(root), 'events.jsonl')
      const beforeComplete = fs.readFileSync(logPath)
      const complete = mod.completeMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'short-subject', flow: 'first' }, clock('2026-09-08T00:00:02.000Z'))
      assert.equal(complete.status, 'recorded')
      assert.equal(fs.readFileSync(logPath, 'utf8').endsWith('\\n'), true)
      const replay = mod.completeMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'short-subject', flow: 'first' }, clock('2026-09-08T00:00:03.000Z'))
      assert.equal(replay.status, 'unchanged')
      assert.equal(mod.readStoreForTests(root).events.length, 2)

      const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gotry-memory-lifecycle-zero-write-'))
      try {
        mod.initMemoryLifecycleDataset({ stateRoot: root2, consent: CONSENT, hmacKey: KEY, sourceKind: 'synthetic_fixture', dataset: 'zero-write', waitCodes: ['tool_latency'] }, clock('2026-09-08T00:00:00.000Z'))
        mod.startMemoryLifecycleFlow({ stateRoot: root2, consent: CONSENT, hmacKey: KEY, subject: 'zero-subject', flow: 'first' }, clock('2026-09-08T00:00:01.000Z'))
        const zeroLog = path.join(mod.storeRootForStateRoot(root2), 'events.jsonl')
        const beforeZero = fs.readFileSync(zeroLog)
        zeroComplete = true
        assert.throws(() => mod.completeMemoryLifecycleFlow({ stateRoot: root2, consent: CONSENT, hmacKey: KEY, subject: 'zero-subject', flow: 'first' }, clock('2026-09-08T00:00:02.000Z')), error => error?.code === 'internal_error')
        assert.deepEqual(fs.readFileSync(zeroLog), beforeZero)
      } finally {
        fs.rmSync(root2, { recursive: true, force: true })
      }
      assert.notDeepEqual(fs.readFileSync(logPath), beforeComplete)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  `)
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`)
})

await pass('manifest/export 使用临时文件原子发布:短写可补齐,失败可重试,no-overwrite 保留', () => {
  const run = runFaultScript(`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import os from 'node:os'
    import path from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const KEY = ${JSON.stringify(KEY)}
    const CONSENT = ${JSON.stringify(CONSENT)}
    const originalWriteSync = fs.writeSync
    function requestedText(data, args) {
      if (Buffer.isBuffer(data)) {
        const offset = args[0] ?? 0
        const length = args[1] ?? data.length - offset
        return data.subarray(offset, offset + length).toString('utf8')
      }
      return String(data)
    }
    function writePrefixThenReturn(fd, data, args, prefixLength) {
      if (Buffer.isBuffer(data)) {
        const offset = args[0] ?? 0
        const length = args[1] ?? data.length - offset
        const slice = data.subarray(offset, offset + Math.min(prefixLength, length))
        return originalWriteSync.call(fs, fd, slice, 0, slice.length)
      }
      return originalWriteSync.call(fs, fd, String(data).slice(0, prefixLength))
    }
    let failManifest = true
    let shortExport = true
    let failExport = false
    fs.writeSync = function patchedWriteSync(fd, data, ...args) {
      const text = requestedText(data, args)
      if (failManifest && text.includes('memory_lifecycle_manifest.v1')) {
        failManifest = false
        writePrefixThenReturn(fd, data, args, 35)
        const error = new Error('ENOSPC')
        error.code = 'ENOSPC'
        throw error
      }
      if (shortExport && text.includes('memory_value_fixture.v1')) {
        shortExport = false
        return writePrefixThenReturn(fd, data, args, 35)
      }
      if (failExport && text.includes('memory_value_fixture.v1')) {
        failExport = false
        writePrefixThenReturn(fd, data, args, 35)
        const error = new Error('ENOSPC')
        error.code = 'ENOSPC'
        throw error
      }
      return originalWriteSync.call(this, fd, data, ...args)
    }
    syncBuiltinESMExports()
    const mod = await import(${JSON.stringify(MODULE_URL)})
    const clock = iso => ({ now: () => new Date(iso) })
    const initRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gotry-memory-lifecycle-manifest-fault-'))
    try {
      assert.throws(() => mod.initMemoryLifecycleDataset({ stateRoot: initRoot, consent: CONSENT, hmacKey: KEY, sourceKind: 'synthetic_fixture', dataset: 'manifest-fault', waitCodes: ['tool_latency'] }, clock('2026-09-08T00:00:00.000Z')), error => error?.code === 'internal_error')
      assert.equal(fs.existsSync(path.join(mod.storeRootForStateRoot(initRoot), 'manifest.json')), false)
      const retry = mod.initMemoryLifecycleDataset({ stateRoot: initRoot, consent: CONSENT, hmacKey: KEY, sourceKind: 'synthetic_fixture', dataset: 'manifest-fault', waitCodes: ['tool_latency'] }, clock('2026-09-08T00:00:01.000Z'))
      assert.equal(retry.status, 'recorded')
    } finally {
      fs.rmSync(initRoot, { recursive: true, force: true })
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gotry-memory-lifecycle-export-fault-'))
    try {
      mod.initMemoryLifecycleDataset({ stateRoot: root, consent: CONSENT, hmacKey: KEY, sourceKind: 'synthetic_fixture', dataset: 'export-fault', waitCodes: ['tool_latency'] }, clock('2026-09-08T00:00:00.000Z'))
      mod.startMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'export-subject', flow: 'first' }, clock('2026-09-08T00:00:01.000Z'))
      mod.completeMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'export-subject', flow: 'first' }, clock('2026-09-08T00:00:02.000Z'))
      mod.startMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'export-subject', flow: 'returning' }, clock('2026-09-08T00:00:03.000Z'))
      mod.completeMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'export-subject', flow: 'returning' }, clock('2026-09-08T00:00:04.000Z'))
      const shortOut = path.join(root, 'short-export.json')
      const shortResult = mod.exportMemoryLifecycleFixture({ stateRoot: root, consent: CONSENT, hmacKey: KEY, out: shortOut }).result
      assert.equal(shortResult.output_written, true)
      assert.equal(JSON.parse(fs.readFileSync(shortOut, 'utf8')).schema, 'memory_value_fixture.v1')

      const failOut = path.join(root, 'failed-export.json')
      failExport = true
      assert.throws(() => mod.exportMemoryLifecycleFixture({ stateRoot: root, consent: CONSENT, hmacKey: KEY, out: failOut }), error => error?.code === 'internal_error')
      assert.equal(fs.existsSync(failOut), false)
      const retryExport = mod.exportMemoryLifecycleFixture({ stateRoot: root, consent: CONSENT, hmacKey: KEY, out: failOut }).result
      assert.equal(retryExport.output_written, true)

      const existingOut = path.join(root, 'existing-export.json')
      fs.writeFileSync(existingOut, 'existing', { mode: 0o600 })
      assert.throws(() => mod.exportMemoryLifecycleFixture({ stateRoot: root, consent: CONSENT, hmacKey: KEY, out: existingOut }), error => error?.code === 'output_exists')
      assert.equal(fs.readFileSync(existingOut, 'utf8'), 'existing')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  `)
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`)
})

await pass('锁元数据写失败只清理本 writer lock,重试可成功', () => {
  const run = runFaultScript(`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import os from 'node:os'
    import path from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const KEY = ${JSON.stringify(KEY)}
    const CONSENT = ${JSON.stringify(CONSENT)}
    const originalWriteSync = fs.writeSync
    let failLock = true
    fs.writeSync = function patchedWriteSync(fd, data, ...args) {
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : ''
      if (failLock && text.includes('memory_lifecycle_lock.v1')) {
        failLock = false
        const error = new Error('ENOSPC')
        error.code = 'ENOSPC'
        throw error
      }
      return originalWriteSync.call(this, fd, data, ...args)
    }
    syncBuiltinESMExports()
    const mod = await import(${JSON.stringify(MODULE_URL)})
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gotry-memory-lifecycle-lock-fault-'))
    try {
      assert.throws(() => mod.initMemoryLifecycleDataset({ stateRoot: root, consent: CONSENT, hmacKey: KEY, sourceKind: 'synthetic_fixture', dataset: 'fault-lock', waitCodes: ['tool_latency'] }), error => error?.code === 'internal_error')
      assert.equal(fs.existsSync(path.join(mod.storeRootForStateRoot(root), '.writer.lock')), false)
      const retried = mod.initMemoryLifecycleDataset({ stateRoot: root, consent: CONSENT, hmacKey: KEY, sourceKind: 'synthetic_fixture', dataset: 'fault-lock', waitCodes: ['tool_latency'] })
      assert.equal(retried.status, 'recorded')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  `)
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`)
})

await pass('事件追加部分失败回滚到旧前缀,崩溃式未提交尾部可恢复', () => {
  const run = runFaultScript(`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import os from 'node:os'
    import path from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    const KEY = ${JSON.stringify(KEY)}
    const CONSENT = ${JSON.stringify(CONSENT)}
    const originalWriteSync = fs.writeSync
    let failComplete = false
    fs.writeSync = function patchedWriteSync(fd, data, ...args) {
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : ''
      if (failComplete && text.includes('"kind":"flow_completed"')) {
        failComplete = false
        originalWriteSync.call(this, fd, text.slice(0, 35))
        const error = new Error('ENOSPC')
        error.code = 'ENOSPC'
        throw error
      }
      return originalWriteSync.call(this, fd, data, ...args)
    }
    syncBuiltinESMExports()
    const mod = await import(${JSON.stringify(MODULE_URL)})
    const clock = iso => ({ now: () => new Date(iso) })
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gotry-memory-lifecycle-append-fault-'))
    try {
      mod.initMemoryLifecycleDataset({ stateRoot: root, consent: CONSENT, hmacKey: KEY, sourceKind: 'synthetic_fixture', dataset: 'fault-append', waitCodes: ['tool_latency'] }, clock('2026-09-08T00:00:00.000Z'))
      mod.startMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'fault-subject', flow: 'first' }, clock('2026-09-08T00:00:01.000Z'))
      const logPath = path.join(mod.storeRootForStateRoot(root), 'events.jsonl')
      const before = fs.readFileSync(logPath)
      failComplete = true
      assert.throws(() => mod.completeMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'fault-subject', flow: 'first' }, clock('2026-09-08T00:00:02.000Z')), error => error?.code === 'internal_error')
      assert.deepEqual(fs.readFileSync(logPath), before)
      mod.completeMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'fault-subject', flow: 'first' }, clock('2026-09-08T00:00:03.000Z'))
      assert.equal(mod.readStoreForTests(root).events.length, 2)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  `)
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`)

  const root = mkdtempSync(join(tmpdir(), 'gotry-memory-lifecycle-tail-recovery-'))
  initMemoryLifecycleDataset({ stateRoot: root, consent: CONSENT, hmacKey: KEY, sourceKind: 'synthetic_fixture', dataset: 'tail-recovery', waitCodes: ['tool_latency'] }, fixed('2026-09-08T00:00:00.000Z'))
  startMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'tail-subject', flow: 'first' }, fixed('2026-09-08T00:00:01.000Z'))
  const beforeTail = eventLogBytes(root)
  writeFileSync(eventLogPath(root), Buffer.concat([beforeTail, Buffer.from('{"schema_version":')]))
  completeMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'tail-subject', flow: 'first' }, fixed('2026-09-08T00:00:02.000Z'))
  assert.equal(readStoreForTests(root).events.length, 2)
  assert.equal(eventLogBytes(root).subarray(0, beforeTail.length).equals(beforeTail), true)
  rmSync(root, { recursive: true, force: true })
})

await pass('observed_private 导出只给 candidate source_review,不伪造 manual_attested', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gotry-memory-lifecycle-observed-'))
  jsonStdout(runCli(['init', ...initArgs(root, 'observed_private')], { key: KEY }))
  jsonStdout(runCli(['start', ...common(root), '--subject', 'real-subject-operator-ref', '--flow', 'first', '--eligible-planning'], { key: KEY }))
  await delay(6)
  jsonStdout(runCli(['complete', ...common(root), '--subject', 'real-subject-operator-ref', '--flow', 'first'], { key: KEY }))
  await delay(6)
  jsonStdout(runCli(['start', ...common(root), '--subject', 'real-subject-operator-ref', '--flow', 'returning', '--eligible-planning'], { key: KEY }))
  await delay(6)
  jsonStdout(runCli(['complete', ...common(root), '--subject', 'real-subject-operator-ref', '--flow', 'returning'], { key: KEY }))
  const fixture = jsonStdout<any>(runCli(['export', ...common(root)], { key: KEY }))
  assert.equal(fixture.evidence_kind, 'observed_private')
  assert.equal(fixture.source_review.state, 'candidate')
  assert.notEqual(fixture.source_review.state, 'manual_attested')
  assert.equal(fixture.source_review.attestation_ref, null)
  assert.equal(fixture.source_review.reviewer_ref, null)
  assert.equal(fixture.source_review.reviewed_summary_digest_sha256, memoryValueSummaryDigest(fixture))
  assert.equal(fixture.source_review.checks.raw_private_material_excluded, true)
  rmSync(root, { recursive: true, force: true })
})

await pass('并发写锁:已有 writer lock 时 CLI 失败且不盲覆盖', () => {
  const root = mkdtempSync(join(tmpdir(), 'gotry-memory-lifecycle-lock-'))
  jsonStdout(runCli(['init', ...initArgs(root)], { key: KEY }))
  const store = storeRootForStateRoot(root)
  mkdirSync(store, { recursive: true })
  const lock = join(store, '.writer.lock')
  writeFileSync(lock, 'held-by-test', { mode: 0o600 })
  const before = eventCount(root)
  assertCliError(runCli(['start', ...common(root), '--subject', 'locked', '--flow', 'first', '--eligible-planning'], { key: KEY }), 'lock_busy')
  assert.equal(eventCount(root), before)
  unlinkSync(lock)
  rmSync(root, { recursive: true, force: true })
})

await pass('测试态可注入 clock;生产 CLI 没有 --at 入口', () => {
  const root = mkdtempSync(join(tmpdir(), 'gotry-memory-lifecycle-clock-'))
  const fixed = (iso: string): Clock => ({ now: () => new Date(iso) })
  initMemoryLifecycleDataset({
    stateRoot: root,
    consent: CONSENT,
    hmacKey: KEY,
    sourceKind: 'synthetic_fixture',
    dataset: 'clock-dataset',
    waitCodes: ['tool_latency'],
  }, fixed('2026-09-08T00:00:00.000Z'))
  startMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'clock-subject', flow: 'first' }, fixed('2026-09-08T00:00:01.000Z'))
  assert.throws(() => completeMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'clock-subject', flow: 'first' }, fixed('2026-09-08T00:00:01.000Z')))
  completeMemoryLifecycleFlow({ stateRoot: root, consent: CONSENT, hmacKey: KEY, subject: 'clock-subject', flow: 'first' }, fixed('2026-09-08T00:00:03.000Z'))
  const productionAt = runCli(['start', ...common(root), '--subject', 'clock-subject', '--flow', 'second', '--eligible-planning', '--at', '2026-09-08T00:00:04Z'], { key: KEY })
  assertCliError(productionAt, 'bad_args')
  rmSync(root, { recursive: true, force: true })
})

console.log(`\nMEMORY LIFECYCLE TESTS: ${n}/14 OK(explicit opt-in/HMAC/no-leak/wait boundaries/source_review candidate/scorer e2e/lock/clock injection)`)
