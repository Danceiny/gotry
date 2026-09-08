/**
 * 账本回归(ADR-15 执行锚点,run-all §28):
 *  1 事务原子性:事务内注入异常 → 整体回滚,账本无痕
 *  2 红线进事务:conditions 缺失拒绝且零事件落账
 *  3 幂等物理化:愿望同名/效用语义键/行程 trip_id 重放 no-op;wish_id 语义派生稳定
 *  4 守门随账本:权重变更守门/词表外日期拒收/重叠冲突即停/负面清单拒收
 *  5 confirm-outcome 单事务:效用+行程同生(跨文件分叉不可能)
 *  6 fold 重建:DROP 投影 → 重放 → 与直读一致(账本/投影永不分叉)
 *  7 rewind:fold 截到历史 seq → 投影回到历史时点;无参 rebuild 回最新
 *  8 one-shot 迁移:旧 JSON/JSONL → events;快照先行;重复 ensure 不重复导入
 *  9 durable 工单崩溃恢复:子进程 settle 前 exit 9 → 恢复零重算(exactly-once)
 * 10 pending_writes saga:幂等键去重/L3 确认一次/补偿/审计事件链/what-if 分叉隔离
 * 11 ADR-16 tenant scope:append/read/fold/rebuild/迁移边界/同 id/跨进程 reopen 全隔离
 * 运行(在 ts/ 下):npx tsx scripts/ledger-tests.ts
 */

import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { TripState } from '../src/contracts.ts'
import { persistAsyncTicket, type AsyncTicket } from '../src/loop.ts'
import { ensureLedger, ledgerDbPath, openLedgerIfExists, readWishPoolWithFallback } from '../src/state-ledger.ts'
import { parseFlightPackToSpec } from '../src/unified.ts'

type TerminalOutcome = {
  schema: 'gotry_async_terminal.v1'
  ticket_id: string
  status: 'succeeded' | 'failed'
  passed: number
  total: number
  checks: Record<string, boolean>
  failed_checks: string[]
}

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++
    console.log(`  ok - ${msg}`)
  } else {
    fail++
    console.error(`  FAIL - ${msg}`)
  }
}

function terminalOutcomeOf(stdout: string): TerminalOutcome | null {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1)
  if (!line) return null
  try {
    const value = JSON.parse(line) as Partial<TerminalOutcome>
    if (
      value.schema !== 'gotry_async_terminal.v1'
      || typeof value.ticket_id !== 'string'
      || (value.status !== 'succeeded' && value.status !== 'failed')
      || typeof value.passed !== 'number'
      || typeof value.total !== 'number'
      || typeof value.checks !== 'object'
      || !Array.isArray(value.failed_checks)
    ) return null
    return value as TerminalOutcome
  } catch {
    return null
  }
}

// ---- 1-7:fresh root 基座面 ------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'gotry-ledger-'))
const ledger = ensureLedger(root)

const r1 = ledger.appendMotivationPatch({
  weights: { escape_rest: 0.7 }, evidence: ['用户原话:想去湖边什么都不干'], hard: { wake_not_before: '06:30' },
})
assert(r1.saved === true, '画像补丁落账(saved)')
const r2 = ledger.appendMotivationPatch({ evidence: ['用户原话:想去湖边什么都不干'] })
assert(r2.saved === false, '同 evidence 重放幂等(mergeProfile 守门 → 零事件)')

const before = ledger.countEvents()
let threw = false
try {
  ledger.db.transaction(() => {
    ledger.insertEvent({ actor: 'test', kind: 'probe', payload: { x: 1 } })
    throw new Error('boom')
  })()
} catch {
  threw = true
}
assert(threw && ledger.countEvents() === before, '事务内异常 → 整体回滚,账本无痕(崩溃一致性的单事务证明)')

threw = false
try {
  ledger.appendWish({ name: '无条件憧憬', reason: '', conditions: undefined })
} catch {
  threw = true
}
assert(threw && ledger.countEvents() === before, 'conditions 红线在事务内拒绝且零事件(红线进 schema 层)')

