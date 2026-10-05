/**
 * Simulated-trigger drill for the dormant D-15 multi-user / multi-writer
 * tracker (issue #275, docs/architecture.md row D-15 and section 10).
 *
 * HONESTY CONTRACT — read before trusting any line of output:
 *   Every result below is `simulated_trigger_drill` / `synthetic`. N child
 *   processes on an mkdtemp root are NOT a second real user, NOT a multi-machine
 *   deployment and NOT an approved AaaS initiative. Issue #275's own acceptance
 *   text says "fixtures do not count as production rollout evidence", so nothing
 *   here satisfies the trigger: tracking issue #275 was closed on 2026-10-05 as
 *   DEFERRED (not completed — open a new issue when the trigger appears), and
 *   this file enables no replication and no multi-writer path. What the drill proves is that the
 *   machinery that already exists holds its SAFETY invariants when a
 *   multi-writer trigger is simulated, and it pins exactly where the
 *   unadmitted path degrades.
 *
 * Sections:
 *   A0  cold-open race: N processes opening a FRESH ledger simultaneously.
 *       This is where the drill found defect D15-1. The founder decided to fix
 *       it on 2026-10-05, so the expectation here is FLIPPED: every opener must
 *       now succeed, and the only admitted failure is the typed
 *       `LedgerBusyError` (`code: 'GOTRY_LEDGER_BUSY'`). A raw `SQLITE_BUSY*`
 *       out of `openDb` is a REGRESSION, not a host-timing fact.
 *   A0b deterministic D15-1 regression: a start-gunned child opens a fresh
 *       ledger exactly while another process holds a write lock in
 *       rollback-journal mode, so the child's `journal_mode = WAL` switch must
 *       wait. Before the fix `busy_timeout` was installed AFTER that switch and
 *       the child threw a raw SQLITE_BUSY with no retry; now it waits and wins.
 *   A0c deterministic exhaustion: the same race with the lock never released
 *       inside the open budget. The open must fail with the TYPED error — this
 *       is the one admitted failure shape, and it is asserted, not observed.
 *   A   N processes appending concurrently to ONE tenant and to TWO tenants:
 *       idem-key dedupe, no lost updates, tenant isolation, integrity_check
 *   B   SIGKILL at named crash points inside one transaction, plus
 *       timing-varied kills on the real product write path -> reopen ->
 *       all-or-nothing and fold integrity
 *   C   stale-claim rejection with fencing tokens under N-process contention
 *       (extends the 2-process race already covered in write-gate-tests)
 *   D   SQLite online backup taken under live write load -> restore -> the
 *       restored fold equals the source prefix at the snapshot point
 *   E   Litestream / cr-sqlite absence pinned as "needs real trigger +
 *       dependency decision", so no document can claim them
 *
 * Kernel discipline: `src/state-ledger.ts` is read-only here. Crash points are
 * injected through the ledger's PUBLIC surface (`ledger.db.transaction` +
 * `insertEvent`), never by editing the module.
 *
 * Child processes are plain `node` processes running `.mts` workers (Node's
 * native type stripping), deliberately NOT tsx: a tsx wrapper is a separate
 * parent process, so killing it would leave the real worker running and the
 * drill would both leak and measure a moving target.
 *
 * Run: cd ts && npx tsx scripts/drill-multiuser-ledger-tests.ts
 */

import Database from 'better-sqlite3'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { makeWishId, openDb, type StateLedger } from '../src/state-ledger.ts'
import { WriteGate, type WriteRequestFields } from '../src/write-gate.ts'

const DRILL_LABEL = 'simulated_trigger_drill'
const TS_DIR = resolve(import.meta.dirname, '..')
const TSX_CLI = join(TS_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const STATE_LEDGER_URL = `file://${join(TS_DIR, 'src', 'state-ledger.ts')}`
const WRITE_GATE_URL = `file://${join(TS_DIR, 'src', 'write-gate.ts')}`
const SUITE_BUDGET_MS = 180_000
const CHILD_BUDGET_MS = 10_000

let pass = 0
const failures: string[] = []
const observations: string[] = []
const children = new Set<ChildProcess>()
/** Every pid ever spawned, plus its process group when detached. Never cleared. */
const trackedPids = new Set<number>()
const trackedGroups = new Set<number>()

/**
 * Kill every live child, every detached process group, and every pid ever
 * spawned. Safe to call repeatedly, and callable from the deadline path (where
 * `process.exit` would otherwise skip `finally` and strand the two workers that
 * loop forever by design).
 */
function reapAll(): void {
  for (const groupPid of trackedGroups) {
    try { process.kill(-groupPid, 'SIGKILL') } catch { /* group already gone */ }
  }
  for (const child of children) {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  children.clear()
  for (const pid of trackedPids) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

function ok(condition: unknown, message: string): void {
  if (condition) { pass += 1; return }
  failures.push(message)
  console.error(`  FAIL - ${message}`)
}

function eq(actual: unknown, expected: unknown, message: string): void {
  ok(actual === expected, `${message} (actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)})`)
}

function observe(line: string): void {
  observations.push(line)
  console.log(`     observed: ${line}`)
}

interface BoundedRun {
  exit: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

interface Started { child: ChildProcess; done: Promise<BoundedRun>; reap: () => void }

/**
 * Spawn one bounded worker.
 *
 * `runner: 'node'` (default) is a DIRECT child, so `child.kill` really kills the
 * worker and the exit signal is observable — required by every arm that kills.
 * `runner: 'tsx'` is needed only for modules Node's native type stripping
 * refuses (`src/write-gate.ts` uses a constructor parameter property, which is
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`); tsx inserts its own process, so those
 * children get their own process group and are reaped by group signal.
 */
function startChild(scriptPath: string, env: Record<string, string>, runner: 'node' | 'tsx' = 'node'): Started {
  const detached = runner === 'tsx' && process.platform !== 'win32'
  const child = spawn(process.execPath, runner === 'tsx' ? [TSX_CLI, scriptPath] : [scriptPath], {
    cwd: TS_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached,
  })
  const groupPid = detached ? child.pid ?? null : null
  const reap = (): void => {
    if (groupPid !== null) {
      try { process.kill(-groupPid, 'SIGKILL'); return } catch { /* group already gone */ }
    }
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  children.add(child)
  if (child.pid) trackedPids.add(child.pid)
  if (groupPid !== null) trackedGroups.add(groupPid)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout?.on('data', (c: Buffer) => stdout.push(c))
  child.stderr?.on('data', (c: Buffer) => stderr.push(c))
  const done = new Promise<BoundedRun>((resolveRun) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      reap()
      settled = true
      resolveRun({ exit: null, signal: 'SIGKILL', stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), timedOut: true })
    }, CHILD_BUDGET_MS)
    const finish = (exit: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun({ exit, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), timedOut: false })
    }
    child.once('error', (error) => { stderr.push(Buffer.from(`spawn_error:${error.message}`)); finish(null, null) })
    child.once('close', (exit, signal) => { children.delete(child); finish(exit, signal) })
  })
  return { child, done, reap }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Wait for a readiness marker, bailing out early if a watched worker died. */
async function waitForReady(path: string, budgetMs: number, watch: ChildProcess[]): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    if (watch.some((c) => c.exitCode !== null || c.signalCode !== null)) return existsSync(path)
    await sleep(5)
  }
  return existsSync(path)
}

function lastJsonLine<T>(run: BoundedRun): T | null {
  const line = run.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).at(-1)
  return line ? (JSON.parse(line) as T) : null
}

