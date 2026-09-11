/**
 * #233 取消退款独立结果与佣金披露 契约层回归(M5-4 pre-entry,run-all §62):
 *  1 独立结果封闭集:cancel 与 refund 是两个对象、两套状态,无合并成功态;导出面全清单冻结(零意外 API);
 *    supplierReferenceNo 只能由供应商返回值构造(不解码/不猜测)
 *  2 非对称终态:取消成功(供应商显式取消回执)但退款失败可表达;仅「已提交取消申请」⇒ orderCancelled 仍 unknown(已申请≠已取消)
 *  3 退款超时/未知不升级:refunded 无权威证据即拒;pending/unknown 的 moneyReturned 恒 unknown
 *  4 cancel.serviceFee ≠ 客户退款金额:serviceFee 来源不能当退款金额;到账结论只绑退款/钱包权威证据;手续费只单独披露
 *  5 佣金披露:确认边界缺披露即拒;unknown 不默认 none;known_none 须有 contract_rule 来源;口径(金额基准)不一致即拒;
 *    披露 digest 入指纹(canonical JSON 稳定),口径变化 ⇒ digest mismatch ⇒ 旧 receipt 失效需重确认
 *  6 账本分词与文案分词一致:120 组状态×账本×语言组合 + 3 种披露形态,生成文案零违例;
 *    手写/LLM 漂移文案(谎称已取消/已退款/藏佣金)逐反例被抓
 *  7 纯契约面:模块仅依赖 node:crypto,零网络/子进程/账本写入,无任何供应商调用路径(非运行时激活,default-off)
 * 反例先行(红→绿):本套件先于实现编写;实现见 ts/src/booking-surface/cancel-refund-commission.ts
 * 运行(在 ts/ 下):npx tsx scripts/issue-233-cancel-refund-commission-tests.ts
 */

import { readFileSync } from 'node:fs'
import {
  CANCELLATION_OUTCOME_SCHEMA,
  CANCELLATION_STATUSES,
  COMMISSION_AMOUNT_BASES,
  COMMISSION_BENEFIT_KINDS,
  COMMISSION_CERTAINTIES,
  COMMISSION_DISCLOSURE_FINGERPRINT_FIELD,
  COMMISSION_DISCLOSURE_SCHEMA,
  COMMISSION_SOURCES,
  COMMISSION_VIOLATION_CODES,
  COPY_VIOLATION_CODES,
  LOCAL_LEDGER_STATUSES,
  REFUND_AUTHORITY_SOURCES,
  REFUND_OUTCOME_SCHEMA,
  REFUND_STATUSES,
  SERVICE_FEE_SOURCE,
  SUPPLIER_REFERENCE_RETURN_SOURCES,
  aftercareFacts,
  bindDisclosureToFingerprint,
  cancellationOutcome,
  computeDisclosureDigest,
  copyTokenViolations,
  disclosureForConfirmation,
  localLedgerCopy,
  refundOutcome,
  renderAftercareCopy,
  supplierReferenceNoFromReturn,
  validateCommissionDisclosure,
} from '../src/booking-surface/cancel-refund-commission.ts'
import * as mod from '../src/booking-surface/cancel-refund-commission.ts'

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
type Ok<T> = { ok: true; value: T }
type Err = { ok: false; reason: string }
function isOk<T>(r: Ok<T> | Err): r is Ok<T> {
  return r.ok === true
}

// ---- 1:独立结果封闭集与导出面冻结 ------------------------------------------------

