/**
 * WriteGate 机制层(write_gate.v1)——issue #231「持久化可信审批 + 原子 outbox」。
 *
 * 立场(docs/design/write-gate-production-design.md §3/§5 + docs/design/fact-writegate-seam.md §2.2):
 * 本模块只实现「审批与 outbox 的持久化机制与契约」——
 *   - PreparedChallenge:呈现前由服务端备妥的一次性挑战(nonce/fingerprint/披露在呈现前冻结,
 *     只持久化 nonce 摘要,原始 nonce 只经可信宿主呈现通道交付,永不入账本);
 *   - ApprovalReceipt / ApprovalClaim:只有可信宿主真人确认回调可发行的 L3 一次性消费凭据,
 *     绑定 actor/tenant/traveler/seam/challenge/fingerprint;prepared 不构成授权;
 *   - WriteEffectIntent:durable outbox 意图(本地 exactly-once 记账面,不承诺外部 exactly-once)。
 * 两段事务边界严格分离、不得合并(write-gate-production-design §2.2):
 *   事务1 = receipt 一次性消费 + pending_writes pending→confirmed + outbox 入队(单事务原子);
 *   事务2 = dispatcher 原子领取(queued 条件 UPDATE,affected rows=1 唯一赢家)+ attempt/fencing
 *           先于任何外部调用落库(独立事务,attempt_id 落库即不可变)。
 *
 * 存储层物理红线(数据库物理 CHECK/外键/触发器 = 「等价不可绕过约束」,非应用层 if):
 *   - write_effect_intents.receipt_id 非空 CHECK + 复合外键 (tenant_id, receipt_id) → approval_claims
 *     ⇒ 空 receipt / 跨租户 receipt 的 outbox 行在物理上不可能(D-22/#306 锚点的 outbox 侧面;
 *     pending_writes 本表的空 receipt 物理 CHECK 仍属 M5 Entry 拍板项,本模块不改动 ADR-17 三态);
 *   - dispatch_status 只进不退触发器:dispatching/dispatched/rejected 永不回 queued——
 *     崩溃/租约过期一律 unknown/query/manual reconcile,不得重置为未执行再下单;
 *   - attempt_id 落库即不可变触发器(对账只认同一 attempt,不得另起);
 *   - dispatching/dispatched 必携完整领取字段(attempt_id/fencing_token/claimed_by/lease_until)CHECK
 *     ⇒ 「调用先于领取落库」在存储层无法成立。
 *
 * 激活闸(M5 Entry 前,门 = issue #136):本模块零真实供应商/交易调用——API 止于 outbox 入队、
 * 领取、派发前复验与本地 rejected/unknown 记账;真实派发调用方属于 #232(M5 Entry 后)。
 * 产品运行时在 M5 Entry 前不实例化 WriteGate:表结构由 ensureWriteGate 惰性创建,
 * 默认路径(工具注册面/账本 SCHEMA/state-ledger 行为)零变化——非运行时激活。
 * 模型授权边界:模型只能请求呈现(prepare 走 L2 requestPendingWrite + 备妥挑战);
 * 确认消费通道只认可信宿主回调携带的原始 delivery_nonce(账本只有其摘要)——
 * 即使携带合法 actor 与合法快照,仅凭摘要/伪造 nonce 的确认一律拒绝且无 outbox。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { StateLedger } from './state-ledger.ts'

export const WRITE_GATE_SCHEMA = 'write_gate.v1'

/** 请求指纹 schema(设计 §4;canonical JSON + SHA-256,呈现卡/审批凭据/供应商写效果三处同源) */
export const WRITE_REQUEST_FINGERPRINT_SCHEMA = 'gotry_write_request_fingerprint.v1'

/**
 * 具名 seam 词汇(封闭集,失败关闭)。冻结本身是 M5 Entry 拍板项(#136/#306);
 * 当前仅收录设计文档已具名的 seam 字面量,Entry 前不新增。
 */
export const WRITE_GATE_SEAMS = ['hotelbyte-hotel-book-confirm'] as const
export type WriteGateSeam = (typeof WRITE_GATE_SEAMS)[number]

/** outbox 派发状态字母表(设计 §3;rejected 是 outbox/派发层终态,不扩展 ADR-17 pending_writes 三态) */
export const DISPATCH_STATUSES = ['queued', 'dispatching', 'dispatched', 'rejected'] as const
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number]

/** PreparedChallenge 状态字母表(设计 §3;expired 可由 sweep 或被新挑战取代时落库) */
export const CHALLENGE_STATUSES = ['prepared', 'confirmed', 'consumed', 'expired'] as const
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number]