/** Direct SQLite inspection, independent of the module-level ledger cache. */
function inspect(dbPath: string): {
  integrity: string
  events: number
  wishItems: number
  duplicateIdem: number
  /** Distinct (tenant_id, idem_key) pairs among the drill's append rows. */
  distinctIdemAppend: number
  seqs: number[]
  perTenant: Record<string, number>
} {
  const db = new Database(dbPath, { readonly: true })
  try {
    const integrity = db.pragma('integrity_check', { simple: true }) as string
    const events = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
    const wishItems = (db.prepare("SELECT COUNT(*) AS n FROM projection_items WHERE subject = 'wish_pool'").get() as { n: number }).n
    const duplicateIdem = (db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT tenant_id, idem_key, COUNT(*) AS c FROM events WHERE idem_key IS NOT NULL
        GROUP BY tenant_id, idem_key HAVING c > 1
      )`).get() as { n: number }).n
    const distinctIdemAppend = (db.prepare(
      "SELECT COUNT(DISTINCT tenant_id || char(31) || idem_key) AS n FROM events WHERE kind = 'drill.append' AND idem_key IS NOT NULL",
    ).get() as { n: number }).n
    const seqs = (db.prepare('SELECT seq FROM events ORDER BY seq').all() as Array<{ seq: number }>).map((r) => r.seq)
    const perTenant: Record<string, number> = {}
    for (const row of db.prepare("SELECT tenant_id, COUNT(*) AS n FROM events WHERE kind = 'drill.append' GROUP BY tenant_id").all() as Array<{ tenant_id: string; n: number }>) {
      perTenant[row.tenant_id] = row.n
    }
    return { integrity, events, wishItems, duplicateIdem, distinctIdemAppend, seqs, perTenant }
  } finally {
    db.close()
  }
}

/**
 * Fold integrity on an isolated copy: rebuild must reproduce the direct read.
 *
 * The copy MUST include the `-wal` and `-shm` sidecars. The ledger runs in WAL
 * mode and the victims here are SIGKILLed, so nothing checkpoints: copying only
 * `gotry-state.db` yields a file with no committed rows, and `before === after`
 * would then compare empty to empty and pass vacuously. The returned `events`
 * count lets every caller prove the copy actually saw the same rows the
 * in-place `inspect()` saw.
 */
function foldMatchesDirectRead(sourceDbPath: string, tenant: string): { match: boolean; events: number } {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'gotry-drill-fold-')))
  mkdirSync(join(scratch, 'gotry-state'), { recursive: true })
  const destDbPath = join(scratch, 'gotry-state', 'gotry-state.db')
  copyFileSync(sourceDbPath, destDbPath)
  for (const sidecar of ['-wal', '-shm']) {
    if (existsSync(sourceDbPath + sidecar)) copyFileSync(sourceDbPath + sidecar, destDbPath + sidecar)
  }
  const ledger: StateLedger = openDb(scratch, tenant)
  try {
    const events = ledger.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    const before = JSON.stringify({ wishes: ledger.readWishPool(), motivation: ledger.readMotivation() })
    ledger.rebuildProjections()
    const after = JSON.stringify({ wishes: ledger.readWishPool(), motivation: ledger.readMotivation() })
    return { match: before === after, events: events.n }
  } finally {
    ledger.close()
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Create the ledger file once from the parent, so cold-open races stay in A0. */
function seedLedgerFile(stateRoot: string, tenants: readonly string[]): void {
  for (const tenant of tenants) {
    const ledger = openDb(stateRoot, tenant)
    ledger.close()
  }
}

// ---- child fixture sources (plain node `.mts`, no tsx wrapper) --------------

/**
 * A0 worker: open a fresh ledger as soon as the module graph is loaded, with no
 * start gun. The natural jitter of N simultaneous `better-sqlite3` imports is
 * what clusters the processes on the very first open, which is the window the
 * race lives in; a file-based start gun lets the first winner finish the WAL
 * switch before the others arrive and the race stops reproducing.
 */
const COLD_OPEN_WORKER = `
const { openDb } = await import(process.env.STATE_LEDGER_URL)
let outcome
try {
  const ledger = openDb(process.env.STATE_ROOT, process.env.TENANT)
  ledger.insertEvent({ actor: 'drill:cold', kind: 'drill.cold', payload: {}, idemKey: 'cold:' + process.env.WORKER_ID })
  ledger.close()
  outcome = { ok: true }
} catch (error) {
  const frames = String(error?.stack ?? '').split('\\n').map((l) => l.trim())
  const ledgerFrame = frames.find((l) => l.includes('state-ledger.ts')) ?? ''
  outcome = { ok: false, code: error?.code ?? 'unknown', where: (frames[1] ?? '').replace(/^at /, '').split('/').pop() + ' <- ' + ledgerFrame.replace(/^at /, '').split('/').pop() }
}
console.log(JSON.stringify({ workerId: process.env.WORKER_ID, outcome }))
`

/**
 * A0b/A0c worker: start-gunned cold open against a ledger whose write lock is
 * held by the parent. Deterministic by construction — the child reports ready
 * BEFORE the parent takes the lock, and only opens after the start gun, so the
 * open is guaranteed to land inside the contended window.
 *
 * It reports the error SHAPE, which is the whole point of the D15-1 flip: a
 * typed `LedgerBusyError` (name + `code: 'GOTRY_LEDGER_BUSY'`) is admitted, a
 * raw SQLite code out of `openDb` is not.
 */
const BLOCKED_OPEN_WORKER = `
import { writeFileSync, existsSync } from 'node:fs'
const { openDb } = await import(process.env.STATE_LEDGER_URL)

writeFileSync(process.env.READY_PATH, 'ready')
while (!existsSync(process.env.GO_PATH)) await new Promise((r) => setTimeout(r, 2))

const started = Date.now()
let outcome
try {
  const ledger = openDb(process.env.STATE_ROOT, 'local')
  ledger.insertEvent({ actor: 'drill:blocked', kind: 'drill.blocked', payload: {}, idemKey: 'blocked:open' })
  const journal = String(ledger.db.pragma('journal_mode', { simple: true }) ?? '')
  ledger.close()
  outcome = { ok: true, journal }
} catch (error) {
  outcome = {
    ok: false,
    name: error?.name ?? 'unknown',
    code: error?.code ?? 'unknown',
    sqliteCode: error?.sqliteCode ?? null,
    attempts: error?.attempts ?? null,
  }
}
console.log(JSON.stringify({ outcome, elapsedMs: Date.now() - started }))
`

/**
 * A worker. `MODE=append` hammers the append-only event face with an
 * overlapping idem-key set; `MODE=wish` hammers the read-modify-write product
 * path with one shared wish name, retrying a bounded number of times on SQLite
 * contention codes the way a real multi-writer client would have to.
 */
const APPEND_WORKER = `
import { writeFileSync, existsSync } from 'node:fs'
const { openDb } = await import(process.env.STATE_LEDGER_URL)

const tenant = process.env.TENANT
const workerId = process.env.WORKER_ID
const ledger = openDb(process.env.STATE_ROOT, tenant)
ledger.db.pragma('busy_timeout = ' + process.env.BUSY_TIMEOUT_MS)

writeFileSync(process.env.READY_PATH, 'ready')
while (!existsSync(process.env.GO_PATH)) await new Promise((r) => setTimeout(r, 2))

const outcomes = { inserted: 0, deduped: 0, added: 0, updated: 0, retries: 0, errors: {} }
const note = (error) => {
  const code = error?.code ?? error?.constructor?.name ?? 'unknown'
  outcomes.errors[code] = (outcomes.errors[code] ?? 0) + 1
}
const contention = (error) => error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_BUSY_SNAPSHOT'

if (process.env.MODE === 'append') {
  for (const key of JSON.parse(process.env.IDEM_KEYS)) {
    try {
      const seq = ledger.insertEvent({ actor: 'drill:' + workerId, kind: 'drill.append', subjectId: key, payload: { worker: workerId, key }, idemKey: key })
      if (seq === null) outcomes.deduped += 1
      else outcomes.inserted += 1
    } catch (error) { note(error) }
  }
} else {
  const MAX_ATTEMPTS = 12
  for (let round = 0; round < Number(process.env.WISH_ROUNDS); round += 1) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const result = ledger.appendWish({ name: process.env.WISH_NAME, reason: 'drill ' + workerId, conditions: { month: '2026-11', worker: workerId } })
        if (result.added) outcomes.added += 1
        else outcomes.updated += 1
        break
      } catch (error) {
        if (contention(error) && attempt < MAX_ATTEMPTS - 1) {
          outcomes.retries += 1
          await new Promise((r) => setTimeout(r, 5 + attempt * 10))
          continue
        }
        note(error)
        break
      }
    }
  }
}