const w1 = ledger.appendWish({ name: '大理·洱海', reason: '', conditions: { days: 5, budget_cny: 4950, best_months: [3, 4] } })
const w2 = ledger.appendWish({ name: '大理·洱海', reason: '两周年想再去', conditions: { days: 6 } })
assert(w1.added === true && w2.added === false && w1.wish_id === w2.wish_id, '同名愿望幂等更新,wish_id 语义派生稳定')
assert(ledger.readWishPool().length === 1, '愿望池投影恰 1 条')

const u1 = ledger.appendUtilityEvent({ wish_id: w1.wish_id, kind: 'recalled', ts: '2026-08-28T00:00:00Z', ctx: 'test' })
const u2 = ledger.appendUtilityEvent({ wish_id: w1.wish_id, kind: 'recalled', ts: '2026-08-28T00:00:00Z', ctx: 'test' })
assert(u1.appended === true && u2.appended === false, '效用事件语义键幂等(重放 no-op)')
ledger.appendUtilityEvent({ wish_id: w1.wish_id, kind: 'verified_outcome', ts: '2026-08-28T00:00:00Z', ctx: 'test-noattr' })
assert(ledger.readUtilityEvents().at(-1)?.kind === 'applied', '无归因 verified 降级 applied(六件语义纪律随账本)')

const t1 = ledger.appendTripEvent({ destination: '大理', start: '2026-10-01', source: 'user-verbatim', evidence: '用户原话:国庆去了大理' })
const t1dup = ledger.appendTripEvent({ destination: '大理', start: '2026-10-01', source: 'user-verbatim', evidence: '用户原话:国庆去了大理' })
assert(t1.appended === true && t1dup.appended === false, '行程 trip_id 幂等')
const tOverlap = ledger.appendTripEvent({ destination: '大理', start: '2026-10-03', source: 'user-verbatim', evidence: '重叠探针' })
assert(tOverlap.appended === false && /重叠/.test(tOverlap.reason ?? ''), '同目的地日期重叠冲突即停(由人裁决)')
const tBad = ledger.appendTripEvent({ destination: 'X地', start: '十月一', source: 'user-verbatim', evidence: 'x' })
assert(tBad.appended === false, '词表外日期拒收(不猜)')

const cBad = ledger.appendCompanion({ label: '爸爸', constraints: { health: ['手机号13800001111'] }, evidence: '探针' })
assert(cBad.appended === false && /负面清单/.test(cBad.reason ?? ''), '同行人负面清单拒收(证件/手机号不入库)')
const cOk = ledger.appendCompanion({ label: '爸爸', constraints: { health: ['轻度高血压'] }, evidence: '用户原话:爸爸65轻度高血压' })
assert(cOk.appended === true && ledger.readCompanions().length === 1, '同行人正常入账')

const co = ledger.confirmOutcome({
  wishId: w1.wish_id, attribution: 'helpful', detail: '成了',
  trip: { destination: '大理', start: '2026-10-01', source: 'wish-confirmed', evidence: `wish ${w1.wish_id} confirm-outcome(helpful)` },
})
assert(co.recorded === true, 'confirm-outcome:verified_outcome 效用事件落账')
assert(co.trip?.appended === false && /重叠/.test(co.trip?.reason ?? ''), 'confirm-outcome 单事务:行程过守门(重叠拒收,与文件版语义一致)——两写同生或同拒')

const poolBefore = JSON.stringify(ledger.readWishPool())
const profileBefore = ledger.readMotivation()
ledger.db.exec('DELETE FROM projection_docs; DELETE FROM projection_items')
ledger.rebuildProjections()
assert(JSON.stringify(ledger.readWishPool()) === poolBefore, 'fold 重建:愿望池与直读逐字节一致')
assert(
  JSON.stringify(ledger.readMotivation()?.weights) === JSON.stringify(profileBefore?.weights)
  && (ledger.readMotivation()?.evidence?.length ?? 0) === (profileBefore?.evidence?.length ?? 0),
  'fold 重建:画像与直读一致',
)
assert(ledger.readCompanions().length === 1 && ledger.readTrips().length === 1, 'fold 重建:同行人投影与行程日志一致')