/** 派发失败关闭原因码(封闭集;全部 = 零供应商写,拒绝只记在 outbox/派发层) */
export type WriteGateRejection =
  | 'unknown-seam'
  | 'missing-subject'
  | 'subject-not-pending'
  | 'no-challenge'
  | 'challenge-not-prepared'
  | 'challenge-expired'
  | 'nonce-mismatch'
  | 'binding-mismatch'
  | 'authority-revoked'
  | 'no-issuance-record'
  | 'cross-intent-replay'
  | 'receipt-expired'
  | 'fingerprint-mismatch'
  | 'approval-claimed'
  | 'confirm-failed'
  | 'missing-intent'
  | 'not-claimable'
  | 'lost-race'

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** 服务端生成的一次性 nonce(32 字节随机;只有摘要入账本,原始值只经可信宿主通道交付) */
export function makeDeliveryNonce(): string {
  return randomBytes(32).toString('hex')
}

/** canonical JSON:键递归排序,序列化稳定(同内容任意键序同摘要;JS 值域内确定) */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}'
  }
  return JSON.stringify(v) ?? 'null'
}

/** 请求字段(设计 §4 的机制层必选子集;sensitive 原值永不入账本,调用方只传 HMAC 假名/摘要) */
export interface WriteRequestFields {
  tenantId: string
  actorRef: string
  principalRef: string
  /** B2B/合作方假名,可选 */
  sponsorRef?: string
  seam: string
  /** 供应商/渠道 + 版本 + Buyer/路由摘要 */
  supplier: string
  /** sessionId/ratePkgId/offer 摘要,无 PII */
  productRef: string
  /** 入离日期/人数/房型/取消政策/税费等摘要 */
  travelTerms: string
  /** 用户授权总额(最小货币单位) */
  amountTotal: number
  currency: string
  /** 佣金/赞助/返利披露摘要;可为 'none' 但必须显式 */
  commissionDisclosure: string
  /** 报价/授权有效期(ISO;必须早于供应商报价过期) */
  validUntil: string
  /** 用户实际看到的卡片版本摘要 */
  presentationKey: string
}

/** 计算请求指纹(canonical 字段 + schema + 该次呈现绑定的 nonce 摘要;呈现前冻结,确认后不可变) */
export function computeRequestFingerprint(fields: WriteRequestFields, deliveryNonceDigest: string): string {
  return sha256(canonicalJson({
    schema: WRITE_REQUEST_FINGERPRINT_SCHEMA,
    tenant_id: fields.tenantId,
    actor_ref: fields.actorRef,
    principal_ref: fields.principalRef,
    ...(fields.sponsorRef !== undefined ? { sponsor_ref: fields.sponsorRef } : {}),
    seam: fields.seam,
    supplier: fields.supplier,
    product_ref: fields.productRef,
    travel_terms: fields.travelTerms,
    amount_total: fields.amountTotal,
    currency: fields.currency,
    commission_disclosure: fields.commissionDisclosure,
    valid_until: fields.validUntil,
    presentation_key: fields.presentationKey,
    delivery_nonce_digest: deliveryNonceDigest,
  }))
}

// ---- 存储面:惰性 schema(只有实例化 WriteGate 的进程才创建这些表) --------------------

export const WRITE_GATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS prepared_challenges (
  tenant_id TEXT NOT NULL DEFAULT 'local',
  challenge_id TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_fingerprint_sha256 TEXT NOT NULL CHECK (length(request_fingerprint_sha256) = 64),
  presentation_key TEXT NOT NULL CHECK (length(presentation_key) > 0),
  delivery_nonce_digest TEXT NOT NULL CHECK (length(delivery_nonce_digest) = 64),
  actor_ref TEXT NOT NULL CHECK (length(actor_ref) > 0),
  principal_ref TEXT NOT NULL CHECK (length(principal_ref) > 0),
  seam TEXT NOT NULL CHECK (length(seam) > 0),
  amount_total INTEGER NOT NULL CHECK (amount_total >= 0),
  currency TEXT NOT NULL CHECK (length(currency) > 0),
  valid_until TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','confirmed','consumed','expired')),
  PRIMARY KEY (tenant_id, challenge_id)
);
CREATE INDEX IF NOT EXISTS prepared_challenges_idem ON prepared_challenges(tenant_id, idem_key);
CREATE UNIQUE INDEX IF NOT EXISTS prepared_challenges_nonce ON prepared_challenges(tenant_id, delivery_nonce_digest);

CREATE TABLE IF NOT EXISTS approval_claims (
  tenant_id TEXT NOT NULL DEFAULT 'local',
  receipt_id TEXT NOT NULL CHECK (length(receipt_id) > 0),
  challenge_id TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  nonce_digest TEXT NOT NULL CHECK (length(nonce_digest) = 64),
  request_fingerprint_sha256 TEXT NOT NULL CHECK (length(request_fingerprint_sha256) = 64),
  actor_ref TEXT NOT NULL CHECK (length(actor_ref) > 0),
  principal_ref TEXT NOT NULL CHECK (length(principal_ref) > 0),
  seam TEXT NOT NULL CHECK (length(seam) > 0),
  presentation_key TEXT NOT NULL CHECK (length(presentation_key) > 0),
  valid_until TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  consumed_at TEXT,
  amount_total INTEGER NOT NULL CHECK (amount_total >= 0),
  currency TEXT NOT NULL CHECK (length(currency) > 0),
  PRIMARY KEY (tenant_id, receipt_id),
  UNIQUE (tenant_id, challenge_id),
  UNIQUE (tenant_id, nonce_digest)
);