ledger.close()
console.log(JSON.stringify({ workerId, tenant, mode: process.env.MODE, outcomes }))
`

/** B worker: named crash points inside one transaction via the public surface. */
const CRASH_WORKER = `
import { writeFileSync } from 'node:fs'
const { openDb } = await import(process.env.STATE_LEDGER_URL)

const point = process.env.CRASH_POINT
const ledger = openDb(process.env.STATE_ROOT, 'local')
const die = () => { writeFileSync(process.env.MARKER_PATH, point); process.kill(process.pid, 'SIGKILL') }

if (point === 'before-transaction') die()

const run = ledger.db.transaction(() => {
  ledger.insertEvent({
    actor: 'drill:crash',
    kind: 'wish.added',
    subjectId: 'w-drill',
    payload: { wish: { wish_id: 'w-drill', name: 'drill wish', conditions: { month: '2026-11' } } },
    idemKey: 'drill:crash:wish',
  })
  if (point === 'after-event-insert') die()
  ledger.db.prepare("INSERT INTO projection_items (tenant_id, subject, item_id, doc, ord) VALUES (?, 'wish_pool', ?, ?, 0)")
    .run('local', 'w-drill', JSON.stringify({ wish_id: 'w-drill', name: 'drill wish', conditions: { month: '2026-11' } }))
  if (point === 'after-projection-write') die()
})
run()
if (point === 'after-commit') die()
ledger.close()
console.log(JSON.stringify({ point, completed: true }))
`

/** B worker: the real product write path, killed by the parent mid-flight. */
const PRODUCT_WRITE_WORKER = `
import { writeFileSync } from 'node:fs'
const { openDb } = await import(process.env.STATE_LEDGER_URL)
const ledger = openDb(process.env.STATE_ROOT, 'local')
writeFileSync(process.env.READY_PATH, 'ready')
for (let n = 0; ; n += 1) {
  try {
    ledger.appendWish({ name: 'drill wish ' + n, reason: 'product path', conditions: { month: '2026-11', n } })
    ledger.appendMotivationPatch({ weights: { comfort: 0.5 }, evidence: ['drill evidence ' + n] })
  } catch { /* the parent kills this worker mid-flight on purpose */ }
  await new Promise((r) => setTimeout(r, 1))
}
`

/** C worker: one of N dispatchers racing for a single queued outbox intent. */
const CLAIM_WORKER = `
import { writeFileSync, existsSync } from 'node:fs'
const { openDb } = await import(process.env.STATE_LEDGER_URL)
const { WriteGate } = await import(process.env.WRITE_GATE_URL)

const ledger = openDb(process.env.STATE_ROOT, 'local')
ledger.db.pragma('busy_timeout = 8000')
const gate = new WriteGate(ledger)
writeFileSync(process.env.READY_PATH, 'ready')
while (!existsSync(process.env.GO_PATH)) await new Promise((r) => setTimeout(r, 2))