const wishAddedSeqs = ledger.readEvents('wish.added', 10).map(e => e.seq)
const firstWishSeq = Math.min(...wishAddedSeqs)
ledger.appendWish({ name: '普吉', reason: '', conditions: { days: 5 } })
ledger.rebuildProjections(firstWishSeq)
assert(ledger.readWishPool().length === 1, `rewind 至 seq ${firstWishSeq}:投影回到历史时点(LangGraph fork 同构)`)
ledger.rebuildProjections()
assert(ledger.readWishPool().length === 2, 'rebuild 无参回到最新(events 是唯一权威,投影随时可重建)')

// ---- 8:one-shot 迁移 --------------------------------------------------------------

const mroot = mkdtempSync(join(tmpdir(), 'gotry-migrate-'))
const mdir = join(mroot, 'gotry-state')
mkdirSync(mdir, { recursive: true })
writeFileSync(join(mdir, 'motivation-profile.json'), JSON.stringify({ weights: { curiosity: 0.6 }, evidence: ['原话A'], hard: {}, updated_at: '2026-08-01T00:00:00Z' }))
writeFileSync(join(mdir, 'wish-pool.json'), JSON.stringify([{ wish_id: 'wLEGACY1', name: '京都', conditions: { days: 7 }, added_at: '2026-08-01T00:00:00Z' }]))
writeFileSync(join(mdir, 'memory-utility.jsonl'), JSON.stringify({ schema: 'memory_utility_observation.v0', event_id: 'wLEGACY1|recalled||', wish_id: 'wLEGACY1', kind: 'recalled', ts: '2026-08-02T00:00:00Z' }) + '\n')
writeFileSync(join(mdir, 'trips.jsonl'), JSON.stringify({ schema: 'travel_timeline.v1', trip_id: '京都|2026-04-01|user-verbatim', destination: '京都', start: '2026-04-01', source: 'user-verbatim', evidence: '原话', ts: '2026-08-01T00:00:00Z' }) + '\n')
writeFileSync(join(mdir, 'companions.json'), JSON.stringify([{ schema: 'companion_profile.v1', companion_id: '妈妈', label: '妈妈', constraints: { mobility: '步行≤3h' }, evidence: ['原话'], ts: '2026-08-01T00:00:00Z' }]))
const m1 = ensureLedger(mroot)
assert(m1.readMotivation()?.weights?.['curiosity'] === 0.6, '迁移:画像整档入账')
assert(String(m1.readWishPool()[0]?.wish_id) === 'wLEGACY1', '迁移:愿望保留原主键')
assert(m1.readUtilityEvents().length === 1 && m1.readTrips().length === 1 && m1.readCompanions().length === 1, '迁移:效用/行程/同行人入账')
assert(existsSync(join(mdir, 'pre-ledger-backup', 'wish-pool.json')), '迁移:导入前快照存在(pre-ledger-backup/)')
const migratedCount = m1.countEvents()
ensureLedger(mroot)
assert(m1.countEvents() === migratedCount, '重复 ensure 不重复导入(kv 旗标 + 幂等键双保险)')

const tenantMroot = mkdtempSync(join(tmpdir(), 'gotry-migrate-tenant-boundary-'))
const tenantMdir = join(tenantMroot, 'gotry-state')
mkdirSync(tenantMdir, { recursive: true })
writeFileSync(join(tenantMdir, 'wish-pool.json'), JSON.stringify([{ wish_id: 'wLOCALLEGACY', name: '本地旧愿望', conditions: { days: 2 }, added_at: '2026-08-01T00:00:00Z' }]))
assert(readWishPoolWithFallback(tenantMroot, 'tenant-a').length === 0, '迁移边界:非 local 只读 fallback 不读取旧本地 JSON')
const tenantFirst = ensureLedger(tenantMroot, 'tenant-a')
const localLegacy = ensureLedger(tenantMroot)
assert(tenantFirst.readWishPool().length === 0, '迁移边界:非 local 首次打开不把旧文件猜入该租户')
assert(localLegacy.readWishPool()[0]?.wish_id === 'wLOCALLEGACY', '迁移边界:旧 JSON/JSONL 只可安全归入默认 local')
assert(
  (localLegacy.db.prepare('SELECT COUNT(*) AS n FROM events WHERE tenant_id != \'local\'').get() as { n: number }).n === 0,
  '迁移边界:旧文件导入事件 tenant_id 全为 local,不伪造历史归属',
)

