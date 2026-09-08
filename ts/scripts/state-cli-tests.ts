/**
 * 账本 CLI e2e(run-all §29):子进程走 state-cli 的操作面——
 * migrate(旧文件→账本)/ stats / log / export(视图单向导出)/ forget(物理硬删)/
 * pw-request→pw-confirm→pw-list(saga CLI 面),并锁住严格参数解析与 local-only 边界。
 * 运行(在 ts/ 下):npx tsx scripts/state-cli-tests.ts
 */

import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { parseFlightPackToSpec } from '../src/unified.ts'
import type { AsyncTicket } from '../src/loop.ts'
import type { TripState } from '../src/contracts.ts'

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

function cli(args: string[]): SpawnSyncReturns<string> {
  return spawnSync('npx', ['tsx', 'scripts/state-cli.ts', ...args], { encoding: 'utf-8' }) as SpawnSyncReturns<string>
}

function snapshotPath(path: string): string {
  if (!existsSync(path)) return '<missing>'
  const h = createHash('sha256')
  const walk = (p: string, rel: string): void => {
    const st = statSync(p)
    if (st.isDirectory()) {
      h.update(`dir:${rel}\n`)
      for (const name of readdirSync(p).sort()) walk(join(p, name), rel ? `${rel}/${name}` : name)
    } else if (st.isFile()) {
      h.update(`file:${rel}:${st.size}\n`)
      h.update(readFileSync(p))
      h.update('\n')
    } else {
      h.update(`other:${rel}:${st.mode}:${st.size}\n`)
    }
  }
  walk(path, '')
  return h.digest('hex')
}