assert(CANCELLATION_OUTCOME_SCHEMA === 'gotry.cancellation_outcome.v1' && REFUND_OUTCOME_SCHEMA === 'gotry.refund_outcome.v1', '取消/退款结果对象各持唯一 schema(v1)')
assert(CANCELLATION_STATUSES.join(',') === 'not_requested,cancel_submitted,cancel_failed,cancel_unknown', '取消状态封闭集:未申请/已提交/失败/未知(四态)')
assert(REFUND_STATUSES.join(',') === 'not_applicable,refund_pending,refund_failed,refunded,refund_unknown', '退款状态封闭集:不涉及/待到账/失败/已到账/未知(五态)')
const allStatuses = [...CANCELLATION_STATUSES, ...REFUND_STATUSES]
assert(!allStatuses.includes('success' as never) && !allStatuses.includes('cancelled' as never), '无合并成功态:两套状态词表都不含 success/cancelled 单一总成功词')
assert(new Set(allStatuses).size === allStatuses.length, '取消与退款状态词表互不重叠(两个独立结果,不是一个结果的两个投影)')
assert(REFUND_AUTHORITY_SOURCES.join(',') === 'supplier_refund_record,wallet_refund_record' && SERVICE_FEE_SOURCE === 'cancel_return_service_fee', '退款金额权威来源闭集=供应商退款记录/钱包退款记录;serviceFee 是另一来源常量')
assert(SUPPLIER_REFERENCE_RETURN_SOURCES.join(',') === 'supplier_cancel_return,supplier_query_return,supplier_refund_return', 'supplierReferenceNo 只允许三种供应商返回来源(不解码猜测)')
assert(LOCAL_LEDGER_STATUSES.join(',') === 'pending,confirmed,compensated', 'ADR-17 账本三态只读镜像(本模块不改账本)')
assert(COMMISSION_VIOLATION_CODES.join(',') === 'commission_undisclosed,commission_none_without_source,commission_benefit_incomplete,commission_amount_basis_inconsistent,disclosure_digest_mismatch', '佣金披露违例码封闭集(含 digest mismatch=口径变化拒绝)')
assert(COPY_VIOLATION_CODES.join(',') === 'copy_claimed_cancelled_without_supplier_evidence,copy_claimed_refund_arrival_without_authority,copy_refund_wording_while_pending_or_unknown,copy_refund_wording_on_local_compensation_only,commission_disclosure_missing_from_summary,commission_status_contradicts_summary', '文案违例码封闭集(谎称已取消/已到账/pending 措辞/compensated 退款/藏佣金/口径矛盾)')

const EXPECTED_EXPORTS = [
  'CANCELLATION_OUTCOME_SCHEMA', 'CANCELLATION_STATUSES',
  'COMMISSION_AMOUNT_BASES', 'COMMISSION_BENEFIT_KINDS', 'COMMISSION_CERTAINTIES',
  'COMMISSION_DISCLOSURE_FINGERPRINT_FIELD', 'COMMISSION_DISCLOSURE_SCHEMA',
  'COMMISSION_SOURCES', 'COMMISSION_VIOLATION_CODES',
  'COPY_VIOLATION_CODES', 'LOCAL_LEDGER_STATUSES', 'REFUND_AUTHORITY_SOURCES',
  'REFUND_OUTCOME_SCHEMA', 'REFUND_STATUSES', 'SERVICE_FEE_SOURCE',
  'SUPPLIER_REFERENCE_RETURN_SOURCES',
  'aftercareFacts', 'bindDisclosureToFingerprint', 'cancellationOutcome',
  'computeDisclosureDigest', 'copyTokenViolations', 'disclosureForConfirmation',
  'localLedgerCopy', 'refundOutcome', 'renderAftercareCopy',
  'supplierReferenceNoFromReturn', 'validateCommissionDisclosure',
].sort()
assert(JSON.stringify(Object.keys(mod).sort()) === JSON.stringify(EXPECTED_EXPORTS), '导出面全清单冻结(无隐匿的第二 API/无意外副作用出口)')

