/**
 * Booking Copilot unavailable/changed 恢复链契约测试（issue #142 非门控切片；全离线纯函数，零真实供应商调用）：
 *  1. 检测分类（复用 ActionReceipt status 闭集，不发明新通道）：confirmed / changed（版本被取代=价格变动/房型关闭）/
 *     unavailable（完整负证据）/ inconclusive（partial/stale/failed/gap——不得宣称「市场无房」）/ unrelated（非 offer.check 观测）
 *  2. 分类 fail-closed：available+empty outcome、!available 却携 verifiedOfferRef、unavailable 却非 empty outcome、
 *     applied/changed/unavailable 却观测形态不符——全部抛 availability_receipt_incoherent 同名错误
 *  3. 链开立 fail-closed：confirmed → recovery_chain_not_required；unrelated → recovery_trigger_absent；
 *     taskId/contextRef/originalSelection 绑定键缺一即拒
 *  4. 受控恢复（不开新无界重试通道）：approach 闭集 recheck_version/requery_same_hotel/alternative_candidate；
 *     每次计入预算的恢复轮对齐 planner 三次调用预算（第 4 次拒绝）；终态吸收，其后不得再有 attempt
 *  5. 用户沟通红线：恢复命中与原选择不同酒店/报价且未先披露 → recovery_silent_swap_forbidden（静默换房换航结构性拒绝）；
 *     先披露再解决 → 合法；空披露文本拒绝；降级必须携显式披露（静默降级拒绝）
 *  6. 显式说明变化：版本位移的 resolved 必须产出非空变化说明（old→new versionRef）——不静默换版
 *  7. 审计可对账（对齐 sagaTraceViolations 形态）：合法链空违例；缺 detected 起点/终态后事件/静默替换/静默降级/未知 kind 全部违例
 *  8. 纯函数：每次推进返回新状态，原状态不可变；receiptDigestOf 规范摘要稳定且随内容变化
 *
 * 运行：cd ts && npx tsx scripts/booking-recovery-chain-tests.ts
 */

import assert from 'node:assert/strict'
import type { ActionReceipt } from '../src/booking-surface/contracts.ts'
import {  RECOVERY_CHAIN_SCHEMA,
  MAX_RECOVERY_MODEL_TURNS_PER_TRIGGER,
  MAX_RECOVERY_BUDGET_NOTE,
  classifyRecoveryTrigger,
  receiptDigestOf,
  openRecoveryChain,
  attemptRecoveryStep,
  discloseSubstitution,
  degradeRecoveryChain,
  buildUserDisclosure,
  recoveryAuditViolations,
  type RecoveryChainState,
} from '../src/booking-surface/recovery-chain.ts'

const T0 = '2026-09-11T10:00:00.000Z'
const T1 = '2026-09-11T10:00:01.000Z'
const T2 = '2026-09-11T10:00:02.000Z'

const ORIGINAL = { hotelRef: 'hotel-1', offerRef: 'offer-1', offerVersionRef: 'v1' }

const CLEAN_CONTRACT = { outcome: 'complete' as const, hardCriteriaMet: true, factRefs: [], gapCodes: [], blockers: [], relaxationsApplied: [] }

function receipt(overrides: Partial<ActionReceipt>): ActionReceipt {
  return {
    schemaVersion: 'booking.surface',
    kind: 'action.receipt',
    actionId: 'act-1',
    contextRef: 'ctx-1',
    status: 'applied',
    revision: 3,
    observation: { kind: 'offer.availability', offerRef: ORIGINAL.offerRef, checkedOfferVersionRef: ORIGINAL.offerVersionRef, available: true, currentOfferVersionRef: ORIGINAL.offerVersionRef, verifiedOfferRef: 'verified-1', changedFactRefs: [] },
    resultContract: CLEAN_CONTRACT,
    ...overrides,
  } as ActionReceipt
}

