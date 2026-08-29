/**
 * booking-write.ts — 预订写效应的 saga 编排层(ADR-17 booking_saga_fsm.v1 × ADR-18 写效应入注册表规则)。
 *
 * 红线(gotry AGENTS.md:预订/支付类写必须过 WriteGate,确认前不得直接写):
 *   - 本模块是 HBCLI_TRADE_BOOK 效应的唯一渠道实现——工具层不得绕过它直调 bookHotel;
 *   - 每次写先 requestPendingWrite(idem_key=customerReferenceNo,幂等去重),
 *     通道成功 → confirmPendingWrite(receipt=订单回执),失败 → compensatePendingWrite;
 *   - 金额不入参:价格权威在后端 check-avail session,这里只透传 ratePkgId + 人证 + 幂等键;
 *   - 重复提议同一 idem_key = no-op 返回既有状态(物理幂等,账本 UNIQUE 约束)。
 */

import { bookHotel, type HbcliCallResult } from './hbcli.ts'
import { ensureLedger } from '../src/state-ledger.ts'

export interface HbBookWriteParams {
  ratePkgId: string
  holder: Record<string, unknown>
  guests: Array<Record<string, unknown>>
  /** 幂等键(saga idem_key);同时是后端 customerReferenceNo */
  customerReferenceNo: string
  confirmDuplicate?: boolean
  duplicateReason?: string
  /** 账本根(saga pending_writes 落账处;工具层传 config.stateRoot) */
  stateRoot: string
  hbcliBin?: string
  timeoutMs?: number
}

export interface BookWriteObservation extends HbcliCallResult {
  /** saga 终态:confirmed(下单成功)/ compensated(失败已补偿)/ pending(重复提议或异常) */
  saga: 'pending' | 'confirmed' | 'compensated'
  /** confirm 携带的外部回执(订单引用;失败时空) */
  receipt: string
  /** 本次是否真的发起了通道写(repeat no-op = false) */
  executed: boolean
  /** 通道成功时的订单原始对象(供工具面透出) */
  book?: unknown
  summary: string
}

/** 从 book --json 结果提取订单回执(后端字段优先,兜底幂等键+状态,保证 confirm 回执非空) */
function extractReceipt(result: unknown, idemKey: string): string {
  const r = (result ?? {}) as Record<string, any>
  const candidates = [
    r.orderNo, r.platformReferenceNo, r.order?.orderNo, r.order?.platformReferenceNo,
    r.data?.orderNo, r.data?.platformReferenceNo, r.customerReferenceNo, r.book?.orderNo,
  ]
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim()
  return `ref:${idemKey}`
}

/** saga 编排的预订写:propose → 通道 → confirm/compensate。永不抛错,返回平铺观察。 */
export async function bookWithSaga(p: HbBookWriteParams, opts: { hbcliBin?: string; timeoutMs?: number } = {}): Promise<BookWriteObservation> {
  const ledger = ensureLedger(p.stateRoot)
  const propose = ledger.requestPendingWrite(
    { idemKey: p.customerReferenceNo, seam: 'hbcli:trade:book', payload: { ratePkgId: p.ratePkgId, holder: p.holder, guests: p.guests } },
    'agent:gotry_book',
  )
  if (!propose.created) {
    // 物理幂等:同一幂等键的重复提议 no-op——不二次下单,返回既有 saga 状态
    return {
      via: 'hbcli-error', exitCode: 0, result: null,
      evidence: `[saga:idem:${p.customerReferenceNo}@${new Date().toISOString()}] 重复提议 no-op(既有状态 ${propose.status})`,
      latencyMs: 0, book: null, saga: propose.status as BookWriteObservation['saga'], receipt: '',
      executed: false,
      summary: `book:幂等键 ${p.customerReferenceNo} 已有 ${propose.status} 记录,本次不重复下单(幂等 no-op)`,
    }
  }
  const live = await bookHotel(
    { ratePkgId: p.ratePkgId, holder: p.holder, guests: p.guests, customerReferenceNo: p.customerReferenceNo,
      confirmDuplicate: p.confirmDuplicate, duplicateReason: p.duplicateReason },
    { hbcliBin: opts.hbcliBin ?? p.hbcliBin, timeoutMs: opts.timeoutMs ?? p.timeoutMs },
  )
  if (live.via === 'hbcli-realtime') {
    const receipt = extractReceipt(live.result, p.customerReferenceNo)
    const conf = ledger.confirmPendingWrite(p.customerReferenceNo, receipt, 'agent:gotry_book')
    return {
      ...live, book: live.result, saga: conf.ok ? 'confirmed' : 'pending', receipt, executed: true,
      summary: `book 下单成功:receipt=${receipt}(saga ${conf.ok ? 'pending→confirmed' : `confirm 拒绝(${conf.status})`};幂等键 ${p.customerReferenceNo})`,
    }
  }
  const comp = ledger.compensatePendingWrite(p.customerReferenceNo, `channel-failed:${live.error ?? live.via}`, 'agent:gotry_book')
  return {
    ...live, book: null, saga: comp.ok ? 'compensated' : 'pending', receipt: '', executed: true,
    summary: `book 下单失败已补偿:${live.error ?? live.via}(saga ${comp.ok ? 'pending→compensated' : `compensate 拒绝(${comp.status})`};幂等键 ${p.customerReferenceNo};未产生订单)`,
  }
}