let verdict
try {
  verdict = gate.claimForDispatch({ idemKey: process.env.IDEM_KEY, claimedBy: 'drill-worker-' + process.env.WORKER_ID, leaseUntil: process.env.LEASE_UNTIL })
} catch (error) {
  verdict = { ok: false, reason: 'threw:' + (error?.code ?? error?.message ?? 'unknown') }
}
ledger.close()
console.log(JSON.stringify({ workerId: process.env.WORKER_ID, verdict }))
`

/** D worker: continuous write load while the parent takes an online backup. */
const LOAD_WORKER = `
import { writeFileSync } from 'node:fs'
const { openDb } = await import(process.env.STATE_LEDGER_URL)
const ledger = openDb(process.env.STATE_ROOT, 'local')
ledger.db.pragma('busy_timeout = 8000')
writeFileSync(process.env.READY_PATH, 'ready')
for (let n = 0; ; n += 1) {
  try {
    ledger.insertEvent({ actor: 'drill:load', kind: 'drill.load', subjectId: 'load', payload: { n }, idemKey: 'load:' + n })
  } catch { /* contention is the point; the parent asserts safety */ }
  if (n % 32 === 0) await new Promise((r) => setTimeout(r, 1))
}
`

// The suite-level bound is a generous diagnostic backstop, not a performance
// assertion: every child already carries its own 10s bound, and this suite runs
// roughly 50 short-lived children. It is sized so a slow shared CI runner
// cannot turn a dormant-path drill red. `process.exit` skips `finally`, so the
// deadline path must reap and clean up itself — otherwise it would strand the
// product-write and load workers, which loop forever by design.
const suiteDeadline = setTimeout(() => {
  console.error(`DRILL BUDGET EXCEEDED (${SUITE_BUDGET_MS}ms) — reaping before exit`)
  try { reapAll() } catch { /* best effort */ }
  try { rmSync(workRoot, { recursive: true, force: true }) } catch { /* best effort */ }
  process.exit(1)
}, SUITE_BUDGET_MS)
suiteDeadline.unref()

const workRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gotry-drill-d15-')))

try {
  const coldOpenWorker = join(workRoot, 'cold-open-worker.mts')
  const blockedOpenWorker = join(workRoot, 'blocked-open-worker.mts')
  const appendWorker = join(workRoot, 'append-worker.mts')
  const crashWorker = join(workRoot, 'crash-worker.mts')
  const productWorker = join(workRoot, 'product-write-worker.mts')
  const claimWorker = join(workRoot, 'claim-worker.mts')
  const loadWorker = join(workRoot, 'load-worker.mts')
  writeFileSync(coldOpenWorker, COLD_OPEN_WORKER)
  writeFileSync(blockedOpenWorker, BLOCKED_OPEN_WORKER)
  writeFileSync(appendWorker, APPEND_WORKER)
  writeFileSync(crashWorker, CRASH_WORKER)
  writeFileSync(productWorker, PRODUCT_WRITE_WORKER)
  writeFileSync(claimWorker, CLAIM_WORKER)
  writeFileSync(loadWorker, LOAD_WORKER)

  // ---- A0: cold-open race on a fresh ledger -------------------------------
  console.log(`-- A0 cold-open race: N processes creating the same fresh ledger [${DRILL_LABEL}]`)
  {
    const WORKERS = 6
    const ROUNDS = 3
    let totalWorkers = 0
    let totalSucceeded = 0
    const allCodes: string[] = []
    const callsites = new Set<string>()

    for (let round = 0; round < ROUNDS; round += 1) {
      const stateRoot = realpathSync(mkdtempSync(join(workRoot, `cold-open-${round}-`)))
      const started: Started[] = []
      try {
        for (let w = 0; w < WORKERS; w += 1) {
          started.push(startChild(coldOpenWorker, {
            STATE_LEDGER_URL,
            STATE_ROOT: stateRoot,
            TENANT: 'local',
            WORKER_ID: String(w),
          }))
        }
        const runs = await Promise.all(started.map((s) => s.done))
        const reports = runs.map((r) => lastJsonLine<{ workerId: string; outcome: { ok: boolean; code?: string; where?: string } }>(r))
        ok(reports.every((r) => r !== null), `A0-1[r${round}] every cold-open worker reported (stderr=${runs.map((r) => r.stderr.slice(-120)).join('|')})`)
        const succeeded = reports.filter((r) => r?.outcome.ok === true).length
        const failed = reports.filter((r) => r?.outcome.ok === false)
        totalWorkers += WORKERS
        totalSucceeded += succeeded
        for (const report of failed) {
          if (report?.outcome.code) allCodes.push(report.outcome.code)
          if (report?.outcome.where) callsites.add(report.outcome.where)
        }

        // SAFETY must hold whatever the liveness outcome is.
        const dbPath = join(stateRoot, 'gotry-state', 'gotry-state.db')
        const state = inspect(dbPath)
        eq(state.integrity, 'ok', `A0-2[r${round}] SAFETY: the ledger file is intact after a cold-open race`)
        eq(state.duplicateIdem, 0, `A0-3[r${round}] SAFETY: no duplicated idem key survived the race`)
        const a0Fold = foldMatchesDirectRead(dbPath, 'local')
        eq(a0Fold.match, true, `A0-4[r${round}] SAFETY: fold rebuild equals the direct read after the race`)
        eq(a0Fold.events, state.events, `A0-4b[r${round}] the fold copy saw the same ${state.events} events as the in-place read (not a vacuous empty-vs-empty comparison)`)
        ok(succeeded >= 1, `A0-5[r${round}] at least one process created the ledger (${succeeded}/${WORKERS})`)
      } finally {
        for (const s of started) s.reap()
      }
    }

    // FLIPPED 2026-10-05 (D15-1 fixed, founder decision). Before the fix this
    // block only observed the defect, because WHICH process lost the cold-open
    // race was host-timing dependent (0 to 9 of 18 across local runs) and a raw
    // SQLITE_BUSY was the recorded baseline. `openDb` now installs
    // `busy_timeout` before anything contendable, retries the WAL switch and the
    // schema transaction under a wall-clock budget, and takes the schema lock
    // with BEGIN IMMEDIATE, so a lost race is no longer an outcome: it is either
    // a successful open or, if the whole budget is exhausted, the TYPED
    // `LedgerBusyError`. Both halves below are therefore GATED.
    //
    // IF THIS FLIPS BACK (a raw SQLITE_BUSY* reappears out of openDb), the fix
    // has regressed — do not re-soften this to an observation. The ordering
    // (`busy_timeout` first) and the IMMEDIATE schema transaction in
    // `src/state-ledger.ts openDb` are what make it hold.
    const distinctCodes = [...new Set(allCodes)].sort()
    observe(`A0 cold-open race, ${ROUNDS} rounds x ${WORKERS} processes on a fresh root: ${totalSucceeded}/${totalWorkers} opened successfully, ${allCodes.length} raised ${JSON.stringify(distinctCodes)} out of openDb`)
    eq(totalSucceeded, totalWorkers, `A0-6 every cold-open process opened the fresh ledger (${totalSucceeded}/${totalWorkers}); failures=${JSON.stringify(distinctCodes)} callsites=${JSON.stringify([...callsites])}`)
    ok(
      distinctCodes.every((c) => String(c) === 'GOTRY_LEDGER_BUSY'),
      `A0-7 the only admitted cold-open failure is the typed LedgerBusyError (observed ${JSON.stringify(distinctCodes)}). A raw SQLITE_BUSY/SQLITE_BUSY_SNAPSHOT here is the D15-1 regression, not a timing difference.`,
    )
  }

  // ---- A0b/A0c: deterministic D15-1 regression, no timing luck ------------
  console.log('-- A0b/A0c deterministic cold open against a held write lock')
  {
    /**
     * Run one start-gunned cold open while the parent holds a write lock.
     *
     * The ledger file is created here in ROLLBACK-JOURNAL mode on purpose: that
     * forces the child's `openDb` to perform the `journal_mode = WAL` switch,
     * which needs an exclusive lock, which is exactly the statement that threw
     * a raw SQLITE_BUSY before the fix (it ran before `busy_timeout` existed).
     * `holdMs = null` means "never release inside the open budget".
     */
    const openUnderHeldLock = async (label: string, holdMs: number | null): Promise<{ outcome: { ok: boolean; name?: string; code?: string; sqliteCode?: string | null; journal?: string }; elapsedMs: number } | null> => {
      const stateRoot = realpathSync(mkdtempSync(join(workRoot, `held-lock-${label}-`)))
      mkdirSync(join(stateRoot, 'gotry-state'), { recursive: true })
      const dbPath = join(stateRoot, 'gotry-state', 'gotry-state.db')
      const holder = new Database(dbPath)
      holder.pragma('journal_mode = delete')
      holder.exec('CREATE TABLE IF NOT EXISTS drill_lock_holder (x)')
      const readyPath = join(stateRoot, 'ready')
      const goPath = join(stateRoot, 'go')
      const started = startChild(blockedOpenWorker, { STATE_LEDGER_URL, STATE_ROOT: stateRoot, READY_PATH: readyPath, GO_PATH: goPath })
      let locked = false
      try {
        ok(await waitForReady(readyPath, 9_000, [started.child]), `${label} the opener reached the start gun before the lock was taken`)
        holder.exec('BEGIN IMMEDIATE')
        locked = true
        writeFileSync(goPath, 'go')
        if (holdMs !== null) {
          await sleep(holdMs)
          holder.exec('ROLLBACK')
          locked = false
        }
        const run = await started.done
        eq(run.timedOut, false, `${label} the opener finished inside its bound (stderr=${run.stderr.slice(-200)})`)
        return lastJsonLine<{ outcome: { ok: boolean; name?: string; code?: string; sqliteCode?: string | null; journal?: string }; elapsedMs: number }>(run)
      } finally {
        started.reap()
        if (locked) { try { holder.exec('ROLLBACK') } catch { /* already rolled back */ } }
        holder.close()
      }
    }

    // A0b: the lock is released well inside the open budget -> the open must win.
    const released = await openUnderHeldLock('A0b', 400)
    ok(released !== null, 'A0b the opener reported an outcome')
    eq(released?.outcome.ok, true, `A0b SAFETY+LIVENESS a cold open that starts while another process holds the write lock now waits and succeeds (outcome=${JSON.stringify(released?.outcome)}). Before the fix this threw a raw SQLITE_BUSY out of pragma('journal_mode = WAL') because busy_timeout was installed after it.`)
    eq(String(released?.outcome.journal ?? '').toLowerCase(), 'wal', 'A0b the opener really completed the WAL switch it had to wait for')

    // A0c: the lock is never released -> the ONE admitted failure shape.
    const exhausted = await openUnderHeldLock('A0c', null)
    ok(exhausted !== null, 'A0c the opener reported an outcome')
    eq(exhausted?.outcome.ok, false, `A0c with the write lock never released, the open must not claim success (outcome=${JSON.stringify(exhausted?.outcome)})`)
    eq(exhausted?.outcome.name, 'LedgerBusyError', `A0c exhaustion surfaces the TYPED error, not a raw SQLite error (name=${JSON.stringify(exhausted?.outcome.name)})`)
    eq(exhausted?.outcome.code, 'GOTRY_LEDGER_BUSY', `A0c the typed error carries the stable code (code=${JSON.stringify(exhausted?.outcome.code)})`)
    ok(
      typeof exhausted?.outcome.sqliteCode === 'string' && /^SQLITE_(BUSY|PROTOCOL)/.test(exhausted.outcome.sqliteCode),
      `A0c the typed error keeps the underlying SQLite code for diagnosis (sqliteCode=${JSON.stringify(exhausted?.outcome.sqliteCode)})`,
    )
    observe(`A0b/A0c deterministic held-lock opens: released-at-400ms open succeeded in ${released?.elapsedMs}ms; never-released open gave up with the typed error in ${exhausted?.elapsedMs}ms`)
  }

  // ---- A: N concurrent writers, one tenant and two tenants ----------------
  console.log('-- A N concurrent writers: idem dedupe / no lost updates / tenant isolation')
  {
    const WORKERS = 3
    const KEYS = 16
    const WISH_ROUNDS = 2
    const WISH_NAME = 'drill shared wish'
    const BUSY_TIMEOUT_MS = 2_000
    const idemKeys = Array.from({ length: KEYS }, (_, i) => `drill:key:${i}`)

    const runBatch = async (
      stateRoot: string,
      tenants: readonly string[],
      mode: 'append' | 'wish',
    ): Promise<{ inserted: number; deduped: number; added: number; updated: number; retries: number; errors: Record<string, number>; attempts: number; perTenantSuccess: Record<string, number> }> => {
      const goPath = join(stateRoot, `go-${mode}`)
      const started: Started[] = []
      const readyPaths: string[] = []
      const totals = {
        inserted: 0, deduped: 0, added: 0, updated: 0, retries: 0,
        errors: {} as Record<string, number>, attempts: 0,
        /** Per-tenant successful writes; lets safety assertions stay exact without assuming liveness. */
        perTenantSuccess: {} as Record<string, number>,
      }
      try {
        for (const tenant of tenants) {
          for (let w = 0; w < WORKERS; w += 1) {
            const readyPath = join(stateRoot, `ready-${mode}-${tenant}-${w}`)
            readyPaths.push(readyPath)
            started.push(startChild(appendWorker, {
              STATE_LEDGER_URL,
              STATE_ROOT: stateRoot,
              TENANT: tenant,
              WORKER_ID: `${tenant}-${w}`,
              MODE: mode,
              IDEM_KEYS: JSON.stringify(idemKeys),
              WISH_ROUNDS: String(WISH_ROUNDS),
              WISH_NAME,
              BUSY_TIMEOUT_MS: String(BUSY_TIMEOUT_MS),
              READY_PATH: readyPath,
              GO_PATH: goPath,
            }))
          }
        }
        let allReady = true
        for (const readyPath of readyPaths) allReady = (await waitForReady(readyPath, 9_000, started.map((s) => s.child))) && allReady
        ok(allReady, `A[${tenants.length}t/${mode}] every writer process reached the callsite before the start gun`)
        writeFileSync(goPath, 'go')
        const runs = await Promise.all(started.map((s) => s.done))
        for (const run of runs) {
          eq(run.timedOut, false, `A[${tenants.length}t/${mode}] worker finished inside its bound`)
          const report = lastJsonLine<{ tenant: string; outcomes: { inserted: number; deduped: number; added: number; updated: number; retries: number; errors: Record<string, number> } }>(run)
          ok(report !== null, `A[${tenants.length}t/${mode}] worker emitted a report (exit=${run.exit} stderr=${run.stderr.slice(-300)})`)
          if (!report) continue
          totals.inserted += report.outcomes.inserted
          totals.deduped += report.outcomes.deduped
          totals.added += report.outcomes.added
          totals.updated += report.outcomes.updated
          totals.retries += report.outcomes.retries
          const success = mode === 'append'
            ? report.outcomes.inserted + report.outcomes.deduped
            : report.outcomes.added + report.outcomes.updated
          totals.perTenantSuccess[report.tenant] = (totals.perTenantSuccess[report.tenant] ?? 0) + success
          for (const [code, n] of Object.entries(report.outcomes.errors)) totals.errors[code] = (totals.errors[code] ?? 0) + n
        }
        totals.attempts = (mode === 'append' ? KEYS : WISH_ROUNDS) * WORKERS * tenants.length
        return totals
      } finally {
        for (const s of started) s.reap()
      }
    }

    for (const tenants of [['local'], ['local', 'tenant-b']] as const) {
      const stateRoot = realpathSync(mkdtempSync(join(workRoot, `append-${tenants.length}t-`)))
      seedLedgerFile(stateRoot, tenants)
      const dbPath = join(stateRoot, 'gotry-state', 'gotry-state.db')
      const label = `A[${tenants.length}t]`

      // SAFETY vs LIVENESS: the gating assertions below are the ones that must
      // hold on any host at any speed. How many attempts a slow 2-vCPU runner
      // gets through, and which SQLite contention codes it sees, is liveness —
      // reported through observe(), never gated, so a dormant unadmitted path
      // cannot flake the regression red.
      const CONTENTION_CODES = ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_CANTOPEN', 'SQLITE_PROTOCOL', 'SQLITE_IOERR_SHMOPEN']
      const onlyContention = (errors: Record<string, number>): boolean => Object.keys(errors).every((c) => CONTENTION_CODES.includes(c))

      // Arm 1: append-only event face (the admitted write shape).
      const appendTotals = await runBatch(stateRoot, tenants, 'append')
      const appendErrors = Object.values(appendTotals.errors).reduce((a, b) => a + b, 0)
      const state = inspect(dbPath)
      eq(state.integrity, 'ok', `${label} SAFETY integrity_check ok after ${WORKERS * tenants.length} concurrent writer processes`)
      eq(state.duplicateIdem, 0, `${label} SAFETY no (tenant_id, idem_key) pair appears twice: the UNIQUE index held across processes`)
      eq(state.distinctIdemAppend, appendTotals.inserted, `${label} SAFETY the ledger holds exactly the ${appendTotals.inserted} appends the workers believe they inserted — no lost update and no phantom row`)
      eq(appendTotals.inserted + appendTotals.deduped + appendErrors, appendTotals.attempts, `${label} SAFETY every append attempt is an insert, a dedupe or a named error — no silent loss`)
      ok(appendTotals.inserted <= KEYS * tenants.length, `${label} SAFETY the insert count never exceeds the distinct key space (${appendTotals.inserted} <= ${KEYS * tenants.length})`)
      ok(onlyContention(appendTotals.errors), `${label} SAFETY any append failure is a known SQLite contention code, never a logic error (codes=${JSON.stringify(appendTotals.errors)})`)
      for (const tenant of tenants) {
        ok((state.perTenant[tenant] ?? 0) <= KEYS, `${label} SAFETY tenant ${tenant} never holds more than its own ${KEYS} append rows (${state.perTenant[tenant] ?? 0})`)
      }
      if (appendErrors === 0) {
        eq(appendTotals.inserted, KEYS * tenants.length, `${label} with zero contention errors, every distinct idem key landed exactly once per tenant`)
        for (const tenant of tenants) {
          eq(state.perTenant[tenant], KEYS, `${label} with zero contention errors, tenant ${tenant} owns exactly its own ${KEYS} append rows`)
        }
      } else {
        observe(`${label} LIVENESS the append-only face hit ${appendErrors} contention errors on this host ${JSON.stringify(appendTotals.errors)}; safety invariants still held, so the key-space completeness check was reported instead of gated`)
      }

      // Arm 2: read-modify-write product path, one shared wish name.
      const wishTotals = await runBatch(stateRoot, tenants, 'wish')
      const wishErrors = Object.values(wishTotals.errors).reduce((a, b) => a + b, 0)
      eq(wishTotals.added + wishTotals.updated + wishErrors, wishTotals.attempts, `${label} SAFETY every wish attempt is accounted for (added, updated, or a named error)`)
      ok(onlyContention(wishTotals.errors), `${label} SAFETY any unrecovered wish failure is a known SQLite contention code (codes=${JSON.stringify(wishTotals.errors)})`)
      ok(wishTotals.added <= tenants.length, `${label} SAFETY at most one "added" per tenant — the rest must see the existing row (${wishTotals.added} <= ${tenants.length})`)
      eq(inspect(dbPath).integrity, 'ok', `${label} SAFETY integrity_check still ok after the read-modify-write batch`)
      // FLIPPED 2026-10-05 (D15-2 fixed, founder decision). `appendWish` and the
      // other read-first ledger transactions now run BEGIN IMMEDIATE, so the
      // read-then-upgrade shape that returned SQLITE_BUSY_SNAPSHOT *without ever
      // calling the busy handler* no longer exists; contention becomes a
      // busy-handler wait, with a bounded in-ledger retry behind it. The worker
      // keeps its caller-side retry loop purely as an INSTRUMENT: it now has to
      // count zero. Before the fix six processes needed 6 to 9 retries to finish
      // 12 attempts, and an earlier run left 8 of 12 unrecovered.
      eq(wishTotals.errors ? Object.keys(wishTotals.errors).length : 0, 0, `${label} D15-2 the read-modify-write face leaves nothing unrecovered (${wishErrors} errors ${JSON.stringify(wishTotals.errors)})`)
      eq(wishTotals.retries, 0, `${label} D15-2 the read-modify-write face needs ZERO caller-side retries now that the ledger takes the write lock up front (${wishTotals.retries} retries over ${wishTotals.attempts} attempts). IF THIS FLIPS BACK, a read-first ledger transaction lost its .immediate() — see the transaction audit table above runWrite in src/state-ledger.ts.`)

      for (const tenant of tenants) {
        const ledger = openDb(stateRoot, tenant)
        try {
          // A tenant whose every attempt lost the race legitimately has no row.
          const expectedWishRows = (wishTotals.perTenantSuccess[tenant] ?? 0) > 0 ? 1 : 0
          const rows = ledger.readWishPool().filter((w) => w.name === WISH_NAME)
          eq(rows.length, expectedWishRows, `${label} SAFETY tenant ${tenant} has exactly ${expectedWishRows} projection row(s) for the shared wish name (${wishTotals.perTenantSuccess[tenant] ?? 0} successful writes)`)
          if (expectedWishRows === 1) {
            eq(rows[0]?.wish_id, makeWishId(WISH_NAME), `${label} SAFETY tenant ${tenant} uses the stable name-derived wish id`)
          }
          const appends = ledger.readEvents('drill.append', 1_000)
          eq(appends.length, state.perTenant[tenant] ?? 0, `${label} SAFETY tenant ${tenant} reads exactly the rows the database holds for it`)
          eq(appends.every((r) => r.tenant_id === tenant), true, `${label} SAFETY no foreign tenant row leaks into the ${tenant} read`)
        } finally {
          ledger.close()
        }
      }

      const aFold = foldMatchesDirectRead(dbPath, 'local')
      eq(aFold.match, true, `${label} fold rebuild reproduces the direct read (the log stays the authority)`)
      eq(aFold.events, inspect(dbPath).events, `${label} the fold copy saw the same event count as the in-place read (not a vacuous comparison)`)
      observe(`${label} append-only face, ${WORKERS * tenants.length} processes: ${appendTotals.inserted} inserted, ${appendTotals.deduped} deduped, ${appendErrors} errors`)
      observe(`${label} read-modify-write face, ${WORKERS * tenants.length} processes: ${wishTotals.added} added, ${wishTotals.updated} updated, ${wishTotals.retries} caller-side retries needed on SQLITE_BUSY/SQLITE_BUSY_SNAPSHOT, ${wishErrors} unrecovered`)
    }
  }

  // ---- B: SIGKILL mid-transaction, reopen, all-or-nothing -----------------
  console.log('-- B crash drill: SIGKILL at named transaction points and at varied moments')
  {
    const POINTS = ['before-transaction', 'after-event-insert', 'after-projection-write', 'after-commit'] as const
    const ITERATIONS = 2
    for (const point of POINTS) {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const stateRoot = realpathSync(mkdtempSync(join(workRoot, `crash-${point}-${iteration}-`)))
        const markerPath = join(stateRoot, 'marker')
        const run = await startChild(crashWorker, { STATE_LEDGER_URL, STATE_ROOT: stateRoot, MARKER_PATH: markerPath, CRASH_POINT: point }).done
        const tag = `B[${point}#${iteration}]`
        eq(run.timedOut, false, `${tag} crash worker finished inside its bound`)
        eq(run.signal, 'SIGKILL', `${tag} the worker really died by SIGKILL (signal=${run.signal} exit=${run.exit} stderr=${run.stderr.slice(-200)})`)
        ok(existsSync(markerPath), `${tag} the kill landed at the intended point`)
        const dbPath = join(stateRoot, 'gotry-state', 'gotry-state.db')
        const state = inspect(dbPath)
        eq(state.integrity, 'ok', `${tag} integrity_check ok after SIGKILL`)
        if (point === 'after-commit') {
          eq(state.events, 1, `${tag} the committed event survives`)
          eq(state.wishItems, 1, `${tag} the committed projection row survives`)
        } else {
          eq(state.events, 0, `${tag} all-or-nothing: no uncommitted event survived`)
          eq(state.wishItems, 0, `${tag} all-or-nothing: no uncommitted projection row survived`)
        }
        const bFold = foldMatchesDirectRead(dbPath, 'local')
        eq(bFold.match, true, `${tag} fold rebuild equals the direct read after reopen`)
        eq(bFold.events, state.events, `${tag} the fold copy saw the same ${state.events} events as the in-place read — the -wal sidecar really travelled with the copy, so this is not empty-vs-empty`)
        if (point === 'after-commit' && iteration === 0) {
          observe(`B[${point}] the fold copy of a SIGKILLed ledger carried ${bFold.events} committed event(s) — proof the WAL sidecar travelled with the copy, so fold==direct-read is a real comparison and not empty-vs-empty`)
        }
      }
    }

    // Timing-varied kills on the real product write path (deterministic seed).
    let seed = 20261004
    const nextDelay = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return 60 + (seed % 140) }
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const stateRoot = realpathSync(mkdtempSync(join(workRoot, `product-crash-${iteration}-`)))
      const readyPath = join(stateRoot, 'ready')
      const started = startChild(productWorker, { STATE_LEDGER_URL, STATE_ROOT: stateRoot, READY_PATH: readyPath })
      const tag = `B-product#${iteration}`
      try {
        ok(await waitForReady(readyPath, 9_000, [started.child]), `${tag} the writer reached its loop`)
        await sleep(nextDelay())
        started.child.kill('SIGKILL')
        const run = await started.done
        eq(run.signal, 'SIGKILL', `${tag} the writer died by SIGKILL mid-flight (exit=${run.exit})`)
      } finally {
        started.reap()
      }
      // The worker is a direct child and is now reaped, so the file is stable.
      const dbPath = join(stateRoot, 'gotry-state', 'gotry-state.db')
      eq(inspect(dbPath).integrity, 'ok', `${tag} integrity_check ok after an unannounced kill`)
      const ledger = openDb(stateRoot, 'local')
      let directWishes = 0
      let addedEvents = 0
      try {
        directWishes = ledger.readWishPool().length
        addedEvents = ledger.readEvents('wish.added', 10_000).length
      } finally {
        ledger.close()
      }
      eq(directWishes, addedEvents, `${tag} every committed wish.added has exactly one projection row (${directWishes} vs ${addedEvents})`)
      ok(addedEvents > 0, `${tag} the writer committed real work before the kill (${addedEvents} wishes) — a zero here would make the rest of this arm vacuous`)
      const pFold = foldMatchesDirectRead(dbPath, 'local')
      eq(pFold.match, true, `${tag} fold rebuild equals the direct read (no torn write survived)`)
      eq(pFold.events, inspect(dbPath).events, `${tag} the fold copy saw the same event count as the in-place read (not a vacuous comparison)`)
      observe(`${tag} ${addedEvents} wishes were committed before the kill; reopen found no partial write`)
    }
  }

  // ---- C: stale-claim rejection with fencing under N-process contention ---
  console.log('-- C stale-claim rejection: N dispatchers, fencing token, forward-only status')
  {
    const stateRoot = realpathSync(mkdtempSync(join(workRoot, 'claim-')))
    const idemKey = 'drill:claim:intent'
    const fields: WriteRequestFields = {
      tenantId: 'local',
      actorRef: 'actor:drill-host',
      principalRef: 'principal:drill-traveler',
      seam: 'hotelbyte-hotel-book-confirm',
      supplier: 'fixture-supplier@drill',
      productRef: 'offer:drill',
      travelTerms: 'drill:2nights:2guests',
      amountTotal: 12_345,
      currency: 'CNY',
      commissionDisclosure: 'none',
      validUntil: new Date(Date.now() + 600_000).toISOString(),
      presentationKey: 'card:drill:v1',
    }
    {
      const seed = openDb(stateRoot, 'local')
      try {
        const gate = new WriteGate(seed)
        seed.requestPendingWrite({ idemKey, seam: fields.seam, payload: {} })
        const prepared = gate.preparePresentation({ idemKey, fields, expiresAt: new Date(Date.now() + 600_000).toISOString() })
        ok(prepared.ok, 'C0 the drill seeded a prepared challenge')
        if (!prepared.ok) throw new Error(`prepare failed: ${prepared.reason}`)
        const confirmed = gate.trustedHostConfirm({ challengeId: prepared.card.challenge_id, deliveryNonce: prepared.trustedDelivery.deliveryNonce, actorRef: fields.actorRef, seam: fields.seam })
        ok(confirmed.ok, 'C0 the drill seeded a trusted-host confirmation')
        if (!confirmed.ok) throw new Error(`confirm failed: ${confirmed.reason}`)
        const enqueued = gate.consumeApprovalAndEnqueue({ receiptId: confirmed.receiptId, idemKey, fields, effectName: 'drill-hotel-book' })
        ok(enqueued.ok, `C0 the drill seeded exactly one queued outbox intent (${enqueued.ok ? 'ok' : enqueued.reason})`)
      } finally {
        seed.close()
      }
    }

    const WORKERS = 4
    const goPath = join(stateRoot, 'go')
    const started: Started[] = []
    try {
      const readyPaths: string[] = []
      for (let w = 0; w < WORKERS; w += 1) {
        const readyPath = join(stateRoot, `ready-${w}`)
        readyPaths.push(readyPath)
        started.push(startChild(claimWorker, {
          STATE_LEDGER_URL,
          WRITE_GATE_URL,
          STATE_ROOT: stateRoot,
          IDEM_KEY: idemKey,
          WORKER_ID: String(w),
          LEASE_UNTIL: new Date(Date.now() + 60_000).toISOString(),
          READY_PATH: readyPath,
          GO_PATH: goPath,
        }, 'tsx'))
      }
      let allReady = true
      for (const readyPath of readyPaths) allReady = (await waitForReady(readyPath, 9_000, started.map((s) => s.child))) && allReady
      ok(allReady, `C1 all ${WORKERS} dispatcher processes reached the claim callsite`)
      writeFileSync(goPath, 'go')
      const runs = await Promise.all(started.map((s) => s.done))
      const verdicts = runs.map((run) => lastJsonLine<{ workerId: string; verdict: { ok: boolean; reason?: string; attempt_id?: string; fencing_token?: number } }>(run))
      ok(verdicts.every((v) => v !== null), `C2 every dispatcher reported a verdict (stderr=${runs.map((r) => r.stderr.slice(-160)).join('|')})`)
      const winners = verdicts.filter((v) => v?.verdict.ok === true)
      const losers = verdicts.filter((v) => v?.verdict.ok === false)
      eq(winners.length, 1, `C3 exactly one of ${WORKERS} dispatcher processes wins the claim (losers=${JSON.stringify(losers.map((l) => l?.verdict.reason))})`)
      eq(losers.length, WORKERS - 1, 'C4 every loser is refused')
      // A loser may also surface a raw SQLite contention code: `claimForDispatch`
      // uses an IMMEDIATE transaction, so a busy-timeout exhaustion throws rather
      // than returning a verdict. That is a liveness outcome, not a correctness
      // one — what must hold is that no loser claimed anything, which C8..C10
      // assert against the database. So accept the throw here and report it.
      const loserReasons = losers.map((l) => String(l?.verdict.reason))
      const verdictReasons = ['lost-race', 'not-claimable', 'missing-intent']
      ok(
        loserReasons.every((r) => verdictReasons.includes(r) || /^threw:SQLITE_(BUSY|BUSY_SNAPSHOT|CANTOPEN|PROTOCOL)/.test(r)),
        `C5 every loser either got a closed-set verdict or threw a known SQLite contention code — never a partial claim (${JSON.stringify(loserReasons)})`,
      )
      const threwLosers = loserReasons.filter((r) => r.startsWith('threw:'))
      if (threwLosers.length > 0) {
        observe(`C LIVENESS ${threwLosers.length} of ${WORKERS - 1} losers surfaced a raw SQLite code instead of a typed verdict ${JSON.stringify(threwLosers)} — the IMMEDIATE claim transaction exhausted its busy timeout. Correctness held (exactly one claim row and one claim event below). claimForDispatch already takes the write lock up front, so this is pure busy-timeout exhaustion in write-gate.ts, not the D15-2 read-then-upgrade shape that was fixed in the ledger.`)
      }
      eq(winners[0]?.verdict.fencing_token, 1, 'C6 the winner persisted a fencing token before any outbound call')
      ok(typeof winners[0]?.verdict.attempt_id === 'string', 'C7 the winner persisted an immutable attempt_id')

      const verify = openDb(stateRoot, 'local')
      try {
        const intents = verify.db.prepare('SELECT dispatch_status, attempt_id, fencing_token FROM write_effect_intents WHERE tenant_id = ? AND idem_key = ?').all('local', idemKey) as Array<{ dispatch_status: string; attempt_id: string | null; fencing_token: number | null }>
        eq(intents.length, 1, 'C8 exactly one outbox row exists for the contested intent')
        eq(intents[0]?.dispatch_status, 'dispatching', 'C9 the single row is dispatching')
        const claimEvents = verify.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'writegate.dispatch_claimed' AND tenant_id = ?").get('local') as { n: number }
        eq(claimEvents.n, 1, 'C10 exactly one claim event landed (the losers wrote nothing)')

        const retryGate = new WriteGate(verify)
        const stale = retryGate.claimForDispatch({ idemKey, claimedBy: 'drill-stale-worker', leaseUntil: new Date(Date.now() + 60_000).toISOString() })
        ok(stale.ok === false && stale.reason === 'not-claimable', `C11 a stale dispatcher retrying after the winner is refused (${stale.ok ? 'claimed!' : stale.reason})`)

        verify.db.prepare('UPDATE write_effect_intents SET lease_until = ? WHERE tenant_id = ? AND idem_key = ?').run(new Date(Date.now() - 60_000).toISOString(), 'local', idemKey)
        const afterExpiry = retryGate.claimForDispatch({ idemKey, claimedBy: 'drill-lease-expired', leaseUntil: new Date(Date.now() + 60_000).toISOString() })
        ok(afterExpiry.ok === false && afterExpiry.reason === 'not-claimable', `C12 an expired lease does not make the intent claimable again (${afterExpiry.ok ? 'claimed!' : afterExpiry.reason})`)

        let reversalBlocked = false
        try {
          verify.db.prepare("UPDATE write_effect_intents SET dispatch_status = 'queued' WHERE tenant_id = ? AND idem_key = ?").run('local', idemKey)
        } catch (error) {
          reversalBlocked = /forward-only/.test(error instanceof Error ? error.message : String(error))
        }
        eq(reversalBlocked, true, 'C13 a direct SQL reset to queued is refused by the storage-level trigger, not by an application if')

        const tenantB = openDb(stateRoot, 'tenant-b')
        try {
          const gateB = new WriteGate(tenantB)
          const crossTenant = gateB.claimForDispatch({ idemKey, claimedBy: 'drill-tenant-b', leaseUntil: new Date(Date.now() + 60_000).toISOString() })
          ok(crossTenant.ok === false && crossTenant.reason === 'missing-intent', `C14 tenant-b claiming the same idem_key sees no intent: cross-tenant affected rows = 0 (${crossTenant.ok ? 'claimed!' : crossTenant.reason})`)
        } finally {
          tenantB.close()
        }
        observe('C fencing_token is monotonic only vacuously: the forward-only trigger makes a second claim impossible, so no token above 1 is observable today. A real multi-machine lease handoff would be the first thing to exercise it.')
      } finally {
        verify.close()
      }
      eq(inspect(join(stateRoot, 'gotry-state', 'gotry-state.db')).integrity, 'ok', 'C15 integrity_check ok after the claim race')
    } finally {
      for (const s of started) s.reap()
    }
  }

  // ---- D: online backup under write load -> restore -> fold ---------------
  console.log('-- D SQLite online backup taken under live write load, then restored')
  {
    const stateRoot = realpathSync(mkdtempSync(join(workRoot, 'backup-')))
    seedLedgerFile(stateRoot, ['local'])
    const readyPath = join(stateRoot, 'ready')
    const dbPath = join(stateRoot, 'gotry-state', 'gotry-state.db')
    const backupPath = join(workRoot, 'online-backup.db')
    const started = startChild(loadWorker, { STATE_LEDGER_URL, STATE_ROOT: stateRoot, READY_PATH: readyPath })
    let backupResult: { totalPages: number; remainingPages: number } | null = null
    try {
      ok(await waitForReady(readyPath, 9_000, [started.child]), 'D1 the load writer reached its loop')
      await sleep(150)
      const reader = new Database(dbPath)
      try {
        reader.pragma('busy_timeout = 8000')
        backupResult = await reader.backup(backupPath) as { totalPages: number; remainingPages: number }
      } finally {
        reader.close()
      }
      ok(backupResult !== null && backupResult.remainingPages === 0, `D2 the online backup completed while writes were in flight (${JSON.stringify(backupResult)})`)
    } finally {
      started.reap()
      await started.done
    }

    // Restore = copy + checksum verification, mirroring the state-repair discipline.
    const restoreRoot = realpathSync(mkdtempSync(join(workRoot, 'restore-')))
    mkdirSync(join(restoreRoot, 'gotry-state'), { recursive: true })
    const restoredPath = join(restoreRoot, 'gotry-state', 'gotry-state.db')
    const sha256Of = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
    // The checksum must be taken BEFORE the restore, or comparing a file to its
    // own copy is tautological. The meaningful facts are: the transfer preserved
    // the snapshot, the restore did NOT come from the still-advancing live file,
    // and a tampered snapshot is detectable.
    const backupSha = sha256Of(backupPath)
    const liveSha = sha256Of(dbPath)
    copyFileSync(backupPath, restoredPath)
    eq(sha256Of(restoredPath), backupSha, 'D3a the restore preserved the snapshot byte for byte (transfer integrity)')
    ok(sha256Of(restoredPath) !== liveSha, 'D3b the restored file is the SNAPSHOT, not the live source that kept being written after the backup')
    const tamperedPath = join(restoreRoot, 'tampered-snapshot.db')
    const tampered = readFileSync(backupPath)
    tampered[Math.floor(tampered.length / 2)] ^= 0xff
    writeFileSync(tamperedPath, tampered)
    ok(sha256Of(tamperedPath) !== backupSha, 'D3c a single flipped byte changes the checksum, so the restore gate can detect a tampered snapshot')

    const source = inspect(dbPath)
    const restored = inspect(restoredPath)
    eq(restored.integrity, 'ok', 'D4 the restored snapshot passes integrity_check')
    eq(source.integrity, 'ok', 'D5 the live source still passes integrity_check after being backed up under load')
    ok(restored.events > 0, `D6 the snapshot captured real rows (${restored.events})`)
    ok(restored.events <= source.events, `D7 the snapshot is not ahead of its source (${restored.events} <= ${source.events})`)
    eq(restored.duplicateIdem, 0, 'D8 no duplicated idem key survived into the snapshot')
    eq(restored.seqs.every((seq, i) => source.seqs[i] === seq), true, 'D9 the snapshot event sequence is a prefix of the source: a consistent point in the log')
    const dFold = foldMatchesDirectRead(restoredPath, 'local')
    eq(dFold.match, true, 'D10 the restored fold equals the restored direct read (the snapshot point is self-consistent)')
    eq(dFold.events, restored.events, `D10b the fold copy saw all ${restored.events} restored events (not a vacuous comparison)`)
    observe(`D online backup under load: ${restored.events} of ${source.events} events captured at the snapshot point, pages=${JSON.stringify(backupResult)}`)
  }

  // ---- E: the replication dependency decision stays open ------------------
  console.log('-- E replication dependencies: absence pinned, not assumed')
  {
    for (const dependency of ['litestream', 'cr-sqlite', '@vlcn.io/crsqlite']) {
      let resolved = true
      try { await import(dependency) } catch { resolved = false }
      eq(resolved, false, `E ${dependency} is NOT installed — recorded as "needs real trigger + dependency decision", never as proven`)
    }
    observe('E Litestream (streaming backup) and cr-sqlite (multi-writer CRDT replication) remain unevaluated: they need the real D-15 trigger plus a founder dependency decision. The drill proved only the stock better-sqlite3 online-backup path.')
  }
} finally {
  clearTimeout(suiteDeadline)
  reapAll()
  rmSync(workRoot, { recursive: true, force: true })
}