function seedChain(overrides: Partial<Parameters<typeof openRecoveryChain>[0]> = {}): RecoveryChainState {
  return openRecoveryChain({
    taskId: 'task-1',
    contextRef: 'ctx-1',
    receipt: receipt({ status: 'unavailable', observation: { kind: 'offer.availability', offerRef: ORIGINAL.offerRef, checkedOfferVersionRef: ORIGINAL.offerVersionRef, available: false, changedFactRefs: [] }, resultContract: { ...CLEAN_CONTRACT, outcome: 'empty' } }),
    originalSelection: ORIGINAL,
    at: T0,
    ...overrides,
  })
}

// ── 1. 检测分类：复用 status 闭集 ────────────────────────────────────────────
const confirmedCls = classifyRecoveryTrigger(receipt({}))
assert.equal(confirmedCls.kind, 'confirmed', 'applied+available+版本一致+verified → confirmed')
assert.equal((confirmedCls as { verifiedOfferRef: string }).verifiedOfferRef, 'verified-1')

const changedCls = classifyRecoveryTrigger(receipt({
  status: 'changed',
  observation: { kind: 'offer.availability', offerRef: ORIGINAL.offerRef, checkedOfferVersionRef: ORIGINAL.offerVersionRef, available: true, currentOfferVersionRef: 'v2', verifiedOfferRef: undefined, changedFactRefs: ['fact.price'] } as ActionReceipt['observation'],
}))
assert.equal(changedCls.kind, 'changed', 'changed+available+后继版本 → changed（价格变动/房型关闭的供应商形态）')
assert.equal((changedCls as { currentOfferVersionRef?: string }).currentOfferVersionRef, 'v2')
assert.deepEqual((changedCls as { changedFactRefs: string[] }).changedFactRefs, ['fact.price'])

const unavailableCls = classifyRecoveryTrigger(receipt({ status: 'unavailable', observation: { kind: 'offer.availability', offerRef: ORIGINAL.offerRef, checkedOfferVersionRef: ORIGINAL.offerVersionRef, available: false, changedFactRefs: [] }, resultContract: { ...CLEAN_CONTRACT, outcome: 'empty' } }))
assert.equal(unavailableCls.kind, 'unavailable', 'unavailable+!available+empty outcome → unavailable（完整负证据）')

const noMatchCls = classifyRecoveryTrigger(receipt({ status: 'no_match', observation: { kind: 'offer.availability', offerRef: ORIGINAL.offerRef, checkedOfferVersionRef: ORIGINAL.offerVersionRef, available: false, changedFactRefs: [] }, resultContract: { ...CLEAN_CONTRACT, outcome: 'empty' } }))
assert.equal(noMatchCls.kind, 'unavailable', 'no_match 同归 unavailable 闭集（既有词汇）')

for (const [status, extra] of [
  ['partial', { resultContract: { ...CLEAN_CONTRACT, outcome: 'partial' as const } }],
  ['stale', {}],
  ['failed', {}],
  ['needs_input', {}],
] as const) {
  const cls = classifyRecoveryTrigger(receipt({ status, observation: { kind: 'offer.availability', offerRef: ORIGINAL.offerRef, checkedOfferVersionRef: ORIGINAL.offerVersionRef, available: false, changedFactRefs: [], gapCodes: ['check_avail_unverified'] } as ActionReceipt['observation'], ...extra }))
  assert.equal(cls.kind, 'inconclusive', `${status} → inconclusive`)
  assert.match((cls as { reason: string }).reason, /not_claim_market_empty/, 'inconclusive 必须携带「不得宣称市场无房」语义')
}

const gapCls = classifyRecoveryTrigger(receipt({ status: 'partial', observation: { kind: 'gap', code: 'check_avail_failed', factRefs: [] }, resultContract: { ...CLEAN_CONTRACT, outcome: 'partial' } }))
assert.equal(gapCls.kind, 'inconclusive', 'gap 观测 → inconclusive（不可确认 ≠ 无房）')