{
  const good = supplierReferenceNoFromReturn('SR-881', 'supplier_cancel_return')
  assert(good.ok && good.value.value === 'SR-881', 'supplierReferenceNo 由供应商 cancel 返回值构造成功')
  assert(!supplierReferenceNoFromReturn('', 'supplier_cancel_return').ok && !supplierReferenceNoFromReturn('  ', 'supplier_query_return').ok, '空/空白返回值拒绝(fail-closed)')
  const badSource = supplierReferenceNoFromReturn('SR-881', 'customer_reference_decoded' as never)
  assert(!badSource.ok, '非供应商返回来源(从 customerReferenceNo 解码)构造被拒')

  const cancelOk = cancellationOutcome({
    schema: CANCELLATION_OUTCOME_SCHEMA,
    status: 'cancel_submitted',
    customerReferenceNo: 'GT-20260911-001',
    supplierReferenceNo: isOk(good) ? good.value : undefined,
    observedAt: '2026-09-11T10:00:00.000Z',
  })
  assert(isOk(cancelOk) && Object.isFrozen(cancelOk.value), '合法取消结果对象构造成功且冻结(不可变投影)')

  const badCancel = cancellationOutcome({
    schema: CANCELLATION_OUTCOME_SCHEMA,
    status: 'cancel_submitted',
    customerReferenceNo: 'GT-20260911-001',
    supplierReferenceNo: { value: 'SR-881', source: 'customer_reference_decoded' },
    observedAt: '2026-09-11T10:00:00.000Z',
  } as never)
  assert(!isOk(badCancel) && badCancel.reason === 'supplier_reference_not_returned_value', '取消对象携带非返回值来源的 supplierReferenceNo 被拒')

  const badStatus = cancellationOutcome({
    schema: CANCELLATION_OUTCOME_SCHEMA,
    status: 'cancelled',
    customerReferenceNo: 'GT-20260911-001',
    observedAt: '2026-09-11T10:00:00.000Z',
  } as never)
  assert(!isOk(badStatus), '取消对象不存在 cancelled 终态(只有 cancel_submitted/cancel_failed/cancel_unknown)')
}

// ---- 2:非对称终态(取消成功但退款失败可表达) --------------------------------------

{
  const srn = supplierReferenceNoFromReturn('SR-CXL-1', 'supplier_cancel_return')
  const cancel = cancellationOutcome({
    schema: CANCELLATION_OUTCOME_SCHEMA,
    status: 'cancel_submitted',
    customerReferenceNo: 'GT-20260911-002',
    supplierReferenceNo: isOk(srn) ? srn.value : undefined,
    supplierCancellationConfirmed: { digest: 'sha256:cancel-receipt-digest' },
    observedAt: '2026-09-11T10:00:00.000Z',
  })
  const refund = refundOutcome({
    schema: REFUND_OUTCOME_SCHEMA,
    status: 'refund_failed',
    supplierServiceFee: { amount: '80', currency: 'CNY' },
    reasonCode: 'wallet_recovery_failed',
    observedAt: '2026-09-11T10:05:00.000Z',
  })
  assert(isOk(cancel) && isOk(refund), '取消成功+退款失败的非对称终态两对象均可独立构造')
  if (isOk(cancel) && isOk(refund)) {
    const facts = aftercareFacts(cancel.value, refund.value)
    assert(facts.orderCancelled === true && facts.moneyReturned === false, '非对称终态:订单已取消=true 而钱未退=false(不合并成单一成功态)')
    const copyEn = renderAftercareCopy(cancel.value, refund.value, 'confirmed', undefined, 'en')
    const copyZh = renderAftercareCopy(cancel.value, refund.value, 'confirmed', undefined, 'zh-CN')
    assert(/cancel/i.test(copyEn) && /refund failed/i.test(copyEn), 'EN 文案同时表达取消与退款失败两个维度')
    assert(copyZh.includes('已取消') && copyZh.includes('退款失败'), 'ZH 文案同时表达取消与退款失败(供应商回执凭证在场才允许「已取消」)')

    const cancelRequestedOnly = cancellationOutcome({
      schema: CANCELLATION_OUTCOME_SCHEMA,
      status: 'cancel_submitted',
      customerReferenceNo: 'GT-20260911-003',
      observedAt: '2026-09-11T10:00:00.000Z',
    })
    if (isOk(cancelRequestedOnly)) {
      const facts2 = aftercareFacts(cancelRequestedOnly.value, refund.value)
      assert(facts2.orderCancelled === 'unknown', '仅 cancel_submitted(无供应商取消回执)⇒ orderCancelled 仍 unknown:已申请取消≠已取消')
    }
  }
}

// ---- 3:退款超时/未知不升级;refunded 必须有权威证据 -------------------------------