const v1root = mkdtempSync(join(tmpdir(), 'gotry-v1-tenant-migration-'))
mkdirSync(join(v1root, 'gotry-state'), { recursive: true })
const v1db = new Database(ledgerDbPath(v1root))
v1db.exec(`
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject_id TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL,
    idem_key TEXT,
    run_id TEXT
  );
  CREATE UNIQUE INDEX events_idem ON events(idem_key) WHERE idem_key IS NOT NULL;
`)
v1db.prepare('INSERT INTO events (ts, actor, kind, subject_id, payload, idem_key, run_id) VALUES (?, ?, ?, ?, ?, ?, NULL)')
  .run('2026-08-28T00:00:00.000Z', 'system:v1', 'wish.added', 'wV1', JSON.stringify({ wish: { wish_id: 'wV1', name: 'v1旧愿望', reason: '', conditions: { days: 4 }, added_at: '2026-08-28T00:00:00.000Z' } }), 'v1:wish')
v1db.close()
const v1Tenant = ensureLedger(v1root, 'tenant-a')
const v1Local = ensureLedger(v1root)
assert(v1Tenant.readWishPool().length === 0, 'schema v1→v2:非 local 打开旧 DB 不吸收 local 事件')
assert(v1Local.readWishPool()[0]?.wish_id === 'wV1', 'schema v1→v2:旧 events 回填 local 后重建 local 投影')
assert(
  (v1Local.db.prepare('SELECT COUNT(*) AS n FROM events WHERE tenant_id = \'local\'').get() as { n: number }).n === 1,
  'schema v1→v2:events tenant_id 回填为 local 且不丢 seq/idempotency',
)

// ---- 9:durable 工单崩溃恢复(exactly-once) ----------------------------------------