assert.equal(classifyRecoveryTrigger(receipt({ observation: { kind: 'offers.state', hotelRefs: [ORIGINAL.hotelRef], offerRefs: [ORIGINAL.offerRef], loadedHotelCount: 1 } })).kind, 'unrelated', 'offers.query 观测不是 offer 级恢复触发（generation 折叠归 policy 所有）')
assert.equal(classifyRecoveryTrigger(receipt({ observation: { kind: 'search.state', resultCount: 3 } })).kind, 'unrelated', 'search.state → unrelated')

// ── 2. 分类 fail-closed：不连贯 receipt 拒绝 ────────────────────────────────
assert.throws(() => classifyRecoveryTrigger(receipt({ status: 'unavailable', resultContract: { ...CLEAN_CONTRACT, outcome: 'empty' } })), /availability_receipt_incoherent/, 'available=true + unavailable status → 不连贯')
assert.throws(() => classifyRecoveryTrigger(receipt({ status: 'unavailable', observation: { kind: 'offer.availability', offerRef: ORIGINAL.offerRef, checkedOfferVersionRef: ORIGINAL.offerVersionRef, available: false, verifiedOfferRef: 'verified-x', changedFactRefs: [] } as ActionReceipt['observation'], resultContract: { ...CLEAN_CONTRACT, outcome: 'empty' } })), /availability_receipt_incoherent/, '!available 却携 verifiedOfferRef → 不连贯')
assert.throws(() => classifyRecoveryTrigger(receipt({ status: 'unavailable', observation: { kind: 'offer.availability', offerRef: ORIGINAL.offerRef, checkedOfferVersionRef: ORIGINAL.offerVersionRef, available: false, changedFactRefs: [] }, resultContract: { ...CLEAN_CONTRACT, outcome: 'partial' } })), /availability_receipt_incoherent/, 'unavailable 却非 empty outcome → 不连贯')
assert.throws(() => classifyRecoveryTrigger(receipt({ status: 'changed', observation: { kind: 'search.state', resultCount: 1 } })), /availability_observation_required/, 'changed 却无 offer.availability 观测 → 观测缺失')

// ── 3. 链开立：fail-closed ─────────────────────────────────────────────────
assert.throws(() => openRecoveryChain({ taskId: 'task-1', contextRef: 'ctx-1', receipt: receipt({}), originalSelection: ORIGINAL, at: T0 }), /recovery_chain_not_required/, 'confirmed 无需恢复链')
assert.throws(() => openRecoveryChain({ taskId: 'task-1', contextRef: 'ctx-1', receipt: receipt({ observation: { kind: 'search.state', resultCount: 1 } }), originalSelection: ORIGINAL, at: T0 }), /recovery_trigger_absent/, 'unrelated 不开链')
assert.throws(() => seedChain({ taskId: '' }), /recovery_binding_missing/, 'taskId 缺失即拒')
assert.throws(() => seedChain({ contextRef: '' }), /recovery_binding_missing/, 'contextRef 缺失即拒')
assert.throws(() => seedChain({ originalSelection: { ...ORIGINAL, offerRef: '' } }), /recovery_binding_missing/, '原选择 offerRef 缺失即拒')

const chain = seedChain()
assert.equal(chain.schemaVersion, RECOVERY_CHAIN_SCHEMA)
assert.equal(chain.trigger, 'unavailable')
assert.equal(chain.phase, 'detected')
assert.equal(chain.countedModelTurns, 0)
assert.deepEqual(chain.originalSelection, ORIGINAL)
assert.equal(chain.history.length, 1)
assert.equal(chain.history[0]!.kind, 'recovery.detected')
assert.ok(chain.history[0]!.receiptDigest?.length === 64, 'detected 事件带 receipt 摘要')

const changedChain = openRecoveryChain({
  taskId: 'task-1', contextRef: 'ctx-1',
  receipt: receipt({ status: 'changed', observation: { kind: 'offer.availability', offerRef: ORIGINAL.offerRef, checkedOfferVersionRef: ORIGINAL.offerVersionRef, available: true, currentOfferVersionRef: 'v2', changedFactRefs: ['fact.price'] } as ActionReceipt['observation'] }),
  originalSelection: ORIGINAL, at: T0,
})
assert.equal(changedChain.trigger, 'changed')