{
  const noEvidence = refundOutcome({
    schema: REFUND_OUTCOME_SCHEMA,
    status: 'refunded',
    customerRefund: { amount: '100', currency: 'CNY', source: 'supplier_refund_record' },
    observedAt: '2026-09-11T10:00:00.000Z',
  })
  assert(!isOk(noEvidence) && noEvidence.reason === 'refund_claimed_without_evidence', 'refunded 无权威证据(evidence)构造即拒:到账结论必须绑定退款/钱包权威证据')

  const pending = refundOutcome({
    schema: REFUND_OUTCOME_SCHEMA,
    status: 'refund_pending',
    customerRefund: { amount: '100', currency: 'CNY', source: 'supplier_refund_record' },
    observedAt: '2026-09-11T10:00:00.000Z',
  })
  const unknown = refundOutcome({
    schema: REFUND_OUTCOME_SCHEMA,
    status: 'refund_unknown',
    observedAt: '2026-09-11T10:00:00.000Z',
  })
  assert(isOk(pending) && isOk(unknown), '退款 pending/unknown 可构造(超时窗口内合法状态)')
  if (isOk(pending) && isOk(unknown)) {
    const cancel = cancellationOutcome({
      schema: CANCELLATION_OUTCOME_SCHEMA,
      status: 'not_requested',
      customerReferenceNo: 'GT-20260911-004',
      observedAt: '2026-09-11T10:00:00.000Z',
    })
    if (isOk(cancel)) {
      assert(aftercareFacts(cancel.value, pending.value).moneyReturned === 'unknown', 'pending 的 moneyReturned 恒 unknown(不自动升级为已到账)')
      assert(aftercareFacts(cancel.value, unknown.value).moneyReturned === 'unknown', 'unknown 的 moneyReturned 恒 unknown')
    }
  }
  const refunded = refundOutcome({
    schema: REFUND_OUTCOME_SCHEMA,
    status: 'refunded',
    customerRefund: { amount: '100', currency: 'CNY', source: 'wallet_refund_record' },
    evidence: { kind: 'wallet_refund_record', digest: 'sha256:wallet-refund-digest' },
    observedAt: '2026-09-11T10:00:00.000Z',
  })
  assert(isOk(refunded), '绑钱包权威证据的 refunded 合法(到账结论=证据)')
}

// ---- 4:cancel.serviceFee ≠ 客户退款金额 -----------------------------------------

{
  const feeAsRefund = refundOutcome({
    schema: REFUND_OUTCOME_SCHEMA,
    status: 'refunded',
    customerRefund: { amount: '80', currency: 'CNY', source: SERVICE_FEE_SOURCE },
    evidence: { kind: 'supplier_refund_record', digest: 'sha256:x' },
    supplierServiceFee: { amount: '80', currency: 'CNY' },
    observedAt: '2026-09-11T10:00:00.000Z',
  })
  assert(!isOk(feeAsRefund) && feeAsRefund.reason === 'service_fee_used_as_refund_amount', 'cancel.serviceFee 来源金额冒充客户退款金额被拒(serviceFee 不是退款)')

  const feeWithoutAuthority = refundOutcome({
    schema: REFUND_OUTCOME_SCHEMA,
    status: 'refund_pending',
    customerRefund: { amount: '80', currency: 'CNY', source: 'cancel_return_service_fee' },
    observedAt: '2026-09-11T10:00:00.000Z',
  })
  assert(!isOk(feeWithoutAuthority), '任何状态下 serviceFee 来源都不能进 customerRefund')

  const srn = supplierReferenceNoFromReturn('SR-CXL-2', 'supplier_cancel_return')
  const cancel = cancellationOutcome({
    schema: CANCELLATION_OUTCOME_SCHEMA,
    status: 'cancel_submitted',
    customerReferenceNo: 'GT-20260911-005',
    supplierReferenceNo: isOk(srn) ? srn.value : undefined,
    observedAt: '2026-09-11T10:00:00.000Z',
  })
  const refundReal = refundOutcome({
    schema: REFUND_OUTCOME_SCHEMA,
    status: 'refunded',
    customerRefund: { amount: '620', currency: 'CNY', source: 'wallet_refund_record' },
    evidence: { kind: 'wallet_refund_record', digest: 'sha256:wallet-2' },
    supplierServiceFee: { amount: '80', currency: 'CNY' },
    observedAt: '2026-09-11T10:10:00.000Z',
  })
  assert(isOk(cancel) && isOk(refundReal), '真实口径可构造:手续费 80 单独在场,退款 620 绑钱包证据')
  if (isOk(cancel) && isOk(refundReal)) {
    const copyZh = renderAftercareCopy(cancel.value, refundReal.value, 'confirmed', undefined, 'zh-CN')
    const copyEn = renderAftercareCopy(cancel.value, refundReal.value, 'confirmed', undefined, 'en')
    assert(copyZh.includes('620') && copyZh.includes('手续费') && !copyZh.includes('退款已到账：80'), 'ZH 文案:退款金额=620 来自钱包证据;80 只作手续费单独披露')
    assert(/620/.test(copyEn) && /service fee/i.test(copyEn) && !/\b80\b\s*(CNY|¥)?\s*(refund|refunded)/i.test(copyEn), 'EN 文案:80 只以 service fee 出现,不得表述为客户退款')
  }
}