const wroot = mkdtempSync(join(tmpdir(), 'gotry-wf-'))
const countFile = join(wroot, 'solve-count.txt')
writeFileSync(countFile, '')
const crash = spawnSync('npx', ['tsx', 'scripts/ledger-workflow-crash.ts', wroot, 'dp-crash1', countFile], { encoding: 'utf-8' })
assert(crash.status === 9, `崩溃探针按设计 exit 9(实际 ${crash.status}:${(crash.stderr ?? '').slice(0, 200)})`)
const runRow = openLedgerIfExists(wroot)?.getWorkflowRun('dp-crash1')
assert(runRow?.status === 'pending', '崩溃后工单仍 pending(账本权威未损)')
const count1 = readFileSync(countFile, 'utf-8').split('\n').filter(Boolean).length
assert(count1 === 1, '崩溃前真实求解恰 1 次')
const resume = spawnSync('npx', ['tsx', 'scripts/async-collect.ts', 'dp-crash1', wroot], {
  encoding: 'utf-8', env: { ...process.env, GOTRY_SOLVE_COUNT_FILE: countFile },
})
const failedOutcome = terminalOutcomeOf(resume.stdout ?? '')
assert(resume.status === 2, `非4/4 恢复进程 exit 2(实际 ${resume.status}:${(resume.stderr ?? '').slice(0, 300)})`)
assert(
  failedOutcome?.status === 'failed'
  && failedOutcome.ticket_id === 'dp-crash1'
  && failedOutcome.passed < failedOutcome.total
  && failedOutcome.failed_checks.length > 0,
  '非4/4 输出 gotry_async_terminal.v1/failed 与失败项',
)
const count2 = readFileSync(countFile, 'utf-8').split('\n').filter(Boolean).length
assert(count2 === 1, '恢复时 done 步骤零重算(exactly-once:求解计数仍 1,不重复花钱)')
const failedDeliverablePath = join(wroot, 'gotry-state', 'async', 'dp-crash1.deliverable.md')
assert(existsSync(failedDeliverablePath), '交付物视图已落盘(.deliverable.md)')
const failedLedger = openLedgerIfExists(wroot)
assert(failedLedger?.getWorkflowRun('dp-crash1')?.status === 'failed', '非4/4 账本终态 failed')
assert(
  JSON.stringify(failedLedger?.getWorkflowTerminalOutcome('dp-crash1')) === JSON.stringify(failedOutcome),
  '非4/4 结构化终态随 async.failed 事件落账',
)
const replay = spawnSync('npx', ['tsx', 'scripts/async-collect.ts', 'dp-crash1', wroot], {
  encoding: 'utf-8', env: { ...process.env, GOTRY_SOLVE_COUNT_FILE: countFile },
})
assert(
  replay.status === 2 && JSON.stringify(terminalOutcomeOf(replay.stdout ?? '')) === JSON.stringify(failedOutcome),
  'failed 终态复诵保持 exit 2 与同一结构化结果',
)
const count3 = readFileSync(countFile, 'utf-8').split('\n').filter(Boolean).length
assert(count3 === 1, '终态复诵零重算')
const failedDeliverable = readFileSync(failedDeliverablePath, 'utf-8')
rmSync(failedDeliverablePath)
const replayAfterMissingView = spawnSync('npx', ['tsx', 'scripts/async-collect.ts', 'dp-crash1', wroot], {
  encoding: 'utf-8', env: { ...process.env, GOTRY_SOLVE_COUNT_FILE: countFile },
})
assert(
  replayAfterMissingView.status === 2
  && JSON.stringify(terminalOutcomeOf(replayAfterMissingView.stdout ?? '')) === JSON.stringify(failedOutcome),
  'failed 终态缺失视图时仍复诵同一 exit 2 与结构化结果',
)
assert(
  existsSync(failedDeliverablePath) && readFileSync(failedDeliverablePath, 'utf-8') === failedDeliverable,
  'failed 终态复诵重建缺失 .deliverable.md 视图',
)
const countAfterViewRepair = readFileSync(countFile, 'utf-8').split('\n').filter(Boolean).length
assert(countAfterViewRepair === 1, '终态视图修复零重算')

// state-cli tick 是另一个 durable driver；即使旧调用未显式透传 outcome，
// settle 层也必须从账本中的权威 state/step 恢复机器终态，不能误结算为成功。
const tickRoot = mkdtempSync(join(tmpdir(), 'gotry-wf-tick-failed-'))
const tickTicket: AsyncTicket = {
  id: 'dp-tick-failed1',
  objective: 'state-cli 非4/4 机器终态回归',
  requestedAt: new Date().toISOString(),
  etaLabel: '秒级',
}
const tickState = {
  calendar: { year: 2026, assertedWeekdays: {} },
  profile: {},
  gates: [],
  wishes: [],
} as TripState
await persistAsyncTicket(tickTicket, tickState, tickRoot)
const tick = spawnSync('npx', ['tsx', 'scripts/state-cli.ts', 'tick', tickRoot], { encoding: 'utf-8' })
assert(tick.status === 0, `state-cli tick 完成回收(实际 ${tick.status}:${(tick.stderr ?? '').slice(0, 200)})`)
const tickLedger = openLedgerIfExists(tickRoot)
const tickOutcome = tickLedger?.getWorkflowTerminalOutcome(tickTicket.id) as TerminalOutcome | null
assert(
  tickLedger?.getWorkflowRun(tickTicket.id)?.status === 'failed'
  && tickOutcome?.schema === 'gotry_async_terminal.v1'
  && tickOutcome.status === 'failed'
  && tickOutcome.passed === 0
  && tickOutcome.failed_checks.length === 4,
  'state-cli tick 未透传 outcome 时仍从权威账本恢复非4/4 failed 终态',
)
const tickReplay = spawnSync('npx', ['tsx', 'scripts/async-collect.ts', tickTicket.id, tickRoot], { encoding: 'utf-8' })
assert(
  tickReplay.status === 2
  && JSON.stringify(terminalOutcomeOf(tickReplay.stdout ?? '')) === JSON.stringify(tickOutcome),
  'state-cli 写入的 failed 终态可由 collector 幂等复诵为同一 outcome/exit 2',
)