// ── 4. 受控恢复：approach 闭集 + 三轮预算 + 终态吸收 ────────────────────────
const afterQuery = attemptRecoveryStep(chain, { receipt: receipt({ status: 'unavailable', observation: { kind: 'offer.availability', offerRef: ORIGINAL.offerRef, checkedOfferVersionRef: ORIGINAL.offerVersionRef, available: false, changedFactRefs: [] }, resultContract: { ...CLEAN_CONTRACT, outcome: 'empty' } }), target: ORIGINAL, approach: 'requery_same_hotel' }, T1)
assert.equal(afterQuery.phase, 'recovering')
assert.equal(afterQuery.countedModelTurns, 1, '恢复轮计入预算')
assert.equal(afterQuery.history.length, 2)
assert.equal(afterQuery.history[1]!.kind, 'recovery.attempt')
assert.deepEqual(afterQuery.history[1]!.target, ORIGINAL)

assert.throws(() => attemptRecoveryStep(chain, { receipt: receipt({}), target: ORIGINAL, approach: 'wild_retry' as never }, T1), /recovery_approach_invalid/, 'approach 不在闭集即拒（不开新重试通道）')
assert.throws(() => attemptRecoveryStep(afterQuery, { receipt: receipt({ status: 'unavailable', observation: { kind: 'offer.availability', offerRef: ORIGINAL.offerRef, checkedOfferVersionRef: ORIGINAL.offerVersionRef, available: false, verifiedOfferRef: 'verified-x', changedFactRefs: [] } as ActionReceipt['observation'], resultContract: { ...CLEAN_CONTRACT, outcome: 'empty' } }), target: ORIGINAL, approach: 'requery_same_hotel' }, T1), /availability_receipt_incoherent/, 'attempt 携带不连贯 receipt 拒绝（不可确认当证据）')

// confirmed 于同 offer 同版本 → resolved（无需替换披露）
const recovered = attemptRecoveryStep(afterQuery, { receipt: receipt({}), target: ORIGINAL, approach: 'requery_same_hotel' }, T2)
assert.equal(recovered.phase, 'resolved')
assert.deepEqual(recovered.resolvedTo, ORIGINAL)
assert.equal(recovered.history.at(-1)!.kind, 'recovery.resolved')
assert.throws(() => attemptRecoveryStep(recovered, { receipt: receipt({ status: 'unavailable', observation: { kind: 'offer.availability', offerRef: ORIGINAL.offerRef, checkedOfferVersionRef: ORIGINAL.offerVersionRef, available: false, changedFactRefs: [] }, resultContract: { ...CLEAN_CONTRACT, outcome: 'empty' } }), target: ORIGINAL, approach: 'requery_same_hotel' }, T2), /recovery_chain_terminal/, '终态吸收：resolved 后不得再有 attempt')

// changed 触发 → recheck_version 路径也走闭集
const rechecked = attemptRecoveryStep(changedChain, { receipt: receipt({}), target: { ...ORIGINAL, offerVersionRef: 'v2' }, approach: 'recheck_version' }, T1)
assert.equal(rechecked.phase, 'resolved')
assert.deepEqual(rechecked.resolvedTo, { ...ORIGINAL, offerVersionRef: 'v2' })
const recheckDisclosure = buildUserDisclosure(rechecked)
assert.equal(recheckDisclosure.substitution, false, '同酒店同报价仅版本位移不是替换')
assert.equal(recheckDisclosure.versionShifted, true)
assert.match(recheckDisclosure.text, /v1/, '变化说明必须显式含旧版本')
assert.match(recheckDisclosure.text, /v2/, '变化说明必须显式含新版本')

