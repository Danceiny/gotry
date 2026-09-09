/**
 * 账本 tenant 修复计划测试(issue #254 第一切片,run-all §29b)。
 *
 * 三类断言:
 *   A. **零写**:每个场景跑完,state 目录内容哈希与跑之前逐字节一致
 *      (含 -wal/-shm sidecar——正本目录里多出文件也算写)。
 *   B. **判定**:无显式证据零搬移;跨租户同 idem_key / 同 wish_id 一律拒绝;
 *      重复 dry-run 幂等。
 *   C. **CLI seam**:repair-plan 路由、fail-closed 参数、输出稳定。
 *
 * 全部使用 mkdtemp 隔离 stateRoot,绝不触碰 ts/dsh-runtime/gotry-state/ 真实产品数据。
 * 运行(在 ts/ 下):npx tsx scripts/ledger-repair-plan-tests.ts
 */

import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { ensureLedger, ledgerDbPath } from '../src/state-ledger.ts'
import { REASON, REPAIR_MAPPING_ROOT_NOT_ARRAY, formatRepairPlan, planLedgerRepair, type RepairPlan } from '../src/ledger-repair-plan.ts'

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`  ok - ${msg}`) } else { fail++; console.error(`  FAIL - ${msg}`) }
}

/** 目录内容哈希:文件名 + 大小 + 字节。多出 -wal/-shm 会改变哈希 = 判定为写。 */
function snapshotDir(path: string): string {
  const h = createHash('sha256')
  const walk = (p: string, rel: string): void => {
    const st = statSync(p)
    if (st.isDirectory()) {
      h.update(`dir:${rel}\n`)
      for (const name of readdirSync(p).sort()) walk(join(p, name), rel ? `${rel}/${name}` : name)
    } else if (st.isFile()) {
      h.update(`file:${rel}:${st.size}\n`); h.update(readFileSync(p)); h.update('\n')
    } else {
      h.update(`other:${rel}\n`)
    }
  }
  walk(path, '')
  return h.digest('hex')
}

const roots: string[] = []
function newRoot(tag: string): string {
  const r = mkdtempSync(join(tmpdir(), `gotry-repair-${tag}-`))
  roots.push(r)
  return r
}
function stateDir(root: string): string { return join(root, 'gotry-state') }

