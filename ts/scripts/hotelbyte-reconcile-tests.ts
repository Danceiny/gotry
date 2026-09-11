/**
 * HotelByte 交易 bridge unknown 查单对账契约测试(issue #232;全离线纯函数,零真实供应商调用):
 *  1. book 执行分类:CLI exit0 ≠ 成功——timeout/kill/坏响应/exit0-non-JSON/无绑定/部分确认归 unknown,
 *     显式业务失败归 supplier_failed,只有带 customerReferenceNo 绑定的显式成功才 binding_verified
 *  2. 对账种子 fail-closed:attemptId/customerReferenceNo/idem_key/fingerprint 缺一即拒(可追溯红线)
 *  3. 查单 miss 在恢复窗口内(180s Phase1 + ≤10min Phase2)保持 unknown,结构性禁止重订
 *  4. 窗口届满本身不是无订单证明——仍 unknown,转人工对账,不允许新 intent
 *  5. 查单命中:终态成功(含迟到成功)→ reconciled_success;供应商终态取消/失败 → reconciled_failed
 *     (权威负证据,唯一允许新 intent 的路径);非终态 → 保持 unknown
 *  6. 查单冲突(同 ref 多单/参考号不匹配)→ 显式 conflict + manual_reconcile,不静默当成功也不丢弃
 *  7. 查询自身失败/畸形 → unknown 不变(探针失败不证明订单不存在);permission_denied → 人工
 *  8. 人工确认无订单(须绑定 attempt 的非空操作证据)→ reconciled_failed + 允许新 intent
 *  9. 终态后出现反证(迟到命中)→ 只置 conflict 交人工,不静默翻转
 * 10. 可追溯:每条事件带 probeDigest;记录携带 fact_id/审批 digest/outbox 占位/attempt;
 *     纯函数——推进返回新状态,原状态不可变
 *
 * 运行: cd ts && npx tsx scripts/hotelbyte-reconcile-tests.ts
 */

import assert from 'node:assert/strict'
import {
  classifyBookExecution,
  enterUnknown,
  advanceReconciliation,
  recoveryWindowEndsAt,
  newIntentAllowed,
  type BookExecutionResult,
  type ReconciliationState,
  type QueryOrdersProbe,
} from '../capabilities/hotelbyte-transaction.ts'

const T0 = '2026-09-11T10:00:00.000Z'
const WINDOW_END = recoveryWindowEndsAt(T0)

/** 标准对账种子:绑定键齐全,可追溯字段占位(fact_id / 审批 digest / outbox intent) */
function seed(overrides: Partial<Parameters<typeof enterUnknown>[0]> = {}): ReconciliationState {
  return enterUnknown({
    attemptId: 'att-0001',
    customerReferenceNo: 'REF-GOTRY-0001',
    intentIdemKey: 'idem-book-abc',
    requestFingerprintSha256: 'f'.repeat(64),
    enteredUnknownAt: T0,
    recoveryWindowEndsAt: WINDOW_END,
    factId: 'fact_hotel_123',
    approvalReceiptDigest: 'receipt-digest-01',
    outboxIntentRef: 'outbox-intent-01',
    ...overrides,
  })
}

function bookResult(overrides: Partial<BookExecutionResult> = {}): BookExecutionResult {
  return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', ...overrides }
}

// ── 1. book 执行分类:exit0 非成功证明 ────────────────────────────────────────
const timeoutCls = classifyBookExecution(bookResult({ timedOut: true }), 'REF-GOTRY-0001')
assert.equal(timeoutCls.kind, 'unknown', '超时 → unknown')
assert.match(timeoutCls.reason, /timeout/)

const killCls = classifyBookExecution(bookResult({ signal: 'SIGKILL' }), 'REF-GOTRY-0001')
assert.equal(killCls.kind, 'unknown', '进程被杀 → unknown')

const nonJsonCls = classifyBookExecution(bookResult({ stdout: 'OK booking done' }), 'REF-GOTRY-0001')
assert.equal(nonJsonCls.kind, 'unknown', 'exit0 + 非 JSON 输出 → unknown(坏响应)')

