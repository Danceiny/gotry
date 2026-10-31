/**
 * Capacity probe of the AaaS tier (docs/rfc/aaas-rfc.md §6 switch trigger 4; docs/ops/aaas-capacity-baseline.md).
 *
 * The RFC's fallback to a different storage design depends on "tenants per node times the cost of a file", and until now
 * nothing measured either. This probe measures, on the machine it runs on and with the real code, the three things that
 * decide how many tenants a replica can hold:
 *
 *   density  what N open tenants cost in resident memory, file descriptors and time to open, and whether closing them
 *            gives the handles back
 *   restore  how long it takes a new owner to take a tenant over from the durable copy, as the ledger grows
 *   planner  what one booted planner process tree costs idle, and how long it takes to boot (no model call is made)
 *
 * It is a measurement, not a verdict. The durable store here is a local directory, so restore latency excludes the
 * network and the object store; the planner is booted against an address nothing listens on. A node that matters
 * has to be probed itself (docs/ops/aaas-capacity-baseline.md says what is still a human probe).
 *
 *   cd ts && npx tsx scripts/tenant-capacity-probe.ts [--smoke] [--json <file>] [--only density|restore|planner] [--tenants 1,10,100] [--sizes-mb 1,10] [--no-planner]
 *
 * `--smoke` is the regression form: small numbers, and it asserts correctness only (everything opened, handles returned,
 * a restored ledger holds what was written), never a speed.
 */

import assert from 'node:assert/strict'
import { cpus, platform, arch, totalmem } from 'node:os'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { createRealRunPort } from '../src/booking-surface/dsh-planner.ts'
import { DirDurableStore } from '../src/tenant-state/durable-store.ts'
import { deriveLedgerTenantId } from '../src/tenant-state/ids.ts'
import { SqliteLeaseStore } from '../src/tenant-state/lease-store.ts'
import { TenantRouter } from '../src/tenant-state/tenant-router.ts'
import { parsePsTable, PS_ARGS, treeOf } from '../src/tenant-seam/process-governor.ts'

const args = process.argv.slice(2)
const flag = (name: string): boolean => args.includes(name)
const value = (name: string): string | undefined => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const list = (name: string, fallback: number[]): number[] => {
  const raw = value(name)
  if (raw === undefined) return fallback
  const parsed = raw.split(',').map(Number)
  if (parsed.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error(`${name} takes a comma-separated list of positive numbers`)
  return parsed
}

const ONLY = value('--only')
if (ONLY !== undefined && !['density', 'restore', 'planner'].includes(ONLY)) throw new Error('--only takes density, restore or planner')
const SMOKE = flag('--smoke')
const TENANT_STEPS = list('--tenants', SMOKE ? [5, 20] : [1, 10, 50, 100, 250, 500])
const SIZES_MB = list('--sizes-mb', SMOKE ? [1] : [1, 10, 50, 100])
const REPEATS = SMOKE ? 1 : 3
const WITH_PLANNER = !SMOKE && !flag('--no-planner')
const MIB = 1024 * 1024
const ORG = 'probe'
const KEY = Buffer.alloc(32, 0x5a)
const ISSUER = 'https://idp.probe.example'

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length === 0 ? Number.NaN : sorted[Math.floor((sorted.length - 1) / 2)]!
}
const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length === 0 ? Number.NaN : sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!
}
const round = (n: number, digits = 1): number => Number(n.toFixed(digits))
const mib = (bytes: number): number => round(bytes / MIB)

function fdCount(): number {
  return readdirSync('/dev/fd').length
}