const successRoot = mkdtempSync(join(tmpdir(), 'gotry-wf-success-'))
const successCountFile = join(successRoot, 'solve-count.txt')
writeFileSync(successCountFile, '')
const successTicket: AsyncTicket = {
  id: 'dp-success1',
  objective: '4/4 机器终态回归',
  requestedAt: new Date().toISOString(),
  etaLabel: '秒级',
}
const successSpec = parseFlightPackToSpec(JSON.parse(readFileSync(join('..', 'data', 'flights_2026.json'), 'utf-8')))
successSpec.budgetCny = 9000
const successState = {
  calendar: { year: 2026, assertedWeekdays: {} },
  profile: {},
  gates: [],
  wishes: [],
  spec: successSpec,
} as unknown as TripState
await persistAsyncTicket(successTicket, successState, successRoot)
const success = spawnSync('npx', ['tsx', 'scripts/async-collect.ts', successTicket.id, successRoot], {
  encoding: 'utf-8', env: { ...process.env, GOTRY_SOLVE_COUNT_FILE: successCountFile },
})
const successOutcome = terminalOutcomeOf(success.stdout ?? '')
assert(
  success.status === 0
  && successOutcome?.status === 'succeeded'
  && successOutcome.ticket_id === successTicket.id
  && successOutcome.passed === 4
  && successOutcome.total === 4
  && successOutcome.failed_checks.length === 0,
  `4/4 输出 gotry_async_terminal.v1/succeeded 且 exit 0(实际 ${success.status})`,
)
const successLedger = openLedgerIfExists(successRoot)
assert(
  successLedger?.getWorkflowRun(successTicket.id)?.status === 'settled'
  && successLedger.getWorkflowTerminalOutcome(successTicket.id)?.['status'] === 'succeeded',
  '4/4 账本终态 settled 且结构化结果随 async.settled 落账',
)
const successReplay = spawnSync('npx', ['tsx', 'scripts/async-collect.ts', successTicket.id, successRoot], {
  encoding: 'utf-8', env: { ...process.env, GOTRY_SOLVE_COUNT_FILE: successCountFile },
})
const successCount = readFileSync(successCountFile, 'utf-8').split('\n').filter(Boolean).length
assert(
  successReplay.status === 0
  && successCount === 1
  && JSON.stringify(terminalOutcomeOf(successReplay.stdout ?? '')) === JSON.stringify(successOutcome),
  'succeeded 终态复诵保持 exit 0、同一结构化结果且零重算',
)

// ---- 10:pending_writes saga + what-if 分叉 -----------------------------------------