// ---- 5:佣金披露(digest 入指纹,口径变化使旧 receipt 失效) ------------------------

const disclosureOk = {
  schema: COMMISSION_DISCLOSURE_SCHEMA,
  certainty: 'known_benefit',
  benefits: [{ kind: 'commission', paidBy: 'supplier', paidTo: 'gotry', basis: { type: 'percent_of_total', percent: '10' } }],
  source: 'supplier_field',
} as const

{
  assert(COMMISSION_BENEFIT_KINDS.join(',') === 'commission,rebate,sponsorship,preferred_placement', '受益类型封闭集:佣金/返利/赞助/优先位')
  assert(COMMISSION_CERTAINTIES.join(',') === 'known_benefit,known_none,unknown', '确定性三态:明确有/明确无/未知(unknown 不默认 none)')
  assert(COMMISSION_SOURCES.join(',') === 'supplier_field,contract_rule' && COMMISSION_AMOUNT_BASES.join(',') === 'fixed,percent_of_total,per_night', '来源与金额口径基准封闭集')

  const undisclosed = disclosureForConfirmation(undefined)
  assert(!undisclosed.ok && undisclosed.violation === 'commission_undisclosed', '确认边界无披露对象 ⇒ commission_undisclosed 拒绝')

  assert(validateCommissionDisclosure(disclosureOk).ok, '合法佣金披露(供应商字段来源,10% 佣金)通过')
  const noneWithoutSource = validateCommissionDisclosure({
    schema: COMMISSION_DISCLOSURE_SCHEMA,
    certainty: 'known_none',
    benefits: [],
    source: 'supplier_field',
  })
  assert(!noneWithoutSource.ok && noneWithoutSource.violations.includes('commission_none_without_source'), '「明确无受益」无 contract_rule 来源被拒(无受益也必须是记录结论,不是沉默)')

  const emptyBenefit = validateCommissionDisclosure({
    schema: COMMISSION_DISCLOSURE_SCHEMA,
    certainty: 'known_benefit',
    benefits: [],
    source: 'supplier_field',
  })
  assert(!emptyBenefit.ok && emptyBenefit.violations.includes('commission_benefit_incomplete'), 'known_benefit 但受益列表为空 ⇒ commission_benefit_incomplete')

  const unknownKept = validateCommissionDisclosure({
    schema: COMMISSION_DISCLOSURE_SCHEMA,
    certainty: 'unknown',
    benefits: [],
    source: 'supplier_field',
  })
  assert(unknownKept.ok, 'unknown 是合法且独立的披露形态(不强制折成 none)')

  const basisConflict = validateCommissionDisclosure({
    schema: COMMISSION_DISCLOSURE_SCHEMA,
    certainty: 'known_benefit',
    benefits: [{ kind: 'commission', paidBy: 'supplier', paidTo: 'gotry', basis: { type: 'percent_of_total', percent: '10', amount: '120', currency: 'CNY' } }],
    source: 'supplier_field',
  })
  assert(!basisConflict.ok && basisConflict.violations.includes('commission_amount_basis_inconsistent'), '口径不一致:percent_of_total 同时携带固定金额 ⇒ commission_amount_basis_inconsistent')

  const fixedNoCurrency = validateCommissionDisclosure({
    schema: COMMISSION_DISCLOSURE_SCHEMA,
    certainty: 'known_benefit',
    benefits: [{ kind: 'rebate', paidBy: 'distributor', paidTo: 'gotry', basis: { type: 'fixed', amount: '50' } }],
    source: 'contract_rule',
  })
  assert(!fixedNoCurrency.ok && fixedNoCurrency.violations.includes('commission_amount_basis_inconsistent'), 'fixed 口径缺币种 ⇒ 口径不一致拒绝')

  const d1 = computeDisclosureDigest(disclosureOk)
  const d1Reordered = computeDisclosureDigest({
    source: 'supplier_field',
    certainty: 'known_benefit',
    schema: COMMISSION_DISCLOSURE_SCHEMA,
    benefits: [{ basis: { percent: '10', type: 'percent_of_total' }, paidTo: 'gotry', paidBy: 'supplier', kind: 'commission' }],
  })
  assert(d1 === d1Reordered && /^[0-9a-f]{64}$/.test(d1), '披露 digest=canonical JSON 的 SHA-256(键序无关,稳定)')

  const d2 = computeDisclosureDigest({
    schema: COMMISSION_DISCLOSURE_SCHEMA,
    certainty: 'known_benefit',
    benefits: [{ kind: 'commission', paidBy: 'supplier', paidTo: 'gotry', basis: { type: 'percent_of_total', percent: '12.5' } }],
    source: 'supplier_field',
  })
  assert(d1 !== d2, '佣金口径变化(10%→12.5%)⇒ digest 不同')

  const fpFirst = bindDisclosureToFingerprint({}, disclosureOk)
  assert(fpFirst.ok && fpFirst.fingerprint[COMMISSION_DISCLOSURE_FINGERPRINT_FIELD] === d1, '披露 digest 写入指纹字段 commission_disclosure')
  const fpSame = bindDisclosureToFingerprint({ [COMMISSION_DISCLOSURE_FINGERPRINT_FIELD]: d1 }, disclosureOk)
  assert(fpSame.ok, '同口径披露与既有指纹一致 ⇒ 绑定通过')
  const fpChanged = bindDisclosureToFingerprint({ [COMMISSION_DISCLOSURE_FINGERPRINT_FIELD]: d1 }, { ...disclosureOk, benefits: [{ kind: 'commission', paidBy: 'supplier', paidTo: 'gotry', basis: { type: 'percent_of_total', percent: '12.5' } }] })
  assert(!fpChanged.ok && fpChanged.violation === 'disclosure_digest_mismatch', '披露口径变化 ⇒ 指纹 digest mismatch ⇒ 旧 receipt 失效需重确认')
}