// 三轮模型调用预算（对齐 planner attempt < 3）
let budgetChain = seedChain()
for (let turn = 0; turn < MAX_RECOVERY_MODEL_TURNS_PER_TRIGGER; turn += 1) {
  budgetChain = attemptRecoveryStep(budgetChain, { receipt: receipt({ status: 'unavailable', observation: { kind: 'offer.availability', offerRef: ORIGINAL.offerRef, checkedOfferVersionRef: ORIGINAL.offerVersionRef, available: false, changedFactRefs: [] }, resultContract: { ...CLEAN_CONTRACT, outcome: 'empty' } }), target: ORIGINAL, approach: 'requery_same_hotel' }, T1)
}
assert.equal(budgetChain.countedModelTurns, MAX_RECOVERY_MODEL_TURNS_PER_TRIGGER)
assert.ok(MAX_RECOVERY_BUDGET_NOTE.includes('3'), '预算语义说明对齐 planner 三次调用')
assert.throws(() => attemptRecoveryStep(budgetChain, { receipt: receipt({ status: 'unavailable', observation: { kind: 'offer.availability', offerRef: ORIGINAL.offerRef, checkedOfferVersionRef: ORIGINAL.offerVersionRef, available: false, changedFactRefs: [] }, resultContract: { ...CLEAN_CONTRACT, outcome: 'empty' } }), target: ORIGINAL, approach: 'requery_same_hotel' }, T1), /recovery_model_turn_budget_exhausted/, '第 4 次计入预算的恢复轮拒绝——必须降级')

// ── 5. 用户沟通红线：静默换房换航结构性拒绝 ────────────────────────────────
const substituteTarget = { hotelRef: 'hotel-2', offerRef: 'offer-9', offerVersionRef: 'v9' }
assert.throws(() => attemptRecoveryStep(afterQuery, { receipt: receipt({}), target: substituteTarget, approach: 'alternative_candidate' }, T2), /recovery_silent_swap_forbidden/, '未披露先换酒店 → 静默换房拒绝')
assert.equal(afterQuery.phase, 'recovering', '拒绝即不动（纯函数，原状态不变）')

const disclosed = discloseSubstitution(afterQuery, { target: substituteTarget, disclosureText: '原报价已不可用，替代候选为 hotel-2 的 offer-9（价格已变化）', at: T2 })
assert.equal(disclosed.substitutionDisclosed, true)
assert.equal(disclosed.history.at(-1)!.kind, 'recovery.disclosed')
assert.equal(disclosed.history.at(-1)!.substitution, true)
assert.throws(() => discloseSubstitution(afterQuery, { target: substituteTarget, disclosureText: '', at: T2 }), /recovery_disclosure_required/, '空披露文本拒绝')

const substituted = attemptRecoveryStep(disclosed, { receipt: receipt({}), target: substituteTarget, approach: 'alternative_candidate' }, T2)
assert.equal(substituted.phase, 'resolved')
assert.deepEqual(substituted.resolvedTo, substituteTarget)
const subDisclosure = buildUserDisclosure(substituted)
assert.equal(subDisclosure.substitution, true, '替换解决必须显式标记')
assert.match(subDisclosure.text, /hotel-1/, '说明必须提及原酒店')
assert.match(subDisclosure.text, /hotel-2/, '说明必须提及替代酒店')

assert.throws(() => discloseSubstitution(recovered, { target: substituteTarget, disclosureText: 'x', at: T2 }), /recovery_chain_terminal/, '终态后不得再披露')

// 降级：静默降级拒绝；显式披露后降级合法且吸收
assert.throws(() => degradeRecoveryChain(budgetChain, { reason: 'budget exhausted', disclosureText: '', at: T2 }), /recovery_degrade_requires_disclosure/, '静默降级拒绝')
const degraded = degradeRecoveryChain(budgetChain, { reason: 'recovery budget exhausted', disclosureText: '原报价已不可用且恢复预算耗尽，任务显式结束，未做任何替换', at: T2 })
assert.equal(degraded.phase, 'degraded')
assert.equal(degraded.history.at(-1)!.kind, 'recovery.degraded')
assert.ok(degraded.history.some((event) => event.kind === 'recovery.disclosed'), '降级前必有显式披露事件')
assert.throws(() => degradeRecoveryChain(degraded, { reason: 'again', disclosureText: 'x', at: T2 }), /recovery_chain_terminal/, '降级吸收')