CREATE TABLE IF NOT EXISTS write_effect_intents (
  tenant_id TEXT NOT NULL DEFAULT 'local',
  idem_key TEXT NOT NULL,
  effect_name TEXT NOT NULL CHECK (length(effect_name) > 0),
  receipt_id TEXT NOT NULL CHECK (length(receipt_id) > 0),
  supplier_attempt_key TEXT NOT NULL CHECK (length(supplier_attempt_key) > 0),
  request_fingerprint_sha256 TEXT NOT NULL CHECK (length(request_fingerprint_sha256) = 64),
  nonce_digest TEXT NOT NULL CHECK (length(nonce_digest) = 64),
  actor_ref TEXT NOT NULL CHECK (length(actor_ref) > 0),
  principal_ref TEXT NOT NULL CHECK (length(principal_ref) > 0),
  seam TEXT NOT NULL CHECK (length(seam) > 0),
  attempt_budget INTEGER NOT NULL CHECK (attempt_budget > 0),
  next_action TEXT NOT NULL DEFAULT 'dispatch' CHECK (next_action IN ('dispatch','query','manual-reconcile')),
  dispatch_status TEXT NOT NULL DEFAULT 'queued' CHECK (dispatch_status IN ('queued','dispatching','dispatched','rejected')),
  attempt_id TEXT,
  fencing_token INTEGER,
  claimed_by TEXT,
  lease_until TEXT,
  reject_reason TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idem_key),
  UNIQUE (tenant_id, supplier_attempt_key),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES approval_claims(tenant_id, receipt_id),
  CHECK (dispatch_status != 'dispatching' OR (attempt_id IS NOT NULL AND fencing_token IS NOT NULL AND claimed_by IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (dispatch_status != 'queued' OR (attempt_id IS NULL AND fencing_token IS NULL AND claimed_by IS NULL AND lease_until IS NULL)),
  CHECK (dispatch_status != 'dispatched' OR (attempt_id IS NOT NULL AND fencing_token IS NOT NULL AND claimed_by IS NOT NULL)),
  CHECK (dispatch_status != 'rejected' OR reject_reason IS NOT NULL AND length(reject_reason) > 0)
);

CREATE TRIGGER IF NOT EXISTS write_effect_intents_attempt_immutable
BEFORE UPDATE OF attempt_id ON write_effect_intents
WHEN OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS NOT OLD.attempt_id
BEGIN
  SELECT RAISE(ABORT, 'write_effect_intents.attempt_id is immutable once persisted');
END;

CREATE TRIGGER IF NOT EXISTS write_effect_intents_dispatch_forward_only
BEFORE UPDATE OF dispatch_status ON write_effect_intents
WHEN (OLD.dispatch_status = 'dispatching' AND NEW.dispatch_status = 'queued')
  OR (OLD.dispatch_status IN ('dispatched','rejected') AND NEW.dispatch_status IN ('queued','dispatching'))
BEGIN
  SELECT RAISE(ABORT, 'write_effect_intents.dispatch_status is forward-only: dispatching/dispatched/rejected can never return to queued');
END;

CREATE TABLE IF NOT EXISTS write_gate_revocations (
  tenant_id TEXT NOT NULL DEFAULT 'local',
  actor_ref TEXT NOT NULL DEFAULT '*',
  principal_ref TEXT NOT NULL DEFAULT '*',
  seam TEXT NOT NULL DEFAULT '*',
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  revoked_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, actor_ref, principal_ref, seam)
);
`

/** 幂等建表 + 开启本连接外键强制(FK 是跨租户 receipt 的物理闸;既有表无外键,零行为影响) */
export function ensureWriteGate(db: import('better-sqlite3').Database): void {
  db.pragma('foreign_keys = ON')
  db.exec(WRITE_GATE_SCHEMA_SQL)
}

export interface PresentationCard {
  schema: typeof WRITE_GATE_SCHEMA
  challenge_id: string
  idem_key: string
  seam: string
  request_fingerprint_sha256: string
  delivery_nonce_digest: string
  amount_total: number
  currency: string
  travel_terms: string
  commission_disclosure: string
  valid_until: string
  presentation_key: string
  prepared_at: string
  expires_at: string
}

export type ConsumeVerdict =
  | { ok: true; effect: { idem_key: string; receipt_id: string; supplier_attempt_key: string; dispatch_status: 'queued' } }
  | { ok: false; reason: WriteGateRejection }

/** 事务内拒绝哨兵:突变点之后的拒绝必须 throw(回滚),不得 return(better-sqlite3 事务会提交 return) */
class WriteGateRejectionError extends Error {
  constructor(public reason: WriteGateRejection) { super(reason) }
}

export type ClaimVerdict =
  | { ok: true; attempt_id: string; fencing_token: number; lease_until: string }
  | { ok: false; reason: WriteGateRejection }

export type SimpleVerdict = { ok: true } | { ok: false; reason: WriteGateRejection }

function nowIso(now?: string): string {
  return now ?? new Date().toISOString()
}

export class WriteGate {
  readonly ledger: StateLedger

  constructor(ledger: StateLedger) {
    ensureWriteGate(ledger.db)
    this.ledger = ledger
  }

  private get db() { return this.ledger.db }
  private get tenant() { return this.ledger.tenant }

  // ---- L2/呈现前备妥(模型可请求展示的唯一通道) ---------------------------------

  /**
   * 呈现前服务端备妥:冻结 nonce/fingerprint/披露并绑定不可变请求。
   * 只在 pending_writes 存在且为 pending 时可备妥;重复备妥 = 旧挑战立即失效
   * (stale challenge 不得在重新呈现后确认)。prepared 不构成授权。
   */
  preparePresentation(input: {
    idemKey: string
    fields: WriteRequestFields
    /** 有效期(ISO;挑战过期不得确认/消费) */
    expiresAt: string
    attemptBudget?: number
    now?: string
  }): { ok: true; card: PresentationCard; /** 原始 nonce:只交可信宿主呈现通道,不入模型可见面/账本 */ trustedDelivery: { deliveryNonce: string } }
    | { ok: false; reason: WriteGateRejection } {
    const at = nowIso(input.now)
    if (!(WRITE_GATE_SEAMS as readonly string[]).includes(input.fields.seam)) return { ok: false, reason: 'unknown-seam' }
    const run = this.db.transaction((): { ok: true; card: PresentationCard; trustedDelivery: { deliveryNonce: string } } | { ok: false; reason: WriteGateRejection } => {
      const pending = this.db.prepare('SELECT status FROM pending_writes WHERE tenant_id = ? AND idem_key = ?').get(this.tenant, input.idemKey) as { status: string } | undefined
      if (!pending) return { ok: false, reason: 'missing-subject' }
      if (pending.status !== 'pending') return { ok: false, reason: 'subject-not-pending' }
      // 重新呈现:同 idem 的旧 prepared 挑战立即失效(stale nonce/旧卡片不得再确认)
      this.db.prepare(`UPDATE prepared_challenges SET status = 'expired' WHERE tenant_id = ? AND idem_key = ? AND status = 'prepared'`).run(this.tenant, input.idemKey)
      const deliveryNonce = makeDeliveryNonce()
      const nonceDigest = sha256(deliveryNonce)
      const fingerprint = computeRequestFingerprint(input.fields, nonceDigest)
      const challengeId = 'ch-' + randomUUID()
      this.db.prepare(
        `INSERT INTO prepared_challenges (tenant_id, challenge_id, idem_key, request_fingerprint_sha256, presentation_key, delivery_nonce_digest, actor_ref, principal_ref, seam, amount_total, currency, valid_until, prepared_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared')`,
      ).run(this.tenant, challengeId, input.idemKey, fingerprint, input.fields.presentationKey, nonceDigest, input.fields.actorRef, input.fields.principalRef, input.fields.seam, input.fields.amountTotal, input.fields.currency, input.fields.validUntil, at, input.expiresAt)
      this.ledger.insertEvent({
        actor: 'system:writegate',
        kind: 'writegate.challenge_prepared',
        subjectId: input.idemKey,
        payload: { challenge_id: challengeId, request_fingerprint_sha256: fingerprint, delivery_nonce_digest: nonceDigest },
        idemKey: `wgc:${challengeId}`,
        ts: at,
      })
      return {
        ok: true,
        card: {
          schema: WRITE_GATE_SCHEMA,
          challenge_id: challengeId,
          idem_key: input.idemKey,
          seam: input.fields.seam,
          request_fingerprint_sha256: fingerprint,
          delivery_nonce_digest: nonceDigest,
          amount_total: input.fields.amountTotal,
          currency: input.fields.currency,
          travel_terms: input.fields.travelTerms,
          commission_disclosure: input.fields.commissionDisclosure,
          valid_until: input.fields.validUntil,
          presentation_key: input.fields.presentationKey,
          prepared_at: at,
          expires_at: input.expiresAt,
        },
        trustedDelivery: { deliveryNonce },
      }
    })
    return run()
  }

  /** 过期清理(sweep):prepared 且 expires_at 已过 → expired;过期挑战不得确认/消费 */
  sweepExpiredChallenges(now?: string): number {
    const info = this.db.prepare(`UPDATE prepared_challenges SET status = 'expired' WHERE tenant_id = ? AND status = 'prepared' AND expires_at < ?`).run(this.tenant, nowIso(now))
    return info.changes
  }

  // ---- 可信宿主确认回调:发行 receipt(事务:挑战 confirmed + approval_claims 发行记录) ----

  /**
   * L3 可信宿主真人确认回调 → 服务端发行 ApprovalReceipt( issuance 记录,consumed_at 仍为 NULL)。
   * 校验:挑战存在/仍为 prepared/未过期、原始 delivery_nonce 摘要匹配(模型只有摘要 → 冒充必拒)、
   * actor/seam 绑定一致、无 L4 撤回。模型工具调用不在本通道(字段匹配 ≠ 用户许可)。
   */
  trustedHostConfirm(input: {
    challengeId: string
    /** 原始 nonce(可信宿主呈现通道交付;摘要/伪造值一律 nonce-mismatch) */
    deliveryNonce: string
    actorRef: string
    seam: string
    now?: string
  }): { ok: true; receiptId: string; requestFingerprintSha256: string } | { ok: false; reason: WriteGateRejection } {
    const at = nowIso(input.now)
    const run = this.db.transaction((): { ok: true; receiptId: string; requestFingerprintSha256: string } | { ok: false; reason: WriteGateRejection } => {
      const ch = this.db.prepare('SELECT * FROM prepared_challenges WHERE tenant_id = ? AND challenge_id = ?').get(this.tenant, input.challengeId) as
        | { challenge_id: string; idem_key: string; request_fingerprint_sha256: string; delivery_nonce_digest: string; actor_ref: string; principal_ref: string; seam: string; presentation_key: string; valid_until: string; expires_at: string; status: string; amount_total: number; currency: string }
        | undefined
      if (!ch) return { ok: false, reason: 'no-challenge' }
      if (ch.status === 'prepared' && ch.expires_at < at) return { ok: false, reason: 'challenge-expired' }
      if (ch.status !== 'prepared') return { ok: false, reason: 'challenge-not-prepared' }
      if (sha256(input.deliveryNonce) !== ch.delivery_nonce_digest) return { ok: false, reason: 'nonce-mismatch' }
      if (input.actorRef !== ch.actor_ref || input.seam !== ch.seam) return { ok: false, reason: 'binding-mismatch' }
      if (this.isRevoked({ actorRef: input.actorRef, seam: input.seam })) return { ok: false, reason: 'authority-revoked' }
      const receiptId = 'rc-' + randomUUID()
      this.db.prepare(`UPDATE prepared_challenges SET status = 'confirmed' WHERE tenant_id = ? AND challenge_id = ? AND status = 'prepared'`).run(this.tenant, input.challengeId)
      this.db.prepare(
        `INSERT INTO approval_claims (tenant_id, receipt_id, challenge_id, idem_key, nonce_digest, request_fingerprint_sha256, actor_ref, principal_ref, seam, presentation_key, valid_until, issued_at, consumed_at, amount_total, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        this.tenant, receiptId, ch.challenge_id, ch.idem_key, ch.delivery_nonce_digest, ch.request_fingerprint_sha256,
        input.actorRef, ch.principal_ref, ch.seam, ch.presentation_key, ch.valid_until, at, ch.amount_total, ch.currency,
      )
      this.ledger.insertEvent({
        actor: 'system:writegate',
        kind: 'writegate.receipt_issued',
        subjectId: ch.idem_key,
        payload: { receipt_id: receiptId, challenge_id: ch.challenge_id, request_fingerprint_sha256: ch.request_fingerprint_sha256 },
        idemKey: `wgr:${receiptId}`,
        ts: at,
      })
      return { ok: true, receiptId, requestFingerprintSha256: ch.request_fingerprint_sha256 }
    })
    return run()
  }

  // ---- 事务1:原子消费 + outbox 入队 ----------------------------------------------

  /**
   * 事务1(write-gate-production-design §5.2 步骤3,单 SQLite 事务,不得与事务2合并):
   *  a. 读发行记录并验证 tenant/actor/principal/seam/receipt/challenge 一致 + 跨 intent 重放拒绝;
   *  b. 重算请求指纹,与发行记录字节级一致(呈现/确认后任何字段漂移 = 拒绝);
   *  c. valid_until 未过、presentation_key 匹配、nonce 未消费;
   *  d. UPDATE approval_claims SET consumed_at WHERE consumed_at IS NULL —— 恰 1 行(一次性消费);
   *  e. pending_writes pending→confirmed(复用账本 saga 面,携 receipt);
   *  f. INSERT write_effect_intents(dispatch_status='queued')。
   * 任一步失败 → 整体回滚:无 claim 消费、无状态转移、outbox 零行、无 write.confirmed 事件。
   */
  consumeApprovalAndEnqueue(input: {
    receiptId: string
    idemKey: string
    /** 重算指纹用的请求字段(必须与呈现时逐字节一致;漂移即 fingerprint-mismatch) */
    fields: WriteRequestFields
    effectName: string
    now?: string
  }): ConsumeVerdict {
    const at = nowIso(input.now)
    const run = this.db.transaction((): ConsumeVerdict => {
      const claim = this.db.prepare('SELECT * FROM approval_claims WHERE tenant_id = ? AND receipt_id = ?').get(this.tenant, input.receiptId) as
        | { receipt_id: string; challenge_id: string; idem_key: string; nonce_digest: string; request_fingerprint_sha256: string; actor_ref: string; principal_ref: string; seam: string; presentation_key: string; valid_until: string; consumed_at: string | null }
        | undefined
      if (!claim) return { ok: false, reason: 'no-issuance-record' }
      if (claim.idem_key !== input.idemKey) return { ok: false, reason: 'cross-intent-replay' }
      if (claim.consumed_at !== null) return { ok: false, reason: 'approval-claimed' }
      if (input.fields.actorRef !== claim.actor_ref || input.fields.principalRef !== claim.principal_ref || input.fields.seam !== claim.seam) {
        return { ok: false, reason: 'binding-mismatch' }
      }
      if (claim.valid_until < at) return { ok: false, reason: 'receipt-expired' }
      if (this.isRevoked({ actorRef: claim.actor_ref, principalRef: claim.principal_ref, seam: claim.seam })) return { ok: false, reason: 'authority-revoked' }
      // b+c:指纹重算(nonce 摘要取自发行记录,不由调用方提供)——字段级漂移全部收敛到字节不等
      const recomputed = computeRequestFingerprint(input.fields, claim.nonce_digest)
      if (recomputed !== claim.request_fingerprint_sha256) return { ok: false, reason: 'fingerprint-mismatch' }
      if (input.fields.presentationKey !== claim.presentation_key) return { ok: false, reason: 'fingerprint-mismatch' }
      // 挑战必须已 confirmed(prepared 直接消费 = 拒绝;consumed 在 d 的单行约束兜底)
      const ch = this.db.prepare('SELECT status FROM prepared_challenges WHERE tenant_id = ? AND challenge_id = ?').get(this.tenant, claim.challenge_id) as { status: string } | undefined
      if (!ch || ch.status !== 'confirmed') return { ok: false, reason: 'challenge-not-prepared' }
      // d. 一次性消费(原子单行;并发/重放第二个到达者 changes=0 → approval-claimed)
      const consumed = this.db.prepare('UPDATE approval_claims SET consumed_at = ? WHERE tenant_id = ? AND receipt_id = ? AND consumed_at IS NULL').run(at, this.tenant, input.receiptId)
      if (consumed.changes !== 1) throw new WriteGateRejectionError('approval-claimed')
      // e. pending→confirmed(复用账本 saga 面:同事务携 receipt 事件;失败即回滚)
      const confirmed = this.ledger.confirmPendingWrite(input.idemKey, input.receiptId, 'system:writegate')
      if (!confirmed.ok) throw new WriteGateRejectionError('confirm-failed')
      // 挑战随之 consumed(字母表闭环;同事务)
      this.db.prepare(`UPDATE prepared_challenges SET status = 'consumed' WHERE tenant_id = ? AND challenge_id = ? AND status = 'confirmed'`).run(this.tenant, claim.challenge_id)
      // f. durable outbox 入队(物理约束:receipt 非空 CHECK + 跨租户复合外键 + queued 无领取字段)
      const supplierAttemptKey = 'sa-' + randomUUID()
      this.db.prepare(
        `INSERT INTO write_effect_intents (tenant_id, idem_key, effect_name, receipt_id, supplier_attempt_key, request_fingerprint_sha256, nonce_digest, actor_ref, principal_ref, seam, attempt_budget, next_action, dispatch_status, created, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatch', 'queued', ?, ?)`,
      ).run(this.tenant, input.idemKey, input.effectName, input.receiptId, supplierAttemptKey, claim.request_fingerprint_sha256, claim.nonce_digest, claim.actor_ref, claim.principal_ref, claim.seam, 1, at, at)
      return {
        ok: true,
        effect: { idem_key: input.idemKey, receipt_id: input.receiptId, supplier_attempt_key: supplierAttemptKey, dispatch_status: 'queued' },
      }
    })
    try {
      // IMMEDIATE:消费事务是写事务,先取写锁再读,跨进程并发下不依赖快照升级(失败封闭到 approval-claimed)
      return run.immediate()
    } catch (e) {
      if (e instanceof WriteGateRejectionError) return { ok: false, reason: e.reason }
      throw e
    }
  }

  // ---- 事务2:派发领取 + 派发前复验(机制层止于此;真实调用方 = #232,M5 Entry 后) ----

  /**
   * 事务2:原子领取。条件 UPDATE queued→dispatching,affected rows=1 唯一赢家;
   * 同事务先于任何外部调用持久化不可变 attempt_id/fencing_token/claimed_by/lease_until。
   * 输家(含跨进程竞争)changes=0,不得发起供应商调用。
   */
  claimForDispatch(input: { idemKey: string; claimedBy: string; leaseUntil: string; now?: string }): ClaimVerdict {
    const at = nowIso(input.now)
    const run = this.db.transaction((): ClaimVerdict => {
      const intent = this.db.prepare('SELECT dispatch_status FROM write_effect_intents WHERE tenant_id = ? AND idem_key = ?').get(this.tenant, input.idemKey) as { dispatch_status: string } | undefined
      if (!intent) return { ok: false, reason: 'missing-intent' }
      if (intent.dispatch_status !== 'queued') return { ok: false, reason: 'not-claimable' }
      const attemptId = 'at-' + randomUUID()
      const fencing = this.db.prepare('SELECT COALESCE(MAX(fencing_token), 0) + 1 AS t FROM write_effect_intents WHERE tenant_id = ? AND idem_key = ?').get(this.tenant, input.idemKey) as { t: number }
      const claimed = this.db.prepare(
        `UPDATE write_effect_intents SET dispatch_status = 'dispatching', attempt_id = ?, fencing_token = ?, claimed_by = ?, lease_until = ?, updated = ?
         WHERE tenant_id = ? AND idem_key = ? AND dispatch_status = 'queued'`,
      ).run(attemptId, fencing.t, input.claimedBy, input.leaseUntil, at, this.tenant, input.idemKey)
      if (claimed.changes !== 1) return { ok: false, reason: 'lost-race' }
      this.ledger.insertEvent({
        actor: 'system:writegate',
        kind: 'writegate.dispatch_claimed',
        subjectId: input.idemKey,
        payload: { attempt_id: attemptId, fencing_token: fencing.t, claimed_by: input.claimedBy, lease_until: input.leaseUntil },
        idemKey: `wgd:${attemptId}`,
        ts: at,
      })
      return { ok: true, attempt_id: attemptId, fencing_token: fencing.t, lease_until: input.leaseUntil }
    })
    // IMMEDIATE:领取必须先取写锁——两个 dispatcher 竞争时,输家在 BEGIN 处排队后看到已派发状态,
    // 统一 not-claimable/lost-race,绝不对陈旧快照做条件 UPDATE。
    return run.immediate()
  }

  /**
   * 派发前复验(§5.5;赢取领取后、任何供应商/网络调用前的同一派发点):
   * 授权(claim.consumed_at 仍指向本 intent)/报价与凭据有效期/不可变请求指纹/撤回状态。
   * 任一失败且调用未出门:供应商写=0,旧效果置 rejected(outbox 层终态,永不回 queued)。
   */
  preDispatchRevalidate(input: { idemKey: string; fields?: WriteRequestFields; now?: string }): SimpleVerdict {
    const at = nowIso(input.now)
    const intent = this.db.prepare('SELECT * FROM write_effect_intents WHERE tenant_id = ? AND idem_key = ?').get(this.tenant, input.idemKey) as
      | { dispatch_status: string; receipt_id: string; idem_key: string; request_fingerprint_sha256: string; actor_ref: string; principal_ref: string; seam: string }
      | undefined
    if (!intent) return { ok: false, reason: 'missing-intent' }
    if (intent.dispatch_status !== 'dispatching') return { ok: false, reason: 'not-claimable' }
    const claim = this.db.prepare('SELECT * FROM approval_claims WHERE tenant_id = ? AND receipt_id = ?').get(this.tenant, intent.receipt_id) as
      | { idem_key: string; consumed_at: string | null; request_fingerprint_sha256: string; valid_until: string }
      | undefined
    if (!claim || claim.consumed_at === null || claim.idem_key !== intent.idem_key) return { ok: false, reason: 'no-issuance-record' }
    if (claim.valid_until < at) return { ok: false, reason: 'receipt-expired' }
    if (claim.request_fingerprint_sha256 !== intent.request_fingerprint_sha256) return { ok: false, reason: 'fingerprint-mismatch' }
    if (input.fields) {
      const recomputed = computeRequestFingerprint(input.fields, this.nonceDigestOf(intent.receipt_id))
      if (recomputed !== intent.request_fingerprint_sha256) return { ok: false, reason: 'fingerprint-mismatch' }
    }
    if (this.isRevoked({ actorRef: intent.actor_ref, principalRef: intent.principal_ref, seam: intent.seam })) return { ok: false, reason: 'authority-revoked' }
    return { ok: true }
  }

  /** 派发前复验失败 → outbox 层终态 rejected(零供应商写;物理触发器保证永不回 queued) */
  rejectIntentBeforeDispatch(input: { idemKey: string; reason: string; now?: string }): SimpleVerdict {
    const at = nowIso(input.now)
    const info = this.db.prepare(
      `UPDATE write_effect_intents SET dispatch_status = 'rejected', reject_reason = ?, next_action = 'manual-reconcile', updated = ?
       WHERE tenant_id = ? AND idem_key = ? AND dispatch_status IN ('queued','dispatching')`,
    ).run(input.reason, at, this.tenant, input.idemKey)
    if (info.changes !== 1) return { ok: false, reason: 'not-claimable' }
    this.ledger.insertEvent({ actor: 'system:writegate', kind: 'writegate.intent_rejected', subjectId: input.idemKey, payload: { reason: input.reason }, idemKey: `wgx:${input.idemKey}`, ts: at })
    return { ok: true }
  }

  /** 复验通过、调用已出门 → dispatched(outbox 层记录;不是供应商成功凭据) */
  markIntentDispatched(input: { idemKey: string; now?: string }): SimpleVerdict {
    const at = nowIso(input.now)
    const info = this.db.prepare(`UPDATE write_effect_intents SET dispatch_status = 'dispatched', updated = ? WHERE tenant_id = ? AND idem_key = ? AND dispatch_status = 'dispatching'`).run(at, this.tenant, input.idemKey)
    return info.changes === 1 ? { ok: true } : { ok: false, reason: 'not-claimable' }
  }

  /**
   * 崩溃/超时/租约过期 → unknown 口径:dispatching 保持 dispatching(物理上不得回 queued),
   * next_action 置 query(只许查询/人工对账,禁止盲目重试)。
   */
  markIntentUnknown(input: { idemKey: string; reason: string; now?: string }): SimpleVerdict {
    const at = nowIso(input.now)
    const info = this.db.prepare(`UPDATE write_effect_intents SET next_action = 'query', updated = ? WHERE tenant_id = ? AND idem_key = ? AND dispatch_status = 'dispatching'`).run(at, this.tenant, input.idemKey)
    if (info.changes !== 1) return { ok: false, reason: 'not-claimable' }
    this.ledger.insertEvent({ actor: 'system:writegate', kind: 'writegate.outcome_unknown', subjectId: input.idemKey, payload: { reason: input.reason }, idemKey: `wgu:${input.idemKey}`, ts: at })
    return { ok: true }
  }

  // ---- L4 撤回(§9:撤回是账本事件,立即阻断未来副作用;已执行效果只能走补偿) ----------

  revokeAuthority(input: { actorRef?: string; principalRef?: string; seam?: string; reason: string; now?: string }): { ok: true } {
    const at = nowIso(input.now)
    this.db.prepare(
      `INSERT INTO write_gate_revocations (tenant_id, actor_ref, principal_ref, seam, reason, revoked_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, actor_ref, principal_ref, seam) DO UPDATE SET reason = excluded.reason, revoked_at = excluded.revoked_at`,
    ).run(this.tenant, input.actorRef ?? '*', input.principalRef ?? '*', input.seam ?? '*', input.reason, at)
    this.ledger.insertEvent({ actor: 'system:writegate', kind: 'writegate.revoked', subjectId: '*', payload: { actor_ref: input.actorRef ?? '*', principal_ref: input.principalRef ?? '*', seam: input.seam ?? '*', reason: input.reason }, idemKey: `wgv:${at}:${randomUUID()}`, ts: at })
    return { ok: true }
  }

  isRevoked(scope: { actorRef?: string; principalRef?: string; seam?: string }): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM write_gate_revocations WHERE tenant_id = ?
       AND (actor_ref = '*' OR actor_ref = ?)
       AND (principal_ref = '*' OR principal_ref = ?)
       AND (seam = '*' OR seam = ?)
       LIMIT 1`,
    ).get(this.tenant, scope.actorRef ?? '*', scope.principalRef ?? '*', scope.seam ?? '*')
    return row !== undefined
  }

  // ---- 只读面(对账/审计) --------------------------------------------------------

  getIntent(idemKey: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM write_effect_intents WHERE tenant_id = ? AND idem_key = ?').get(this.tenant, idemKey) as Record<string, unknown> | undefined
  }

  getClaim(receiptId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM approval_claims WHERE tenant_id = ? AND receipt_id = ?').get(this.tenant, receiptId) as Record<string, unknown> | undefined
  }

  getChallenge(challengeId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM prepared_challenges WHERE tenant_id = ? AND challenge_id = ?').get(this.tenant, challengeId) as Record<string, unknown> | undefined
  }

  listIntents(): Array<Record<string, unknown>> {
    return this.db.prepare('SELECT * FROM write_effect_intents WHERE tenant_id = ? ORDER BY created').all(this.tenant) as Array<Record<string, unknown>>
  }

  private nonceDigestOf(receiptId: string): string {
    const row = this.db.prepare('SELECT nonce_digest FROM approval_claims WHERE tenant_id = ? AND receipt_id = ?').get(this.tenant, receiptId) as { nonce_digest: string } | undefined
    return row?.nonce_digest ?? ''
  }
}
