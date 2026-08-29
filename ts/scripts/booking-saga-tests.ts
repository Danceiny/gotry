/**
 * 预订 saga 状态机回归(booking_saga_fsm.v1,issue #17 采纳锚点,run-all §36):
 *  1 字母表/边表封闭性:12 个 (origin,trigger) 组合恰好一边或一拒,无空洞无重复;事件命名收敛
 *  2 触发解析:主路径可达;二次确认与吸收态推进结构化拒绝;解析器与边表/拒绝表十二格全一致
 *  3 审计链校验器:合法路径零违例;缺起点/双确认/补偿后再推进/空 receipt 均被抓出
 *  4 物理对账:真账本(pending_writes 行 + write.* 审计事件)与状态机逐格同归宿——
 *    状态机不是新机器,是 TS-4 saga 基座的具名化(词汇层与物理层分叉即本节红)
 *  5 多租户:saga 键以 tenant_id 为一等字段,跨租户互不可见(ADR-16)
 * 运行(在 ts/ 下):npx tsx scripts/booking-saga-tests.ts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BOOKING_SAGA_SCHEMA,
  SAGA_EDGES,
  SAGA_REJECTIONS,
  SAGA_STATUSES,
  SAGA_TRIGGER_EVENT,
  resolveSagaTrigger,
  sagaLegalPaths,
  sagaTraceViolations,
  type SagaAuditEvent,
} from '../src/booking-saga.ts'
import { ensureLedger, type StateLedger } from '../src/state-ledger.ts'

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

function parseReceipt(payload: string): string | undefined {
  try {
    const doc = JSON.parse(payload) as { receipt?: unknown }
    return typeof doc.receipt === 'string' && doc.receipt !== '' ? doc.receipt : undefined
  } catch {
    return undefined
  }
}

// ---- 1:字母表与边表封闭性 --------------------------------------------------------

const TRIGGERS = ['propose', 'confirm', 'compensate'] as const
const ORIGINS = ['none', ...SAGA_STATUSES] as const
const COMBOS = ORIGINS.flatMap(from => TRIGGERS.map(trigger => `${from}:${trigger}` as const))
const edgeKeys = new Set(SAGA_EDGES.map(e => `${e.from}:${e.trigger}` as const))
const rejectKeys = new Set(SAGA_REJECTIONS.map(e => `${e.from}:${e.trigger}` as const))

assert(BOOKING_SAGA_SCHEMA === 'booking_saga_fsm.v1' && SAGA_STATUSES.join(',') === 'pending,confirmed,compensated', 'schema 词唯一;状态字母表与 pending_writes CHECK 逐字一致')
assert(COMBOS.length === 12 && new Set(COMBOS).size === 12 && edgeKeys.size === SAGA_EDGES.length && rejectKeys.size === SAGA_REJECTIONS.length, '12 个 (origin,trigger) 组合;边表与拒绝表内部无重复')
assert(COMBOS.every(k => edgeKeys.has(k) !== rejectKeys.has(k)), '每格恰为一条合法边或一条结构化拒绝(全函数,无空洞无第三态)')
assert(SAGA_EDGES.every(e => (SAGA_STATUSES as readonly string[]).includes(e.to) && e.event === SAGA_TRIGGER_EVENT[e.trigger] && e.guard.length > 0), '合法边:终点在字母表内、事件 kind 与触发器一一对应、守卫语义齐全')

const allConsistent = ORIGINS.every(from => TRIGGERS.every(trigger => {
  const v = resolveSagaTrigger(from, trigger)
  const edge = SAGA_EDGES.find(e => e.from === from && e.trigger === trigger)
  if (edge) return v.ok && v.to === edge.to && v.event === edge.event
  return !v.ok && v.reason === SAGA_REJECTIONS.find(x => x.from === from && x.trigger === trigger)!.reason
}))
assert(allConsistent, 'resolveSagaTrigger 十二格与边表/拒绝表全一致(解析器无平行第二逻辑)')

// ---- 2:主路径、吸收态与审计链校验(纯函数) --------------------------------------

{
  const vProp = resolveSagaTrigger('none', 'propose')
  const vConf = resolveSagaTrigger('pending', 'confirm')
  const vComp = resolveSagaTrigger('confirmed', 'compensate')
  assert(vProp.ok && vProp.to === 'pending' && vConf.ok && vConf.to === 'confirmed' && vComp.ok && vComp.to === 'compensated', '主路径 ∅→pending→confirmed→compensated 连通(L2 登记只不执行 / L3 确认携 receipt / saga 补偿)')
  const vDouble = resolveSagaTrigger('confirmed', 'confirm')
  assert(!vDouble.ok && vDouble.reason === 'already-confirmed', '二次确认结构化拒绝(already-confirmed)')
  const vIdem = resolveSagaTrigger('compensated', 'propose')
  const vRevive = resolveSagaTrigger('compensated', 'confirm')
  const vReComp = resolveSagaTrigger('compensated', 'compensate')
  assert(!vIdem.ok && vIdem.reason === 'idem-exists' && !vRevive.ok && vRevive.reason === 'absorbed-compensated' && !vReComp.ok && vReComp.reason === 'already-compensated', 'compensated 吸收态:propose=幂等存在,confirm/compensate 拒绝(无复活路径)')

  assert(sagaLegalPaths().length === 4, '合法路径恰四条(主路径及其真前缀)')
  const legalClean = sagaLegalPaths().every(path => {
    const events: SagaAuditEvent[] = path.map((trigger, i) => ({ seq: i + 1, kind: SAGA_TRIGGER_EVENT[trigger], receipt: trigger === 'confirm' ? 'PNR-X' : undefined }))
    return sagaTraceViolations(events).length === 0
  })
  assert(legalClean, '四条合法路径的审计链均零违例')
  const flagOf = (events: SagaAuditEvent[]): string | undefined => sagaTraceViolations(events)[0]
  assert(flagOf([{ kind: 'write.confirmed', receipt: 'PNR-A' }]) !== undefined, '缺 pending 起点的 confirm 被审计链抓出')
  assert(flagOf([{ kind: 'write.pending' }, { kind: 'write.confirmed', receipt: 'PNR-A' }, { kind: 'write.confirmed', receipt: 'PNR-B' }]) !== undefined, '双确认被审计链抓出(每键至多确认一次)')
  assert(flagOf([{ kind: 'write.pending' }, { kind: 'write.compensated' }, { kind: 'write.confirmed', receipt: 'X' }]) !== undefined, 'compensated 之后不得再有 saga 事件(吸收态)')
  assert((flagOf([{ kind: 'write.pending' }, { kind: 'write.confirmed' }]) ?? '').includes('receipt'), 'write.confirmed 空 receipt 被抓(L3 必携外部回执)')
}

// ---- 3:物理对账(状态机 = 账本 saga 基座的词汇层,分叉即红) ---------------------

const root = mkdtempSync(join(tmpdir(), 'gotry-booking-saga-'))
try {
  const ledger = ensureLedger(root)
  const sagaEventsOf = (l: StateLedger, key: string): SagaAuditEvent[] => {
    const rows = l.db.prepare(`SELECT seq, kind, payload FROM events WHERE tenant_id = ? AND subject_id = ? AND kind IN ('write.pending','write.confirmed','write.compensated') ORDER BY seq`).all(l.tenant, key) as Array<{ seq: number; kind: string; payload: string }>
    return rows.map(r => ({ seq: r.seq, kind: r.kind, receipt: parseReceipt(r.payload) }))
  }

  const K1 = 'booking:K1'
  const proposed = ledger.requestPendingWrite({ idemKey: K1, seam: 'flight-order-confirm', payload: { flight: 'MU123' } })
  assert(proposed.created === true && proposed.status === 'pending' && resolveSagaTrigger('none', 'propose').to === 'pending', '物理提议 ∅→pending 与状态机同归宿(L2 只登记不执行)')

  const dup = ledger.requestPendingWrite({ idemKey: K1, seam: 'flight-order-confirm', payload: { flight: 'MU123' } })
  assert(dup.created === false && dup.status === 'pending' && resolveSagaTrigger('pending', 'propose').reason === 'idem-exists', '同幂等键重复提议:账本 no-op = 状态机 idem-exists')

  const confirmed = ledger.confirmPendingWrite(K1, 'PNR-A')
  assert(confirmed.ok === true && confirmed.status === 'confirmed' && resolveSagaTrigger('pending', 'confirm').to === 'confirmed', 'L3 具名确认 pending→confirmed(携 receipt)')
  const reConfirmed = ledger.confirmPendingWrite(K1, 'PNR-SHOULD-IGNORE')
  assert(reConfirmed.ok === false && (ledger.listPendingWrites().find(w => w.idem_key === K1)?.receipt ?? null) === 'PNR-A' && resolveSagaTrigger('confirmed', 'confirm').reason === 'already-confirmed', '二次确认被账本守卫拒绝且 receipt 不可变(仍为 PNR-A)')

  const compensated = ledger.compensatePendingWrite(K1, '用户改签退款')
  assert(compensated.ok === true && ledger.listPendingWrites().find(w => w.idem_key === K1)?.status === 'compensated', '已确认副作用可 saga 补偿(pending|confirmed → compensated)')

  const afterConfirm = ledger.confirmPendingWrite(K1, 'PNR-POST')
  const afterCompensate = ledger.compensatePendingWrite(K1, '重复补偿')
  const afterPropose = ledger.requestPendingWrite({ idemKey: K1, seam: 'flight-order-confirm', payload: {} })
  assert(afterConfirm.ok === false && afterCompensate.ok === false && afterPropose.created === false, '吸收态:compensated 后 confirm/compensate/propose 全拒,零复活')

  const audit = sagaEventsOf(ledger, K1)
  assert(audit.map(e => e.kind).join(',') === 'write.pending,write.confirmed,write.compensated', '审计事件链与边表路径同构(被拒调用零事件)')
  assert(sagaTraceViolations(audit).length === 0, '真实账本审计链过词汇层校验零违例')

  const K3 = 'booking:K3'
  ledger.requestPendingWrite({ idemKey: K3, seam: 'hotel-order-confirm', payload: {} })
  const emptyReceipt = ledger.confirmPendingWrite(K3, '')
  assert(emptyReceipt.ok === true && sagaTraceViolations(sagaEventsOf(ledger, K3)).some(v => v.includes('receipt')), '已知边界:账本物理层暂不挡空 receipt,词汇层审计链抓出(物理 CHECK 随 M5 拍板入 schema)')

  const other = ensureLedger(root, 'tenant-b')
  const crossProp = other.requestPendingWrite({ idemKey: K1, seam: 'flight-order-confirm', payload: {} })
  assert(crossProp.created === true, '同 idem_key 跨租户互不可见:tenant-b 可建自己的 K1(tenant_id 一等字段,ADR-16)')
  const LOCAL_ONLY = 'booking:local-only'
  ledger.requestPendingWrite({ idemKey: LOCAL_ONLY, seam: 'flight-order-confirm', payload: {} })
  const crossMissing = other.confirmPendingWrite(LOCAL_ONLY, 'PNR-CROSS')
  assert(crossMissing.ok === false && crossMissing.status === 'missing', 'tenant-b 看不到 local 的 saga 键(拒绝 missing)')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\nBOOKING SAGA TESTS: ${pass} ok, ${fail} fail`)
if (fail > 0) process.exit(1)