const unboundCls = classifyBookExecution(
  bookResult({ stdout: JSON.stringify({ status: 'success', orderRef: 'HB-1' }) }),
  'REF-GOTRY-0001',
)
assert.equal(unboundCls.kind, 'unknown', 'exit0 + success 但缺 customerReferenceNo 绑定 → unknown(不可归因)')

const mismatchCls = classifyBookExecution(
  bookResult({ stdout: JSON.stringify({ status: 'success', customerReferenceNo: 'REF-OTHER' }) }),
  'REF-GOTRY-0001',
)
assert.equal(mismatchCls.kind, 'unknown', 'exit0 + success 但参考号不属于本 attempt → unknown')

const pendingCls = classifyBookExecution(
  bookResult({ stdout: JSON.stringify({ status: 'pending', customerReferenceNo: 'REF-GOTRY-0001' }) }),
  'REF-GOTRY-0001',
)
assert.equal(pendingCls.kind, 'unknown', '部分确认(pending)→ unknown,不静默当成功')

const failedCls = classifyBookExecution(
  bookResult({ stdout: JSON.stringify({ status: 'failed', customerReferenceNo: 'REF-GOTRY-0001' }) }),
  'REF-GOTRY-0001',
)
assert.equal(failedCls.kind, 'supplier_failed', '显式业务失败 → supplier_failed')

const nonzeroCls = classifyBookExecution(bookResult({ exitCode: 2, stderr: 'boom' }), 'REF-GOTRY-0001')
assert.equal(nonzeroCls.kind, 'unknown', '非零退码且无可解析业务结论 → unknown(不假定无副作用)')

const verifiedCls = classifyBookExecution(
  bookResult({ stdout: JSON.stringify({ status: 'success', customerReferenceNo: 'REF-GOTRY-0001', orderRef: 'HB-9' }) }),
  'REF-GOTRY-0001',
)
assert.equal(verifiedCls.kind, 'binding_verified', '带绑定参考号的显式成功 → binding_verified')

// ── 2. 对账种子 fail-closed:绑定键缺一即拒 ─────────────────────────────────
for (const [field, broken] of [
  ['attemptId', { attemptId: '' }],
  ['customerReferenceNo', { customerReferenceNo: '   ' }],
  ['intentIdemKey', { intentIdemKey: '' }],
  ['requestFingerprintSha256', { requestFingerprintSha256: '' }],
  ['recoveryWindowEndsAt', { recoveryWindowEndsAt: '' }],
] as const) {
  assert.throws(() => seed(broken as never), Error, `缺 ${field} → 拒绝对账记录(fail-closed)`)
}

// ── 3. 恢复窗口内 miss → 保持 unknown,禁止重订 ──────────────────────────────
const withinWindow = advanceReconciliation(seed(), { kind: 'miss' }, '2026-09-11T10:05:00.000Z')
assert.equal(withinWindow.status, 'unknown', '窗口内 miss → 仍 unknown')
assert.equal(withinWindow.nextAction, 'keep_querying', '窗口内 miss → 继续查单')
assert.equal(newIntentAllowed(withinWindow), false, 'unknown 期间结构性禁止新 intent(不重订)')

// ── 4. 窗口届满本身不是无订单证明 ────────────────────────────────────────────
const pastWindow = advanceReconciliation(seed(), { kind: 'miss' }, '2026-09-11T10:30:00.000Z')
assert.equal(pastWindow.status, 'unknown', '窗口届满 miss → 仍 unknown(不是 reconciled_failed)')
assert.equal(pastWindow.nextAction, 'manual_reconcile', '窗口届满 → 转人工对账')
assert.equal(newIntentAllowed(pastWindow), false, '时间届满不允许自动新 intent')

// ── 5. 查单命中:终态成功 / 迟到成功 / 供应商终态取消 / 非终态 ────────────────
const hitConfirmed = advanceReconciliation(
  seed(),
  { kind: 'hit', orders: [{ customerReferenceNo: 'REF-GOTRY-0001', orderRef: 'HB-1', supplierStatus: 'confirmed' }] },
  '2026-09-11T10:02:00.000Z',
)
assert.equal(hitConfirmed.status, 'reconciled_success', '命中终态成功 → reconciled_success')
assert.equal(newIntentAllowed(hitConfirmed), false, '已成立订单 → 不允许同请求新 intent')