// ---- 6:账本分词与文案分词一致 ----------------------------------------------------

{
  const cancelByStatus = new Map(CANCELLATION_STATUSES.map(status => {
    const r = cancellationOutcome({
      schema: CANCELLATION_OUTCOME_SCHEMA,
      status,
      customerReferenceNo: 'GT-COPY',
      observedAt: '2026-09-11T10:00:00.000Z',
    })
    return [status, isOk(r) ? r.value : undefined] as const
  }))
  // cancel_submitted 需要供应商回执才允许「已取消」:单列一个带凭证的变体
  const srn = supplierReferenceNoFromReturn('SR-COPY', 'supplier_cancel_return')
  const cancelSubmittedConfirmed = cancellationOutcome({
    schema: CANCELLATION_OUTCOME_SCHEMA,
    status: 'cancel_submitted',
    customerReferenceNo: 'GT-COPY',
    supplierReferenceNo: isOk(srn) ? srn.value : undefined,
    supplierCancellationConfirmed: { digest: 'sha256:copy-digest' },
    observedAt: '2026-09-11T10:00:00.000Z',
  })
  if (isOk(cancelSubmittedConfirmed)) cancelByStatus.set('cancel_submitted', cancelSubmittedConfirmed.value)
  const refundByStatus = new Map(REFUND_STATUSES.map(status => {
    const input: Record<string, unknown> = {
      schema: REFUND_OUTCOME_SCHEMA,
      status,
      observedAt: '2026-09-11T10:00:00.000Z',
    }
    if (status === 'refunded') {
      input.customerRefund = { amount: '100', currency: 'CNY', source: 'supplier_refund_record' }
      input.evidence = { kind: 'supplier_refund_record', digest: 'sha256:copy-refund' }
    }
    const r = refundOutcome(input as never)
    return [status, isOk(r) ? r.value : undefined] as const
  }))
  assert([...cancelByStatus.values()].every(v => v !== undefined) && [...refundByStatus.values()].every(v => v !== undefined), '文案矩阵:取消 4 态×退款 5 态全部可构造')

  const disclosures = [undefined, { schema: COMMISSION_DISCLOSURE_SCHEMA, certainty: 'unknown', benefits: [], source: 'supplier_field' } as const, { schema: COMMISSION_DISCLOSURE_SCHEMA, certainty: 'known_none', benefits: [], source: 'contract_rule' } as const, disclosureOk]
  let combos = 0
  let violationsFound = 0
  for (const cancel of cancelByStatus.values()) {
    for (const refund of refundByStatus.values()) {
      for (const ledger of LOCAL_LEDGER_STATUSES) {
        for (const locale of ['en', 'zh-CN'] as const) {
          for (const disclosure of disclosures) {
            const c = cancel!
            const r = refund!
            const text = renderAftercareCopy(c, r, ledger, disclosure, locale)
            const violations = copyTokenViolations(text, { cancel: c, refund: r, ledgerStatus: ledger, disclosure, locale })
            combos++
            violationsFound += violations.length
            if (violations.length > 0) console.error(`    combo drift: ${c.status}/${r.status}/${ledger}/${locale}: ${violations.join(',')}`)
          }
        }
      }
    }
  }
  assert(combos === 4 * 5 * 3 * 2 * 4 && violationsFound === 0, `生成文案在 ${combos} 组状态×账本×语言×披露组合下零违例(账本分词与文案分词一致)`)

  const zh = renderAftercareCopy(cancelByStatus.get('not_requested')!, refundByStatus.get('not_applicable')!, 'compensated', undefined, 'zh-CN')
  assert(zh.includes('已补偿') && !zh.includes('已退款') && !zh.includes('退款已到账'), 'pending→compensated:文案只说本地账面补偿,绝无「已退款」措辞(A-5 反例)')
  const en = renderAftercareCopy(cancelByStatus.get('not_requested')!, refundByStatus.get('not_applicable')!, 'compensated', undefined, 'en')
  assert(/compensated/i.test(en) && !/refunded/i.test(en), 'EN 同律:compensated 不产生 refunded 措辞')
  assert(localLedgerCopy('compensated', 'zh-CN').includes('补偿') && !localLedgerCopy('compensated', 'zh-CN').includes('已退款'), '账本 compensated 单独词条也不含退款到账措辞')

  const submittedZh = renderAftercareCopy((() => {
    const r = cancellationOutcome({ schema: CANCELLATION_OUTCOME_SCHEMA, status: 'cancel_submitted', customerReferenceNo: 'GT-W', observedAt: '2026-09-11T10:00:00.000Z' })
    return isOk(r) ? r.value : undefined!
  })(), refundByStatus.get('not_applicable')!, 'pending', undefined, 'zh-CN')
  assert(submittedZh.includes('已提交取消申请') && !submittedZh.includes('已取消'), '仅提交取消:文案为「已提交取消申请」,无「已取消」')
  const pendingEn = renderAftercareCopy(cancelByStatus.get('not_requested')!, refundByStatus.get('refund_pending')!, 'confirmed', undefined, 'en')
  assert(/refund pending/i.test(pendingEn) && !/refunded/i.test(pendingEn), '退款超时窗口:文案保持 refund pending,不写 refunded')

  // 手写/LLM 漂移文案反例(生成器之外的说法必须过同一分词闸)
  const cancelW = cancellationOutcome({ schema: CANCELLATION_OUTCOME_SCHEMA, status: 'cancel_submitted', customerReferenceNo: 'GT-W', observedAt: '2026-09-11T10:00:00.000Z' })
  const refundPendingW = refundByStatus.get('refund_pending')!
  const refundNAW = refundByStatus.get('not_applicable')!
  if (isOk(cancelW)) {
    const state = { cancel: cancelW.value, refund: refundPendingW, ledgerStatus: 'confirmed' as const, disclosure: undefined, locale: 'en' as const }
    assert(copyTokenViolations('Your booking is cancelled and you have been refunded.', state).includes('copy_claimed_cancelled_without_supplier_evidence'), '反例:无供应商回执却写 cancelled 被抓')
    assert(copyTokenViolations('Your booking is cancelled and you have been refunded.', state).includes('copy_claimed_refund_arrival_without_authority'), '反例:pending 态写 refunded 被抓')
    assert(copyTokenViolations('Cancellation requested; refund pending.', state).length === 0, '合规措辞(cancellation requested / refund pending)零违例')

    const compState = { cancel: cancelW.value, refund: refundNAW, ledgerStatus: 'compensated' as const, disclosure: undefined, locale: 'zh-CN' as const }
    assert(copyTokenViolations('已为您取消并退款已到账。', compState).includes('copy_refund_wording_on_local_compensation_only'), '反例:本地 compensated + 无退款结果却写「退款已到账」被抓(账本分词≠退款分词)')
    assert(copyTokenViolations('本地账面已补偿；退款状态以退款结果为准。', compState).length === 0, '合规措辞:compensated 只述账务动作零违例')
  }

  const stateWithBenefit = {
    cancel: cancelByStatus.get('not_requested')!,
    refund: refundNAW,
    ledgerStatus: 'confirmed' as const,
    disclosure: disclosureOk,
    locale: 'en' as const,
  }
  assert(copyTokenViolations('Total: CNY 1200. Booking confirmed.', stateWithBenefit).includes('commission_disclosure_missing_from_summary'), '反例:摘要只报总价、佣金藏进总价不披露被抓')
  assert(copyTokenViolations('Total: CNY 1200. Commission: paid by supplier to gotry, 10% of total.', stateWithBenefit).length === 0, '合规:佣金显式披露(谁付/给谁/口径)零违例')

  const stateUnknown = { ...stateWithBenefit, disclosure: { schema: COMMISSION_DISCLOSURE_SCHEMA, certainty: 'unknown', benefits: [], source: 'supplier_field' } as const }
  assert(copyTokenViolations('Commission benefit: unknown (not assumed none).', stateUnknown).length === 0, 'unknown 披露的合规措辞零违例(不默认 none)')
  assert(copyTokenViolations('Commission: 10% of total paid by supplier.', stateUnknown).includes('commission_status_contradicts_summary'), '反例:披露为 unknown 却给出确定受益口径被抓')
}