function seedTenantFixture(root: string, tenant: string): void {
  const db = new Database(join(root, 'gotry-state', 'gotry-state.db'))
  const ts = '2026-09-08T00:00:00.000Z'
  db.prepare(
    `INSERT INTO events (tenant_id, ts, actor, kind, subject_id, payload, idem_key, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(tenant, ts, 'test:tenant-fixture', 'tenant.fixture', 'tenant-subject', '{}', 'tenant-fixture-1', null)
  db.prepare(
    `INSERT INTO pending_writes (tenant_id, idem_key, seam, payload, status, receipt, created, updated)
     VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`,
  ).run(tenant, 'tenant-pw-1', 'tenant-seam', '{}', ts, ts)
  db.close()
}

function seedPendingWorkflowPair(root: string, id: string): void {
  const pack = JSON.parse(readFileSync(join('..', 'data', 'flights_2026.json'), 'utf-8')) as Record<string, unknown>
  const spec = parseFlightPackToSpec(pack)
  spec.budgetCny = 9000
  const ticket: AsyncTicket = {
    id,
    objective: 'CLI tick E2E:本地 pending 工单真实回收',
    requestedAt: '2026-09-08T00:00:00.000Z',
    etaLabel: '秒级',
  }
  const state = {
    calendar: { year: 2026, assertedWeekdays: {} },
    profile: {},
    gates: [],
    wishes: [],
    spec,
  } as unknown as TripState
  const db = new Database(join(root, 'gotry-state', 'gotry-state.db'))
  const ts = '2026-09-08T00:00:00.000Z'
  const insertRun = db.prepare(
    `INSERT INTO workflow_runs (tenant_id, id, goal, status, ticket_json, state_json, deliverable, created, updated)
     VALUES (?, ?, ?, 'pending', ?, ?, NULL, ?, ?)`,
  )
  const insertEvent = db.prepare(
    `INSERT INTO events (tenant_id, ts, actor, kind, subject_id, payload, idem_key, run_id)
     VALUES (?, ?, ?, 'async.run_created', ?, ?, ?, ?)`,
  )
  for (const tenant of ['local', 'tenant-b']) {
    insertRun.run(tenant, id, ticket.objective, JSON.stringify(ticket), JSON.stringify(state), ts, ts)
    insertEvent.run(tenant, ts, 'test:pending-tick', id, JSON.stringify({ ticket }), `tick:${tenant}:${id}`, id)
  }
  db.close()
}

function workflowSummary(root: string, id: string): string {
  const db = new Database(join(root, 'gotry-state', 'gotry-state.db'), { readonly: true })
  const runs = db.prepare(
    `SELECT tenant_id, id, status, deliverable FROM workflow_runs WHERE id = ? ORDER BY tenant_id`,
  ).all(id)
  const steps = db.prepare(
    `SELECT tenant_id, run_id, name, status, result FROM workflow_steps WHERE run_id = ? ORDER BY tenant_id, name`,
  ).all(id)
  const events = db.prepare(
    `SELECT tenant_id, kind, subject_id, idem_key, run_id FROM events WHERE run_id = ? OR subject_id = ? ORDER BY tenant_id, seq`,
  ).all(id, id)
  db.close()
  return JSON.stringify({ runs, steps, events })
}

function workflowRows(root: string, id: string): {
  runs: Array<{ tenant_id: string; status: string; deliverable: string | null }>
  steps: Array<{ tenant_id: string; name: string; status: string; result: string | null }>
  events: Array<{ tenant_id: string; kind: string }>
} {
  const db = new Database(join(root, 'gotry-state', 'gotry-state.db'), { readonly: true })
  const rows = {
    runs: db.prepare(`SELECT tenant_id, status, deliverable FROM workflow_runs WHERE id = ? ORDER BY tenant_id`).all(id) as Array<{ tenant_id: string; status: string; deliverable: string | null }>,
    steps: db.prepare(`SELECT tenant_id, name, status, result FROM workflow_steps WHERE run_id = ? ORDER BY tenant_id, name`).all(id) as Array<{ tenant_id: string; name: string; status: string; result: string | null }>,
    events: db.prepare(`SELECT tenant_id, kind FROM events WHERE run_id = ? ORDER BY tenant_id, seq`).all(id) as Array<{ tenant_id: string; kind: string }>,
  }
  db.close()
  return rows
}

function rowFor<T extends { tenant_id: string }>(rows: T[], tenant: string): T | undefined {
  return rows.find(r => r.tenant_id === tenant)
}

// 迁移面:旧文件 root → migrate → stats/log/export
const root = mkdtempSync(join(tmpdir(), 'gotry-cli-'))
const dir = join(root, 'gotry-state')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'motivation-profile.json'), JSON.stringify({ weights: { curiosity: 0.6 }, evidence: ['原话A'], hard: {} }))
writeFileSync(join(dir, 'wish-pool.json'), JSON.stringify([{ wish_id: 'wLEGACY1', name: '京都', conditions: { days: 7 }, added_at: '2026-08-01T00:00:00Z' }]))

const mig = cli(['migrate', root])
assert(mig.status === 0 && /账本就绪/.test(mig.stdout ?? ''), `migrate exit 0 且报告就绪(实际 ${mig.status}:${(mig.stderr ?? '').slice(0, 200)})`)
assert(existsSync(join(dir, 'gotry-state.db')), 'migrate 后账本文件存在')
assert(existsSync(join(dir, 'pre-ledger-backup', 'wish-pool.json')), 'migrate 前自动快照(pre-ledger-backup/)')

const stats = cli(['stats', root])
assert(stats.status === 0 && /wishes=1/.test(stats.stdout ?? '') && /events=\d+/.test(stats.stdout ?? ''), `stats 计数正确(${(stats.stdout ?? '').trim()})`)

const log = cli(['log', root, '--limit', '3'])
assert(log.status === 0 && /\bwish\.imported\b|\bmotivation\.imported\b/.test(log.stdout ?? ''), `log 呈现账本事件(append-only 审计面)`)

// export:视图单向导出(DB→文件)
rmSync(join(dir, 'wish-pool.json'))
const exp = cli(['export', root])
assert(exp.status === 0 && existsSync(join(dir, 'wish-pool.json')), 'export 重建旧文件名视图(红线 6:可见可导出)')
const exported = JSON.parse(readFileSync(join(dir, 'wish-pool.json'), 'utf-8')) as Array<{ wish_id?: string }>
assert(exported[0]?.wish_id === 'wLEGACY1', 'export 视图内容与账本一致')

const tickLocal = cli(['tick', root])
assert(tickLocal.status === 0 && /无 pending 工单/.test(tickLocal.stdout ?? ''), 'tick local 无 pending 时不求解且正常返回')
const forkDest = join(root, 'forks', 'whatif.db')
const whatifLocal = cli(['whatif', root, forkDest])
assert(whatifLocal.status === 0 && existsSync(forkDest), 'whatif local 生成整库 snapshot 副本')

// forget:物理硬删 + 审计一行
const fg = cli(['forget', root, 'wish', 'wLEGACY1'])
assert(fg.status === 0 && /物理硬删/.test(fg.stdout ?? ''), 'forget 执行成功')
const stats2 = cli(['stats', root])
assert(/wishes=0/.test(stats2.stdout ?? ''), 'forget 后愿望池归零(红线 6「可删除」,D5 物理硬删)')
const log2 = cli(['log', root, '--limit', '3'])
assert(/forget\.executed/.test(log2.stdout ?? ''), 'forget 留审计一行(删除本身可溯源)')

// saga CLI 面:fresh root → pw-request → pw-confirm → pw-list
const root2 = mkdtempSync(join(tmpdir(), 'gotry-cli2-'))
const req = cli(['pw-request', root2, 'booking:e2e-1', 'flight-order-confirm', '{"flight":"MU123"}'])
assert(req.status === 0 && /"created":true/.test(req.stdout ?? ''), 'pw-request 登记成功(L2:只登记不执行)')
const dup = cli(['pw-request', root2, 'booking:e2e-1', 'flight-order-confirm', '{"flight":"MU123"}'])
assert(/"created":false/.test(dup.stdout ?? ''), 'pw-request 幂等键去重')
const conf = cli(['pw-confirm', root2, 'booking:e2e-1', 'PNR-XYZ'])
assert(conf.status === 0 && /"ok":true/.test(conf.stdout ?? ''), 'pw-confirm 携 receipt 确认(L3)')
const list = cli(['pw-list', root2])
assert(/confirmed/.test(list.stdout ?? '') && /PNR-XYZ/.test(list.stdout ?? ''), 'pw-list 呈现终态与 receipt')

// 严格解析:未知/重复/缺值/非法 numeric 在打开账本前 fail-closed,且不改 root 内容。
const parseRoot = mkdtempSync(join(tmpdir(), 'gotry-cli-parse-'))
const parseMig = cli(['migrate', parseRoot])
assert(parseMig.status === 0, 'strict 解析夹具账本可创建')
const strictCases: Array<{ name: string; args: string[]; pattern: RegExp }> = [
  { name: '未知选项', args: ['stats', parseRoot, '--bogus', 'x'], pattern: /未知选项 --bogus/ },
  { name: '重复选项', args: ['stats', parseRoot, '--tenant', 'a', '--tenant', 'b'], pattern: /重复选项 --tenant/ },
  { name: '重复 state-root', args: ['stats', '--state-root', parseRoot, '--state-root', parseRoot], pattern: /重复选项 --state-root/ },
  { name: '缺少选项值', args: ['stats', parseRoot, '--tenant', '--limit', '1'], pattern: /--tenant 缺少值/ },
  { name: '非法 limit=0', args: ['log', parseRoot, '--limit', '0'], pattern: /--limit 必须是正整数/ },
  { name: '非 log 的 limit', args: ['stats', parseRoot, '--limit', '3'], pattern: /stats 不支持 --limit/ },
  { name: '单横杠未知选项', args: ['stats', parseRoot, '-x'], pattern: /未知选项 -x/ },
  { name: 'rebuild 小数 seq', args: ['rebuild', '1.5'], pattern: /toSeq 必须是非负整数:1\.5/ },
  { name: 'rebuild 省略整数位小数 seq', args: ['rebuild', '.5'], pattern: /toSeq 必须是非负整数:\.5/ },
  { name: 'rebuild 正号省略整数位小数 seq', args: ['rebuild', '+.5'], pattern: /toSeq 必须是非负整数:\+\.5/ },
  { name: 'rebuild 负数 seq', args: ['rebuild', '-1'], pattern: /toSeq 必须是非负整数:-1/ },
  { name: '非法 seq', args: ['rewind', parseRoot, '1.5'], pattern: /seq 必须是非负整数/ },
  { name: '负数 seq', args: ['rewind', parseRoot, '-3'], pattern: /seq 必须是非负整数/ },
  { name: '未知命令', args: ['bogus-cmd', parseRoot], pattern: /未知命令/ },
]
for (const c of strictCases) {
  const before = snapshotPath(parseRoot)
  const r = cli(c.args)
  const after = snapshotPath(parseRoot)
  assert(r.status !== 0 && c.pattern.test(r.stderr ?? '') && before === after, `strict parse ${c.name} 零账本/文件变化`)
}
const numericParent = mkdtempSync(join(tmpdir(), 'gotry-cli-numeric-parent-'))
const numericRoot = join(numericParent, '1.5')
const dotNumericRoot = join(numericParent, '.5')
const numericMig = cli(['migrate', '--state-root', numericRoot])
const numericRebuild = cli(['rebuild', '--state-root', numericRoot, '1'])
const dotNumericMig = cli(['migrate', '--state-root', dotNumericRoot])
const dotNumericRebuild = cli(['rebuild', '--state-root', dotNumericRoot, '1'])
assert(numericMig.status === 0 && numericRebuild.status === 0 && dotNumericMig.status === 0 && dotNumericRebuild.status === 0, '数字/小数样式 root 通过 --state-root 明示仍可用')

// local-only:非 local 的 tick/export/whatif 必须在 mkdir/openDb/solve/写文件前拒绝。
const guardRoot = mkdtempSync(join(tmpdir(), 'gotry-cli-guard-'))
const guardDir = join(guardRoot, 'gotry-state')
mkdirSync(guardDir, { recursive: true })
writeFileSync(join(guardDir, 'wish-pool.json'), JSON.stringify([{ wish_id: 'wGUARD', name: '台北', conditions: { days: 4 }, added_at: '2026-09-01T00:00:00Z' }]))
const guardMig = cli(['migrate', guardRoot])
assert(guardMig.status === 0, 'local-only 夹具账本可创建')
const badWhatifDest = join(guardRoot, 'forks', 'tenant.db')
const localOnlyCases: Array<{ name: string; args: string[] }> = [
  { name: 'export', args: ['export', '--tenant', 'tenant-a', '--state-root', guardRoot] },
  { name: 'tick', args: ['tick', guardRoot, '--tenant', 'tenant-a'] },
  { name: 'whatif', args: ['whatif', guardRoot, badWhatifDest, '--tenant', 'tenant-a'] },
]
for (const c of localOnlyCases) {
  const before = snapshotPath(guardRoot)
  const r = cli(c.args)
  const after = snapshotPath(guardRoot)
  assert(r.status !== 0 && /仅支持 --tenant local/.test(r.stderr ?? '') && before === after, `${c.name} 非 local fail-closed 且 root hash 不变`)
}
assert(!existsSync(badWhatifDest), '非 local whatif 未创建 snapshot 文件')
const missingBase = mkdtempSync(join(tmpdir(), 'gotry-cli-missing-'))
const missingRoot = join(missingBase, 'missing-root')
const missingReject = cli(['export', '--tenant', 'tenant-a', '--state-root', missingRoot])
assert(missingReject.status !== 0 && !existsSync(missingRoot), '非 local export 在无 DB root 下零目录创建')

// tick 正/负 E2E:local 与 tenant-b 同 id pending。非 local 拒绝必须保持双方 workflow/step/audit 不变;
// local tick 必须用真实 state-cli 子进程 + solveUnified 回收本地 pending,且不碰 tenant-b。
const tickRoot = mkdtempSync(join(tmpdir(), 'gotry-cli-tick-'))
const tickId = 'dp-cli-tick-e2e'
const tickMig = cli(['migrate', tickRoot])
assert(tickMig.status === 0, 'tick pending 夹具账本可创建')
seedPendingWorkflowPair(tickRoot, tickId)
const tickRejectBefore = workflowSummary(tickRoot, tickId)
const tickReject = cli(['tick', tickRoot, '--tenant', 'tenant-b'])
const tickRejectAfter = workflowSummary(tickRoot, tickId)
assert(tickReject.status !== 0 && /仅支持 --tenant local/.test(tickReject.stderr ?? '') && tickRejectBefore === tickRejectAfter, '非 local tick 拒绝后 local/B workflow/step/audit 均不变')
const tickRun = cli(['tick', tickRoot])
const tickRows = workflowRows(tickRoot, tickId)
const localRun = rowFor(tickRows.runs, 'local')
const tenantRun = rowFor(tickRows.runs, 'tenant-b')
const localStep = rowFor(tickRows.steps, 'local')
const tenantStep = rowFor(tickRows.steps, 'tenant-b')
assert(tickRun.status === 0 && /工单 dp-cli-tick-e2e 已回收/.test(tickRun.stdout ?? ''), 'local tick 真实回收 pending 工单')
assert(localRun?.status === 'settled' && tenantRun?.status === 'pending', 'local tick 只结算 local run,tenant-b 同 id 保持 pending')
assert(localStep?.name === 'solve' && localStep.status === 'done' && !tenantStep, 'local tick 只写 local solve step')
assert(tickRows.events.some(e => e.tenant_id === 'local' && e.kind === 'async.settled') && !tickRows.events.some(e => e.tenant_id === 'tenant-b' && (e.kind === 'async.settled' || e.kind === 'async.failed')), 'local tick 只写 local 终态审计事件')
assert(existsSync(join(tickRoot, 'gotry-state', 'async', `${tickId}.deliverable.md`)), 'local tick 写入隔离 root 的 deliverable 视图')

// tenant 读范围与合法顺序等价:直接 SQL 种 tenant fixture,不依赖并行 #224 的写路径修复。
const tenantRoot = mkdtempSync(join(tmpdir(), 'gotry-cli-tenant-'))
const tenantMig = cli(['migrate', tenantRoot])
assert(tenantMig.status === 0, 'tenant scope 夹具账本可创建')
seedTenantFixture(tenantRoot, 'tenant-a')
const statsTenantA = cli(['stats', tenantRoot, '--tenant', 'tenant-a'])
const statsTenantB = cli(['--tenant', 'tenant-a', '--state-root', tenantRoot, 'stats'])
assert(statsTenantA.status === 0 && statsTenantA.stdout === statsTenantB.stdout && /events=1/.test(statsTenantA.stdout ?? '') && /pendingWrites=1/.test(statsTenantA.stdout ?? ''), 'stats tenant scope 参数顺序等价且只读 tenant-a')
const pwTenant = cli(['pw-list', '--state-root', tenantRoot, '--tenant', 'tenant-a'])
const pwLocal = cli(['pw-list', '--state-root', tenantRoot])
assert(/tenant-pw-1/.test(pwTenant.stdout ?? '') && !/tenant-pw-1/.test(pwLocal.stdout ?? ''), 'pw-list tenant scope 不串到默认 local')

// flag 值不得成为业务参数:同一合法调用多种顺序登记到指定 tenant,idemKey 不被 tenant/root 值串位。
const orderRoot = mkdtempSync(join(tmpdir(), 'gotry-cli-order-'))
const orderReqA = cli(['pw-request', '--tenant', 'tenant-order', '--state-root', orderRoot, 'order-key-a', 'flight-order-confirm', '{"flight":"MU456"}'])
const orderReqB = cli(['--state-root', orderRoot, 'pw-request', 'order-key-b', '--tenant', 'tenant-order', 'flight-order-confirm', '{"flight":"MU789"}'])
const orderList = cli(['pw-list', '--state-root', orderRoot, '--tenant', 'tenant-order'])
assert(orderReqA.status === 0 && orderReqB.status === 0 && /order-key-a/.test(orderList.stdout ?? '') && /order-key-b/.test(orderList.stdout ?? '') && !/tenant-order\s+seam=/.test(orderList.stdout ?? ''), 'pw-request 合法参数前后顺序等价且 flag 值不串业务参数')

rmSync(root, { recursive: true, force: true })
rmSync(root2, { recursive: true, force: true })
rmSync(parseRoot, { recursive: true, force: true })
rmSync(numericParent, { recursive: true, force: true })
rmSync(guardRoot, { recursive: true, force: true })
rmSync(missingBase, { recursive: true, force: true })
rmSync(tickRoot, { recursive: true, force: true })
rmSync(tenantRoot, { recursive: true, force: true })
rmSync(orderRoot, { recursive: true, force: true })
console.log(`\nSTATE-CLI TESTS: ${pass} ok, ${fail} fail`)
if (fail > 0) process.exit(1)