// Leak discipline: checked against the pid set, which is never cleared, so the
// assertion cannot be satisfied by an emptied collection. Two of the workers
// here loop forever by design (product-write and load), so a missed reap is a
// real runaway process, not a cosmetic issue.
{
  const survivors = [...trackedPids].filter((pid) => {
    try { process.kill(pid, 0); return true } catch { return false }
  })
  eq(survivors.length, 0, `Z no process this drill spawned survives (survivors=${JSON.stringify(survivors)})`)
  observe(`Z tracked ${trackedPids.size} spawned pids across all arms; ${survivors.length} survived the final reap`)
}

console.log(`\nDRILL #275 MULTI-WRITER (${DRILL_LABEL}): ${pass} ok, ${failures.length} fail`)
console.log('OBSERVATIONS (facts, not acceptance):')
for (const line of observations) console.log(`  - ${line}`)
console.log('EVIDENCE BOUNDARY: mkdtemp fixtures and synthetic workers only. No second real user,')
console.log('no multi-machine deployment, no AaaS initiative. Tracking issue #275 was closed on')
console.log('2026-10-05 as deferred, not completed; no replication or multi-writer path is enabled by')
console.log('this drill. The D15-1/D15-2 ledger defects it found ARE fixed and are gated above.')
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILURE(S):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