// 迟到成功:窗口外才查到,unknown 升级 reconciled_success,不重订
const lateHit = advanceReconciliation(
  advanceReconciliation(seed(), { kind: 'miss' }, '2026-09-11T10:20:00.000Z'),
  { kind: 'hit', orders: [{ customerReferenceNo: 'REF-GOTRY-0001', orderRef: 'HB-1', supplierStatus: 'confirmed' }] },
  '2026-09-11T10:25:00.000Z',
)
assert.equal(lateHit.status, 'reconciled_success', '窗口外迟到成功 → unknown 升级 reconciled_success')
assert.ok(lateHit.history.some((e) => e.to === 'reconciled_success'), '升级路径进审计链')

const hitCanceled = advanceReconciliation(
  seed(),
  { kind: 'hit', orders: [{ customerReferenceNo: 'REF-GOTRY-0001', orderRef: 'HB-2', supplierStatus: 'auto_canceled' }] },
  '2026-09-11T10:02:00.000Z',
)
assert.equal(hitCanceled.status, 'reconciled_failed', '供应商终态自动取消 → reconciled_failed(按供应商回执)')
assert.equal(newIntentAllowed(hitCanceled), true, '绑定 attempt 的权威负证据 → 允许新 intent')

const hitProcessing = advanceReconciliation(
  seed(),
  { kind: 'hit', orders: [{ customerReferenceNo: 'REF-GOTRY-0001', orderRef: 'HB-3', supplierStatus: 'processing' }] },
  '2026-09-11T10:02:00.000Z',
)
assert.equal(hitProcessing.status, 'unknown', '命中但非终态 → 仍 unknown')
assert.equal(hitProcessing.nextAction, 'keep_querying', '非终态命中 → 继续查单')

// ── 6. 查单冲突:多单 / 参考号不匹配 → 显式 conflict + 人工,不静默成功不丢弃 ──
const multi = advanceReconciliation(
  seed(),
  { kind: 'hit', orders: [
    { customerReferenceNo: 'REF-GOTRY-0001', orderRef: 'HB-A', supplierStatus: 'confirmed' },
    { customerReferenceNo: 'REF-GOTRY-0001', orderRef: 'HB-B', supplierStatus: 'confirmed' },
  ] },
  '2026-09-11T10:02:00.000Z',
)
assert.equal(multi.status, 'unknown', '同 ref 多单 → 不静默当成功')
assert.equal(multi.nextAction, 'manual_reconcile', '多单冲突 → 人工对账')
assert.equal(multi.conflict, true, '多单冲突显式标记')

const foreignRef = advanceReconciliation(
  seed(),
  { kind: 'hit', orders: [{ customerReferenceNo: 'REF-OTHER', orderRef: 'HB-C', supplierStatus: 'confirmed' }] },
  '2026-09-11T10:02:00.000Z',
)
assert.equal(foreignRef.status, 'unknown', '返回的订单不属于本参考号 → 不静默当成功也不丢弃')
assert.equal(foreignRef.conflict, true, '参考号不匹配 → 显式 conflict')
assert.equal(foreignRef.nextAction, 'manual_reconcile', '参考号不匹配 → 人工对账')

// ── 7. 查询自身失败/畸形/权限拒绝:探针失败不证明订单不存在 ─────────────────
const qFailed = advanceReconciliation(seed(), { kind: 'query_failed', reason: 'transport down' }, '2026-09-11T10:02:00.000Z')
assert.equal(qFailed.status, 'unknown', '查询失败 → 仍 unknown')
assert.equal(qFailed.nextAction, 'keep_querying', '查询失败 → 继续查单')

const malformed = advanceReconciliation(seed(), { kind: 'malformed', reason: 'unparseable body' }, '2026-09-11T10:02:00.000Z')
assert.equal(malformed.status, 'unknown', '畸形响应 → 仍 unknown(不静默当 miss)')