// ---- 7:纯契约面(零网络/零子进程/零账本写入,非运行时激活) ------------------------

{
  const src = readFileSync(new URL('../src/booking-surface/cancel-refund-commission.ts', import.meta.url), 'utf8')
  const forbiddenImports = ['node:net', 'node:http', 'node:https', 'node:tls', 'node:dgram', 'node:child_process', 'node:fs', 'node:sqlite']
  assert(forbiddenImports.every(name => !src.includes(`'${name}'`) && !src.includes(`"${name}"`)), '模块不 import 任何网络/子进程/文件系统/SQLite 内建(纯契约)')
  assert(!/\bfetch\(|\bspawn\(|\bexecFile\(|\bexecSync\(|createConnection|connect\(/.test(src), '模块无 fetch/spawn/exec/连接调用面(无真实交易路径)')
  const nodeImports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1]).filter(s => s.startsWith('node:'))
  assert(nodeImports.every(s => s === 'node:crypto'), `node 内建依赖仅 node:crypto(实际:${JSON.stringify(nodeImports)})`)
  assert(!src.includes('dsh-runtime') && !src.includes('gotry-state'), '模块不触碰运行时状态目录(不写共享状态)')
}

console.log(`\nISSUE 233 CANCEL/REFUND/COMMISSION TESTS: ${pass} ok, ${fail} fail`)
if (fail > 0) process.exit(1)