const pw1 = ledger.requestPendingWrite({ idemKey: 'booking:demo-1', seam: 'flight-order-confirm', payload: { flight: 'MU123' } })
const pw2 = ledger.requestPendingWrite({ idemKey: 'booking:demo-1', seam: 'flight-order-confirm', payload: { flight: 'MU123' } })
assert(pw1.created === true && pw2.created === false, 'pending_writes 幂等键去重(同一确认不可能登记两次)')
const cf1 = ledger.confirmPendingWrite('booking:demo-1', 'PNR-ABC')
const cf2 = ledger.confirmPendingWrite('booking:demo-1', 'PNR-ABC2')
assert(cf1.ok === true && cf2.ok === false && cf2.status === 'confirmed', 'L3 确认只能发生一次,二连击被拒')
const cp1 = ledger.compensatePendingWrite('booking:demo-1', '用户改签退款')
assert(cp1.ok === true && ledger.listPendingWrites()[0]?.status === 'compensated', 'saga 补偿可达(pending/confirmed → compensated)')
const audit = ledger.readEvents(undefined, 100).filter(e => e.kind.startsWith('write.'))
assert(
  audit.some(e => e.kind === 'write.pending') && audit.some(e => e.kind === 'write.confirmed') && audit.some(e => e.kind === 'write.compensated'),
  '写权审计事件链完整(append-only,WriteGate 的 receipt 落点)',
)
const forkPath = join(root, 'whatif.db')
ledger.forkWhatIf(forkPath)
const forkDb = new Database(forkPath)
forkDb.prepare("INSERT INTO events (ts, actor, kind, subject_id, payload) VALUES (?, 'test', 'probe', '', '{}')").run(new Date().toISOString())
const forkCount = (forkDb.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
forkDb.close()
assert(ledger.countEvents() === forkCount - 1, 'what-if 分叉:副本写入不触正本(VACUUM INTO 预演)')

// ---- 11:双形态(ADR-16):tenant scope 贯穿 append/read/fold/rebuild/API ----------------

const tenantRoot = mkdtempSync(join(tmpdir(), 'gotry-tenant-scope-'))
const localLedger = ensureLedger(tenantRoot) // 默认 tenant='local'
const tenantA = ensureLedger(tenantRoot, 'tenant-a')
const tenantB = ensureLedger(tenantRoot, 'tenant-b')
const localWish = localLedger.appendWish({ name: '同 id 愿望', reason: 'local0', conditions: { owner: 'local0' } })
const wishA = tenantA.appendWish({ name: '同 id 愿望', reason: 'a0', conditions: { owner: 'a0' } })
const wishB = tenantB.appendWish({ name: '同 id 愿望', reason: 'b0', conditions: { owner: 'b0' } })
tenantA.appendWish({ name: '同 id 愿望', reason: 'a1', conditions: { owner: 'a1' } })
tenantB.appendWish({ name: '同 id 愿望', reason: 'b1', conditions: { owner: 'b1' } })
const utilA = tenantA.appendUtilityEvent({ wish_id: wishA.wish_id, kind: 'recalled', ts: '2026-09-08T00:00:00.000Z', ctx: 'same-ctx' })
const utilB = tenantB.appendUtilityEvent({ wish_id: wishB.wish_id, kind: 'recalled', ts: '2026-09-08T00:00:00.000Z', ctx: 'same-ctx' })
assert(localWish.wish_id === wishA.wish_id && wishA.wish_id === wishB.wish_id, '同业务 id/wish_id 可跨 local/tenant-a/tenant-b 并存')
assert(utilA.appended === true && utilB.appended === true, '同 event_id/idempotency key 跨租户独立追加(UNIQUE tenant-scoped)')
const tenantRows = localLedger.db.prepare('SELECT tenant_id, kind, subject_id, idem_key FROM events WHERE subject_id = ? ORDER BY tenant_id, seq').all(wishA.wish_id) as Array<{ tenant_id: string; kind: string; subject_id: string; idem_key: string | null }>
assert(
  tenantRows.filter(r => r.kind === 'wish.added').map(r => r.tenant_id).sort().join(',') === 'local,tenant-a,tenant-b'
  && tenantRows.filter(r => r.kind === 'wish.updated').map(r => r.tenant_id).sort().join(',') === 'tenant-a,tenant-b',
  '非 local 写入 events 保留真实 owner,默认 local 兼容不变',
)
assert(
  tenantA.readEvents(undefined, 100).every(e => e.tenant_id === 'tenant-a')
  && tenantB.readEvents(undefined, 100).every(e => e.tenant_id === 'tenant-b')
  && localLedger.readEvents(undefined, 100).every(e => e.tenant_id === 'local'),
  'readEvents 默认与 kind 过滤前均先按 ledger.tenant 隔离',
)
assert(tenantA.readEvents('wish.added', 10).length === 1 && tenantB.readEvents('wish.added', 10).length === 1, 'readEvents(kind) 也按租户过滤')
assert(
  !localLedger.readWishPool().some(w => (w.conditions as Record<string, unknown>).owner === 'a1')
  && !tenantA.readWishPool().some(w => (w.conditions as Record<string, unknown>).owner === 'b1'),
  '直写投影:默认 local/tenant-a/tenant-b 同 id 互不覆盖',
)
const localBeforeRebuild = JSON.stringify(localLedger.readWishPool())
const aBeforeRebuild = JSON.stringify(tenantA.readWishPool())
const bBeforeRebuild = JSON.stringify(tenantB.readWishPool())
tenantA.rebuildProjections()
assert(JSON.stringify(tenantA.readWishPool()) === aBeforeRebuild, 'tenant-a rebuild 只读自己的 events 并还原交错 update 后投影')
assert(JSON.stringify(tenantB.readWishPool()) === bBeforeRebuild && JSON.stringify(localLedger.readWishPool()) === localBeforeRebuild, 'tenant-a rebuild 不改写 tenant-b/local 投影')
tenantA.rebuildProjections()
assert(JSON.stringify(tenantA.readWishPool()) === aBeforeRebuild, 'tenant-a 重复 rebuild 幂等')
tenantB.rebuildProjections()
assert(JSON.stringify(tenantB.readWishPool()) === bBeforeRebuild, 'tenant-b rebuild 在 tenant-a 同 item_id 存在时不串读 wish.updated fold 行')
localLedger.rebuildProjections()
assert(JSON.stringify(localLedger.readWishPool()) === localBeforeRebuild, '默认 local rebuild 兼容且不吸收非 local events')
const reopenScript = `
  import { ensureLedger } from './src/state-ledger.ts'
  const root = ${JSON.stringify(tenantRoot)}
  const a = ensureLedger(root, 'tenant-a')
  const b = ensureLedger(root, 'tenant-b')
  const local = ensureLedger(root)
  const aWish = a.readWishPool()[0]
  const bWish = b.readWishPool()[0]
  const localWish = local.readWishPool()[0]
  const ok = aWish?.name === '同 id 愿望'
    && bWish?.name === '同 id 愿望'
    && localWish?.name === '同 id 愿望'
    && aWish?.conditions?.owner === 'a1'
    && bWish?.conditions?.owner === 'b1'
    && localWish?.conditions?.owner === 'local0'
    && a.readEvents(undefined, 100).every(e => e.tenant_id === 'tenant-a')
    && b.readEvents(undefined, 100).every(e => e.tenant_id === 'tenant-b')
    && local.readEvents(undefined, 100).every(e => e.tenant_id === 'local')
  if (!ok) {
    console.error(JSON.stringify({ aWish, bWish, localWish, aEvents: a.readEvents(undefined, 100), bEvents: b.readEvents(undefined, 100), localEvents: local.readEvents(undefined, 100) }))
    process.exit(1)
  }
`
const reopenTenant = spawnSync('npx', ['tsx', '--eval', reopenScript], { encoding: 'utf-8', cwd: process.cwd(), env: process.env })
assert(reopenTenant.status === 0, `跨进程 reopen 后租户事件/投影仍隔离(实际 ${reopenTenant.status}:${(reopenTenant.stderr ?? '').slice(0, 300)})`)
assert(localLedger.tenant === 'local' && tenantA.tenant === 'tenant-a' && tenantB.tenant === 'tenant-b', 'tenant_id 从第一天就是一等字段')

// ---- 收尾 --------------------------------------------------------------------------

rmSync(root, { recursive: true, force: true })
rmSync(mroot, { recursive: true, force: true })
rmSync(tenantMroot, { recursive: true, force: true })
rmSync(v1root, { recursive: true, force: true })
rmSync(tenantRoot, { recursive: true, force: true })
rmSync(wroot, { recursive: true, force: true })
rmSync(successRoot, { recursive: true, force: true })
console.log(`\nLEDGER TESTS: ${pass} ok, ${fail} fail`)
if (fail > 0) process.exit(1)