// ── 6+7. 审计链校验（sagaTraceViolations 同形态） ──────────────────────────
assert.deepEqual(recoveryAuditViolations(recovered.history), [], '合法恢复链零违例')
assert.deepEqual(recoveryAuditViolations(substituted.history), [], '合法替换链零违例')
assert.deepEqual(recoveryAuditViolations(degraded.history), [], '合法降级链零违例')

assert.ok(recoveryAuditViolations([{ at: T0, kind: 'recovery.attempt', from: 'detected', to: 'recovering', reason: 'x' }]).length > 0, '缺 detected 起点违例')
assert.ok(recoveryAuditViolations([...recovered.history, { at: T2, kind: 'recovery.attempt', from: 'resolved', to: 'recovering', reason: 'late' }]).length > 0, '终态后事件违例')
assert.ok(recoveryAuditViolations([{ at: T0, kind: 'recovery.detected', from: 'detected', to: 'detected', reason: 'x', target: ORIGINAL }, { at: T1, kind: 'recovery.resolved', from: 'detected', to: 'resolved', reason: 'swap', target: substituteTarget }]).length > 0, '静默替换（无披露的异目标 resolved）违例')
assert.ok(recoveryAuditViolations([{ at: T0, kind: 'recovery.detected', from: 'detected', to: 'detected', reason: 'x', target: ORIGINAL }, { at: T1, kind: 'recovery.degraded', from: 'detected', to: 'degraded', reason: 'x' }]).length > 0, '静默降级（无披露）违例')
assert.ok(recoveryAuditViolations([{ at: T0, kind: 'recovery.detected', from: 'detected', to: 'detected', reason: 'x', target: ORIGINAL }, { at: T1, kind: 'recovery.exploded' as never, from: 'detected', to: 'recovering', reason: 'x' }]).length > 0, '未知事件 kind 违例')
assert.ok(recoveryAuditViolations([{ at: T0, kind: 'recovery.detected', from: 'detected', to: 'detected', reason: 'x', target: ORIGINAL }, { at: T1, kind: 'recovery.resolved', from: 'detected', to: 'resolved', reason: 'x', target: ORIGINAL }, { at: T2, kind: 'recovery.resolved', from: 'resolved', to: 'resolved', reason: 'double', target: ORIGINAL }]).length > 0, '双重终态违例')

// ── 8. 纯函数 + 摘要稳定性 ─────────────────────────────────────────────────
const before = JSON.stringify(afterQuery)
assert.throws(() => attemptRecoveryStep(afterQuery, { receipt: receipt({}), target: substituteTarget, approach: 'alternative_candidate' }, T2), /recovery_silent_swap_forbidden/)
assert.equal(JSON.stringify(afterQuery), before, '拒绝即不动（原状态不变）')
const advanced = attemptRecoveryStep(afterQuery, { receipt: receipt({}), target: ORIGINAL, approach: 'requery_same_hotel' }, T2)
assert.equal(JSON.stringify(afterQuery), before, '推进返回新状态，原状态不可变')
assert.notEqual(JSON.stringify(advanced), before)

const digestA = receiptDigestOf(receipt({}))
const digestB = receiptDigestOf(receipt({ actionId: 'act-2' }))
assert.equal(receiptDigestOf(receipt({})), digestA, '同一内容摘要稳定')
assert.notEqual(digestA, digestB, '内容不同摘要不同')
assert.match(digestA, /^[0-9a-f]{64}$/, '摘要为 sha256 hex')

console.log('booking-recovery-chain-tests: all scenarios passed')