const denied = advanceReconciliation(seed(), { kind: 'permission_denied' }, '2026-09-11T10:02:00.000Z')
assert.equal(denied.status, 'unknown', '权限拒绝 → 仍 unknown')
assert.equal(denied.nextAction, 'manual_reconcile', '权限拒绝 → 人工承接')

// ── 8. 人工确认无订单:绑定 attempt 的非空操作证据才生效 ─────────────────────
const manualOk = advanceReconciliation(
  pastWindow,
  { kind: 'manual_no_order', operatorEvidence: 'op-7: UAT 后台按 REF-GOTRY-0001 + attempt att-0001 查无订单,截图存档 #rev-41' },
  '2026-09-11T11:00:00.000Z',
)
assert.equal(manualOk.status, 'reconciled_failed', '人工确认无订单 → reconciled_failed')
assert.equal(newIntentAllowed(manualOk), true, '人工权威负证据 → 允许新 intent')
assert.throws(
  () => advanceReconciliation(pastWindow, { kind: 'manual_no_order', operatorEvidence: '   ' }, '2026-09-11T11:00:00.000Z'),
  Error,
  '空操作证据的人工无订单确认 → 拒绝',
)
const manualTooEarly = advanceReconciliation(seed(), { kind: 'manual_no_order', operatorEvidence: 'op claim' }, T0)
assert.equal(manualTooEarly.status, 'reconciled_failed', '窗口内人工确认亦为权威负证据(人工可早于窗口收敛)')

// ── 9. 终态后出现反证:只置 conflict 交人工,不静默翻转 ──────────────────────
const lateAfterFailed = advanceReconciliation(
  manualOk,
  { kind: 'hit', orders: [{ customerReferenceNo: 'REF-GOTRY-0001', orderRef: 'HB-X', supplierStatus: 'confirmed' }] },
  '2026-09-11T12:00:00.000Z',
)
assert.equal(lateAfterFailed.status, 'reconciled_failed', '终态不被静默翻转')
assert.equal(lateAfterFailed.conflict, true, '终态后命中 → 显式冲突标记')
assert.equal(lateAfterFailed.nextAction, 'manual_reconcile', '终态后命中 → 人工复核')
assert.equal(newIntentAllowed(lateAfterFailed), false, '冲突未解 → 新 intent 冻结')

// ── 10. 可追溯 + 纯函数不可变 ────────────────────────────────────────────────
const before = advanceReconciliation(seed(), { kind: 'miss' }, '2026-09-11T10:05:00.000Z')
assert.ok(before.history.length >= 2, 'enter_unknown + query_miss 都进审计链')
assert.ok(before.history.every((e) => typeof e.probeDigest === 'string' && /^[0-9a-f]{64}$/.test(e.probeDigest)), '每条事件带 probeDigest')
assert.equal(before.attemptId, 'att-0001', 'attemptId 不变(不可变 attempt)')
const afterSecond = advanceReconciliation(before, { kind: 'miss' }, '2026-09-11T10:06:00.000Z')
assert.ok(afterSecond.history.length > before.history.length, '推进追加事件')
assert.equal(before.history.length + 1, afterSecond.history.length, '原状态不被修改(纯函数)')
assert.equal(before.factId, 'fact_hotel_123', 'fact_id 关联保留')
assert.equal(before.approvalReceiptDigest, 'receipt-digest-01', '审批 receipt digest 关联保留')
assert.equal(before.outboxIntentRef, 'outbox-intent-01', 'outbox intent 占位(#231)关联保留')
assert.equal(recoveryWindowEndsAt(T0), '2026-09-11T10:13:00.000Z', '恢复窗口 = 180s Phase1 + 600s Phase2 上界(780s)')

console.log('HOTELBYTE RECONCILE TESTS: 10/10 OK(book 分类 exit0≠成功 / 种子 fail-closed / 窗口内 miss 保 unknown / 届满非无订单证明 / 命中终态与迟到收敛 / 冲突显式人工 / 探针失败不证明不存在 / 人工权威负证据 / 终态反证只置 conflict / 可追溯+不可变)')