function tenantIdOf(i: number): string {
  return deriveLedgerTenantId(KEY, ISSUER, `probe-user-${i}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'gotry-capacity-probe-'))
const cleanups: Array<() => void> = []

function fleet(name: string) {
  const dir = join(scratch, name)
  const leases = new SqliteLeaseStore({ path: join(dir, 'leases.db') })
  const durable = new DirDurableStore(join(dir, 'durable'))
  cleanups.push(() => leases.close())
  const router = (replica: string) => new TenantRouter({ stateRoot: join(dir, 'nodes', replica), replicaId: replica, leases, durable, ttlMs: 60_000, marginMs: 2_000, autoRenew: false, snapshotEveryMs: 0 })
  return { router }
}

interface DensityRow { tenants: number; rssMiB: number; rssDeltaMiB: number; heapUsedMiB: number; externalMiB: number; fds: number; fdDelta: number; openMsMedian: number; openMsP95: number }
interface RestoreRow { ledgerMiB: number; snapshotMs: number; restoreMs: number; restoredRows: number; writtenRows: number }
interface PlannerRow { trees: number; processes: number; rssMiB: number; rssPerTreeMiB: number; cpuSeconds: number; bootMs: number }

// ---- density -------------------------------------------------------------------------------------------------

async function density(): Promise<{ rows: DensityRow[]; afterClose: { fds: number; fdDelta: number; closeMs: number; unflushed: number } }> {
  const { router: make } = fleet('density')
  const router = make('density-replica')
  const baseFds = fdCount()
  const baseRss = process.memoryUsage().rss
  const rows: DensityRow[] = []
  const openTimes: number[] = []
  let opened = 0
  for (const step of TENANT_STEPS) {
    for (; opened < step; opened += 1) {
      const started = performance.now()
      await router.openTenant(ORG, tenantIdOf(opened))
      openTimes.push(performance.now() - started)
    }
    global.gc?.()
    const memory = process.memoryUsage()
    rows.push({
      tenants: step,
      rssMiB: mib(memory.rss),
      rssDeltaMiB: mib(memory.rss - baseRss),
      heapUsedMiB: mib(memory.heapUsed),
      externalMiB: mib(memory.external),
      fds: fdCount(),
      fdDelta: fdCount() - baseFds,
      openMsMedian: round(median(openTimes), 2),
      openMsP95: round(percentile(openTimes, 0.95), 2),
    })
  }
  const closing = performance.now()
  const unflushed = await router.close()
  const closeMs = performance.now() - closing
  return { rows, afterClose: { fds: fdCount(), fdDelta: fdCount() - baseFds, closeMs: round(closeMs), unflushed: unflushed.length } }
}

// ---- restore -------------------------------------------------------------------------------------------------

async function restoreOnce(sizeMiB: number, run: number): Promise<RestoreRow> {
  const { router: make } = fleet(`restore-${sizeMiB}-${run}`)
  const owner = make('owner')
  const successor = make('successor')
  const tenant = tenantIdOf(1_000_000 + run)
  const handle = await owner.openTenant(ORG, tenant)
  const rowsToWrite = Math.max(1, Math.round((sizeMiB * MIB) / 65_536))
  handle.run((ledger) => {
    ledger.db.exec('CREATE TABLE IF NOT EXISTS capacity_probe (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)')
    const insert = ledger.db.prepare('INSERT INTO capacity_probe(payload) VALUES (randomblob(65536))')
    ledger.db.transaction(() => { for (let i = 0; i < rowsToWrite; i += 1) insert.run() })()
  })
  const snapshotting = performance.now()
  await handle.handoff()
  const snapshotMs = performance.now() - snapshotting
  const restoring = performance.now()
  const taken = await successor.openTenant(ORG, tenant)
  const restoreMs = performance.now() - restoring
  const restoredRows = taken.run((ledger) => (ledger.db.prepare('SELECT COUNT(*) AS n FROM capacity_probe').get() as { n: number }).n)
  const sizeBytes = taken.run((ledger) => {
    const pages = ledger.db.pragma('page_count', { simple: true }) as number
    const pageSize = ledger.db.pragma('page_size', { simple: true }) as number
    return pages * pageSize
  })
  await taken.handoff()
  await owner.close()
  await successor.close()
  return { ledgerMiB: mib(sizeBytes), snapshotMs: round(snapshotMs), restoreMs: round(restoreMs), restoredRows, writtenRows: rowsToWrite }
}

async function restore(): Promise<Array<RestoreRow & { requestedMiB: number }>> {
  const out: Array<RestoreRow & { requestedMiB: number }> = []
  for (const size of SIZES_MB) {
    const runs: RestoreRow[] = []
    for (let run = 0; run < REPEATS; run += 1) runs.push(await restoreOnce(size, run))
    const middle = runs.sort((a, b) => a.restoreMs - b.restoreMs)[Math.floor((runs.length - 1) / 2)]!
    out.push({ requestedMiB: size, ...middle })
  }
  return out
}

// ---- planner -------------------------------------------------------------------------------------------------

/** The process trees below this process, measured as they are now. The `ps` that reads the table is itself a child and is left out. */
function ownTreeSample(): { processes: number; rssBytes: number; cpuSeconds: number } {
  const text = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,command='], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } })
  const withoutPs = text.split('\n').filter((line) => !/^\s*\d+\s+\d+\s+\d+\s+\S+\s+(?:\S*\/)?ps(?:\s|$)/.test(line)).join('\n')
  const table = parsePsTable(withoutPs.replace(/^(\s*\d+\s+\d+\s+\d+\s+\S+)\s+.*$/gm, '$1'))
  let processes = 0
  let rssBytes = 0
  let cpuSeconds = 0
  for (const child of table.filter((row) => row.ppid === process.pid)) {
    const tree = treeOf(table, { rootPid: child.pid, parentPid: process.pid })
    if (!tree) continue
    processes += tree.pids.length
    rssBytes += tree.rssBytes
    cpuSeconds += tree.cpuSeconds
  }
  return { processes, rssBytes, cpuSeconds }
}

async function planner(): Promise<PlannerRow[]> {
  const rows: PlannerRow[] = []
  process.env.GOTRY_BOOKING_COPILOT_WARMUP = '0'
  for (const trees of [1, 4]) {
    const stateRoot = mkdtempSync(join(scratch, 'planner-'))
    const ports = await Promise.all(Array.from({ length: trees }, () => createRealRunPort({
      stateRoot,
      env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'probe-key-not-used', DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1', DEEPSEEK_PROVIDER: 'gateway-chat', DEEPSEEK_MODEL: 'probe-model' },
    })))
    const booting = performance.now()
    await Promise.all(ports.map((port) => port.warmup!()))
    const bootMs = performance.now() - booting
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const sample = ownTreeSample()
    rows.push({
      trees,
      processes: sample.processes,
      rssMiB: mib(sample.rssBytes),
      rssPerTreeMiB: mib(sample.rssBytes / trees),
      cpuSeconds: round(sample.cpuSeconds, 2),
      bootMs: round(bootMs),
    })
    await Promise.all(ports.map((port) => port.close()))
  }
  return rows
}

// ---- run -------------------------------------------------------------------------------------------------

const environment = {
  date: new Date().toISOString().slice(0, 10),
  node: process.version,
  platform: `${platform()}/${arch()}`,
  cpu: `${cpus()[0]?.model ?? 'unknown'} x${cpus().length}`,
  memoryGiB: round(totalmem() / (1024 * MIB)),
  durableStore: 'local directory (no network, no object store)',
  mode: SMOKE ? 'smoke' : 'full',
}

try {
  const densityResult = ONLY === undefined || ONLY === 'density' ? await density() : { rows: [], afterClose: { fds: 0, fdDelta: 0, closeMs: 0, unflushed: 0 } }
  const restoreResult = ONLY === undefined || ONLY === 'restore' ? await restore() : []
  const plannerResult = WITH_PLANNER && (ONLY === undefined || ONLY === 'planner') ? await planner() : []
  const report = { environment, density: densityResult, restore: restoreResult, planner: plannerResult }

  if (SMOKE) {
    const last = densityResult.rows.at(-1)!
    assert.equal(last.tenants, TENANT_STEPS.at(-1), 'every tenant opened')
    assert.ok(densityResult.afterClose.fdDelta <= 8, `closing the tenants returned their handles (fd delta ${densityResult.afterClose.fdDelta})`)
    assert.equal(densityResult.afterClose.unflushed, 0, 'every tenant flushed on close')
    for (const row of restoreResult) {
      assert.ok(row.writtenRows > 0 && row.restoredRows === row.writtenRows, `a restored ledger holds exactly what was written (${row.restoredRows} of ${row.writtenRows})`)
      assert.ok(Number.isFinite(row.restoreMs) && row.restoreMs >= 0 && Number.isFinite(row.snapshotMs))
    }
    console.log(`tenant-capacity-probe: smoke ok (${last.tenants} tenants, fd delta after close ${densityResult.afterClose.fdDelta}, ${restoreResult.length} restore sizes)`)
  } else {
    console.log(`environment: ${JSON.stringify(environment)}`)
    if (densityResult.rows.length > 0) {
      console.log('\ndensity (one process, tenants opened one after another):')
      console.table(densityResult.rows)
      console.log(`after close: ${JSON.stringify(densityResult.afterClose)}`)
    }
    if (restoreResult.length > 0) {
      console.log('\nrestore (a new owner takes over from the durable copy; median of ' + REPEATS + '):')
      console.table(restoreResult)
    }
    if (plannerResult.length > 0) {
      console.log('\nplanner (booted, idle, no model call, warm-up off):')
      console.table(plannerResult)
    }
  }
  const out = value('--json')
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
} finally {
  for (const cleanup of cleanups) { try { cleanup() } catch { /* best effort */ } }
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(0)