function insertRaw(dbPath: string, rows: Array<{ tenant: string; kind: string; subject: string; idem: string | null; ts?: string }>): void {
  const db = new Database(dbPath)
  const stmt = db.prepare(
    `INSERT INTO events (tenant_id, ts, actor, kind, subject_id, payload, idem_key, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
  for (const r of rows) stmt.run(r.tenant, r.ts ?? '2026-09-01T00:00:00.000Z', 'test:fixture', r.kind, r.subject, '{}', r.idem)
  db.close()
}

/** 建一个 v2 账本并直接用 SQL 种事件(不依赖写路径,便于造跨租户夹具) */
function seedLedger(root: string, rows: Array<{ tenant: string; kind: string; subject: string; idem: string | null; ts?: string }>): string {
  const led = ensureLedger(root, 'local')
  led.close() // 关掉句柄,让 WAL checkpoint 落盘,后续哈希才稳定
  const dbPath = ledgerDbPath(root)
  insertRaw(dbPath, rows)
  return dbPath
}

function writeMapping(root: string, name: string, value: unknown): string {
  const p = join(root, name)
  writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value), 'utf-8')
  return p
}

function cli(args: string[]): SpawnSyncReturns<string> {
  return spawnSync('npx', ['tsx', 'scripts/state-cli.ts', ...args], { encoding: 'utf-8' }) as SpawnSyncReturns<string>
}

/** 跑一段逻辑并断言 state 目录零变化 */
function assertZeroWrite(root: string, label: string, fn: () => void): void {
  const before = snapshotDir(stateDir(root))
  fn()
  const after = snapshotDir(stateDir(root))
  assert(before === after, `零写:${label}`)
}

function entryBySeq(plan: RepairPlan, seq: number) {
  return plan.entries.find(e => e.seq === seq)
}

console.log('\n== A. 无映射:只读盘点,零搬移零写 ==')
{
  const root = newRoot('inv')
  seedLedger(root, [
    { tenant: 'local', kind: 'wish.added', subject: 'w-1', idem: 'import:wish:w-1' },
    { tenant: 'local', kind: 'trip.logged', subject: 't-1', idem: 'trip:t-1' },
    { tenant: 'tenant-a', kind: 'wish.added', subject: 'w-9', idem: 'import:wish:w-9' },
  ])
  let plan!: RepairPlan
  assertZeroWrite(root, '无映射 dry-run', () => { plan = planLedgerRepair({ stateRoot: root }) })
  assert(plan.totals.candidates === 2, '源租户 local 下候选事件 = 2(不含 tenant-a)')
  assert(plan.totals.move === 0, '无显式证据映射 → 零搬移')
  assert(plan.totals.retain === 2, '全部候选原地保留')
  assert(plan.entries.every(e => e.reason === REASON.NO_EVIDENCE), '保留理由均为 no_explicit_evidence')
  assert(plan.applyable === false && plan.applyAuthorized === false, '无搬移时 applyable=false,且 applyAuthorized 恒 false')
  const censusBefore = plan.tenantCensusBefore.map(t => `${t.tenant}=${t.events}`).join(' ')
  assert(censusBefore === 'local=2 tenant-a=1', `before 分布可审计:${censusBefore}`)
  assert(JSON.stringify(plan.tenantCensusBefore) === JSON.stringify(plan.tenantCensusAfter), '零搬移时 after 分布与 before 相同')
}

console.log('\n== B. 显式证据映射:计划出可审计 before/after,仍零写 ==')
{
  const root = newRoot('move')
  seedLedger(root, [
    { tenant: 'local', kind: 'wish.added', subject: 'w-1', idem: 'import:wish:w-1' },
    { tenant: 'local', kind: 'wish.added', subject: 'w-2', idem: 'import:wish:w-2' },
    { tenant: 'local', kind: 'trip.logged', subject: 't-1', idem: 'trip:t-1' },
  ])
  const mappings = [
    { seq: 1, fromTenant: 'local', toTenant: 'tenant-a', evidence: 'issue #254 comment: 用户 A 于 2026-03 确认 w-1 属于其账户' },
  ]
  let plan!: RepairPlan
  assertZeroWrite(root, '有效映射 dry-run', () => { plan = planLedgerRepair({ stateRoot: root, mappings }) })
  assert(plan.totals.move === 1 && plan.totals.retain === 2, '仅被映射覆盖的 1 条计划搬移,其余保留')
  const moved = entryBySeq(plan, 1)!
  assert(moved.decision === 'move' && moved.beforeTenant === 'local' && moved.afterTenant === 'tenant-a', 'before/after 逐条可读:local -> tenant-a')
  assert(moved.evidence !== null && moved.evidence.includes('#254'), '搬移条目带人工证据原文')
  const after = plan.tenantCensusAfter.map(t => `${t.tenant}=${t.events}`).join(' ')
  assert(after === 'local=2 tenant-a=1', `after 分布按计划模拟:${after}`)
  assert(plan.applyable === true, '无冲突且有搬移 → applyable=true')
  assert(plan.applyAuthorized === false, '但 applyAuthorized 仍为 false:真实 apply 在单独 owner gate 后')
  // 计划归计划,账本里 tenant 分布一个字节没动
  const db = new Database(ledgerDbPath(root), { readonly: true })
  const live = (db.prepare('SELECT tenant_id AS t, COUNT(*) AS n FROM events GROUP BY tenant_id ORDER BY tenant_id').all() as Array<{ t: string; n: number }>)
    .map(r => `${r.t}=${r.n}`).join(' ')
  db.close()
  assert(live === 'local=3', `dry-run 后账本真实分布未变:${live}`)
}

console.log('\n== C. 无证据不搬移:映射缺 evidence / 格式非法 → 拒绝且零写 ==')
{
  const root = newRoot('malformed')
  seedLedger(root, [
    { tenant: 'local', kind: 'wish.added', subject: 'w-1', idem: 'import:wish:w-1' },
    { tenant: 'local', kind: 'wish.added', subject: 'w-2', idem: 'import:wish:w-2' },
  ])
  const bad = [
    { seq: 1, fromTenant: 'local', toTenant: 'tenant-a' },                                   // 缺 evidence
    { seq: 2, fromTenant: 'local', toTenant: 'tenant-a', evidence: '   ' },                  // evidence 空白
    { seq: 0, fromTenant: 'local', toTenant: 'tenant-a', evidence: 'x' },                    // seq 非正整数
    { seq: 1, fromTenant: 'local', toTenant: '', evidence: 'x' },                            // toTenant 空
    { seq: 1, fromTenant: '', toTenant: 'tenant-a', evidence: 'x' },                         // fromTenant 空
    'not-an-object',                                                                          // 条目非对象
    { seq: 1, fromTenant: 'tenant-zzz', toTenant: 'tenant-a', evidence: 'x' },               // fromTenant 越出 scope
  ]
  let plan!: RepairPlan
  assertZeroWrite(root, '非法映射 dry-run', () => { plan = planLedgerRepair({ stateRoot: root, mappings: bad }) })
  assert(plan.totals.move === 0, '任何非法映射都不产生搬移')
  const codes = plan.rejectedMappings.map(r => r.reason)
  assert(codes.includes(REASON.MAPPING_EVIDENCE_MISSING), '缺 evidence → mapping_evidence_missing')
  assert(codes.filter(c => c === REASON.MAPPING_EVIDENCE_MISSING).length === 2, '空白 evidence 同样按缺失处理')
  assert(codes.includes(REASON.MAPPING_SEQ_INVALID), 'seq 非正整数 → mapping_seq_invalid')
  assert(codes.includes(REASON.MAPPING_TO_INVALID), 'toTenant 空 → mapping_to_tenant_invalid')
  assert(codes.includes(REASON.MAPPING_FROM_INVALID), 'fromTenant 空 → mapping_from_tenant_invalid')
  assert(codes.includes(REASON.MAPPING_NOT_OBJECT), '条目非对象 → mapping_not_object')
  assert(codes.includes(REASON.MAPPING_OUT_OF_SCOPE), 'fromTenant 越 scope → mapping_from_tenant_out_of_scope')
  assert(plan.applyable === false, '存在非法映射 → 计划整体不可 apply')
  assert(plan.entries.every(e => e.decision === 'retain'), '非法映射不影响其它事件:全部原地保留')
}

console.log('\n== D. 重复映射 / 目标即源 / seq 越 scope ==')
{
  const root = newRoot('dup')
  seedLedger(root, [{ tenant: 'local', kind: 'wish.added', subject: 'w-1', idem: 'k-1' }])
  const plan = planLedgerRepair({ stateRoot: root, mappings: [
    { seq: 1, fromTenant: 'local', toTenant: 'tenant-a', evidence: 'e1' },
    { seq: 1, fromTenant: 'local', toTenant: 'tenant-b', evidence: 'e2' },
  ] })
  assert(plan.rejectedMappings.some(r => r.reason === REASON.MAPPING_DUPLICATE_SEQ), '同 seq 重复映射 → mapping_duplicate_seq')
  assert(plan.applyable === false, '重复映射使计划不可 apply(意图不明不猜)')

  const p2 = planLedgerRepair({ stateRoot: root, mappings: [{ seq: 1, fromTenant: 'local', toTenant: 'local', evidence: 'e' }] })
  assert(entryBySeq(p2, 1)!.reason === REASON.TARGET_EQUALS_SOURCE, '目标租户 = 源租户 → target_tenant_equals_source')
  assert(p2.totals.move === 0, '无搬移语义时零搬移')

  const p3 = planLedgerRepair({ stateRoot: root, mappings: [{ seq: 999, fromTenant: 'local', toTenant: 'tenant-a', evidence: 'e' }] })
  const e999 = entryBySeq(p3, 999)!
  assert(e999.decision === 'reject' && e999.reason === REASON.EVENT_NOT_IN_SCOPE, 'seq 不在源 scope → event_not_found_in_scope')
  assert(p3.totals.move === 0, '越 scope 的 seq 零搬移')
}

console.log('\n== E. 跨租户同 idem_key / 同 wish_id 夹具:拒绝且零写 ==')
{
  const root = newRoot('conflict')
  seedLedger(root, [
    { tenant: 'local', kind: 'wish.added', subject: 'w-same', idem: 'import:wish:w-same' },   // seq 1
    { tenant: 'local', kind: 'trip.logged', subject: 't-1', idem: 'dup-idem' },               // seq 2
    { tenant: 'tenant-a', kind: 'wish.added', subject: 'w-same', idem: 'other-1' },           // seq 3 同 wish_id
    { tenant: 'tenant-a', kind: 'trip.logged', subject: 't-9', idem: 'dup-idem' },            // seq 4 同 idem_key
  ])
  let plan!: RepairPlan
  assertZeroWrite(root, '跨租户同 id 夹具 dry-run', () => {
    plan = planLedgerRepair({ stateRoot: root, mappings: [
      { seq: 1, fromTenant: 'local', toTenant: 'tenant-a', evidence: '人工确认 A' },
      { seq: 2, fromTenant: 'local', toTenant: 'tenant-a', evidence: '人工确认 B' },
    ] })
  })
  assert(entryBySeq(plan, 1)!.reason === REASON.SUBJECT_CONFLICT, '目标租户已存在同 wish_id → target_subject_conflict')
  assert(entryBySeq(plan, 2)!.reason === REASON.IDEM_CONFLICT, '目标租户已存在同 idem_key → target_idem_key_conflict')
  assert(plan.totals.move === 0 && plan.totals.reject === 2, '两类跨租户同 id 冲突都零搬移')
  assert(entryBySeq(plan, 1)!.afterTenant === 'local' && entryBySeq(plan, 2)!.afterTenant === 'local', '冲突事件 after 仍是原租户(留在原地)')
  assert(plan.applyable === false, '有冲突 → 计划不可 apply')
}

console.log('\n== F. 重复 dry-run 幂等 ==')
{
  const root = newRoot('idem')
  seedLedger(root, [
    { tenant: 'local', kind: 'wish.added', subject: 'w-1', idem: 'k1' },
    { tenant: 'local', kind: 'wish.added', subject: 'w-2', idem: 'k2' },
    { tenant: 'tenant-a', kind: 'wish.added', subject: 'w-3', idem: 'k3' },
  ])
  const mappings = [{ seq: 1, fromTenant: 'local', toTenant: 'tenant-a', evidence: 'e' }]
  const before = snapshotDir(stateDir(root))
  const digests: string[] = []
  const reports: string[] = []
  for (let i = 0; i < 3; i++) {
    const p = planLedgerRepair({ stateRoot: root, mappings })
    digests.push(p.planDigest)
    reports.push(formatRepairPlan(p))
  }
  const after = snapshotDir(stateDir(root))
  assert(before === after, '零写:连续 3 次 dry-run 后 state 目录逐字节不变')
  assert(new Set(digests).size === 1, `重复 dry-run 幂等:plan-digest 恒为 ${digests[0]}`)
  assert(new Set(reports).size === 1, '重复 dry-run 报告逐字节相同')
}

console.log('\n== G. v1 形态账本:只读呈现,绝不就地迁移 ==')
{
  const root = newRoot('v1')
  const dir = stateDir(root)
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'gotry-state.db')
  const v1 = new Database(dbPath)
  v1.exec(`
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL,
  subject_id TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL, idem_key TEXT, run_id TEXT
);
CREATE UNIQUE INDEX events_idem ON events(idem_key) WHERE idem_key IS NOT NULL;`)
  v1.prepare(`INSERT INTO events (ts, actor, kind, subject_id, payload, idem_key) VALUES (?,?,?,?,?,?)`)
    .run('2026-01-01T00:00:00.000Z', 'legacy', 'wish.added', 'w-legacy', '{}', 'import:wish:w-legacy')
  v1.close()

  let plan!: RepairPlan
  assertZeroWrite(root, 'v1 账本 dry-run(对照:openLedgerIfExists 会 ALTER/DROP 重建)', () => {
    plan = planLedgerRepair({ stateRoot: root })
  })
  const probe = new Database(dbPath, { readonly: true })
  const cols = (probe.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(c => c.name)
  const uv = probe.pragma('user_version', { simple: true }) as number
  const tables = (probe.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(t => t.name)
  probe.close()
  assert(!cols.includes('tenant_id'), 'v1 的 events 仍无 tenant_id 列(未被偷偷迁移)')
  assert(uv === 0, 'user_version 仍为 0(未被顶到 2)')
  assert(!tables.includes('projection_docs') && !tables.includes('kv'), '未凭空建出 v2 的投影/kv 表')
  assert(plan.totals.candidates === 1 && plan.totals.retain === 1, 'v1 事件按 local 只读呈现')
  assert(plan.notes.some(n => n.includes('v1 形态')), '报告显式提示 v1 形态与其边界')
}

console.log('\n== H. tenant scope:非 local 源租户只看自己 ==')
{
  const root = newRoot('scope')
  seedLedger(root, [
    { tenant: 'local', kind: 'wish.added', subject: 'w-1', idem: 'k1' },
    { tenant: 'tenant-a', kind: 'wish.added', subject: 'w-2', idem: 'k2' },
    { tenant: 'tenant-a', kind: 'wish.added', subject: 'w-3', idem: 'k3' },
  ])
  const p = planLedgerRepair({ stateRoot: root, sourceTenant: 'tenant-a' })
  assert(p.totals.candidates === 2, 'sourceTenant=tenant-a 只盘点 tenant-a 的 2 条')
  assert(p.entries.every(e => e.beforeTenant === 'tenant-a'), '候选不串到 local')
}

console.log('\n== I. CLI seam ==')
{
  const root = newRoot('cli')
  seedLedger(root, [
    { tenant: 'local', kind: 'wish.added', subject: 'w-1', idem: 'k1' },
    { tenant: 'local', kind: 'wish.added', subject: 'w-2', idem: 'k2' },
  ])
  const before = snapshotDir(stateDir(root))

  const text = cli(['repair-plan', root])
  assert(text.status === 0, 'repair-plan 命令存在且退出码 0')
  assert(/plan-digest=/.test(text.stdout ?? ''), '文本报告带 plan-digest')
  assert(/applyAuthorized=false/.test(text.stdout ?? ''), '文本报告显式声明 applyAuthorized=false')
  assert(/no_explicit_evidence/.test(text.stdout ?? ''), '无映射时逐条标注 no_explicit_evidence')

  const again = cli(['repair-plan', root])
  assert(again.stdout === text.stdout, 'CLI 重复执行 stdout 逐字节相同(幂等)')

  const mapPath = writeMapping(root, 'mapping.json', [
    { seq: 1, fromTenant: 'local', toTenant: 'tenant-a', evidence: '人工确认:issue #254 附件' },
  ])
  const withMap = cli(['repair-plan', root, '--mapping', mapPath, '--format', 'json'])
  assert(withMap.status === 0, '--mapping + --format json 可用')
  const parsed = JSON.parse(withMap.stdout) as RepairPlan
  assert(parsed.schema === 'gotry.ledger-repair-plan/1', 'JSON 输出带 schema 版本')
  assert(parsed.totals.move === 1 && parsed.applyAuthorized === false, 'JSON 计划:1 条搬移,applyAuthorized=false')

  const missing = cli(['repair-plan', root, '--mapping', join(root, 'nope.json')])
  assert(missing.status === 1, '映射文件缺失 → fail-closed 退出码 1')
  assert(/不可读/.test(missing.stderr ?? ''), '缺失映射有明确报错')

  writeMapping(root, 'bad.json', '{ not json')
  const badJson = cli(['repair-plan', root, '--mapping', join(root, 'bad.json')])
  assert(badJson.status === 1, '映射文件非法 JSON → fail-closed 退出码 1')

  const notArray = writeMapping(root, 'obj.json', { seq: 1 })
  const rootNotArray = cli(['repair-plan', root, '--mapping', notArray, '--format', 'json'])
  const rna = JSON.parse(rootNotArray.stdout) as RepairPlan
  assert(rna.rejectedMappings[0]?.reason === REPAIR_MAPPING_ROOT_NOT_ARRAY, '映射根节点非数组 → mapping_root_not_array')
  assert(rna.totals.move === 0, '根节点非数组时零搬移')

  const badFormat = cli(['repair-plan', root, '--format', 'yaml'])
  assert(badFormat.status === 1, '--format 非法值 fail-closed')
  const mapOnLog = cli(['log', root, '--mapping', mapPath])
  assert(mapOnLog.status === 1, '--mapping 只属于 repair-plan,用在 log 上被拒')
  const fmtOnStats = cli(['stats', root, '--format', 'json'])
  assert(fmtOnStats.status === 1, '--format 只属于 repair-plan,用在 stats 上被拒')
  const extraPos = cli(['repair-plan', root, 'extra'])
  assert(extraPos.status === 1, 'repair-plan 不接受额外位置参数')

  const after = snapshotDir(stateDir(root))
  assert(before === after, '零写:全部 CLI repair-plan 调用后 state 目录逐字节不变')

  const empty = newRoot('cli-empty')
  const noLedger = cli(['repair-plan', empty])
  assert(noLedger.status === 1 && /无账本/.test(noLedger.stderr ?? ''), '无账本 root → 退出码 1,不建库')
  assert(readdirSync(empty).length === 0, '无账本时不在 root 下创建任何文件/目录')
}

for (const r of roots) rmSync(r, { recursive: true, force: true })
console.log(`\nLEDGER-REPAIR-PLAN TESTS: ${pass} ok, ${fail} fail`)
if (fail > 0) process.exit(1)
