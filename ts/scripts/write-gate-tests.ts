/**
 * WriteGate 机制层回归(write_gate.v1,issue #231,run-all §60):
 * 「持久化可信审批 + 原子 outbox」的离线否证套件。零真实供应商/交易调用——
 * 本模块 API 止于 outbox 入队/领取/派发前复验与本地 rejected/unknown 记账;
 * 产品运行时在 M5 Entry(#136)前不实例化 WriteGate(非运行时激活,默认路径零变化)。
 *
 * 反例覆盖(#231 验收 3 + #306 D-22 锚点 + write-gate-production-design §12 派发否证):
 *  1 契约封闭性:指纹 canonical 稳定(键序无关/任一授权字段漂移即变)、seam 封闭集
 *  2 主路径:L2 登记 → 呈现前备妥 → 可信宿主确认发行 → 原子消费+outbox 单事务
 *    (恰一次 claim 消费 / pending→confirmed 携 receipt / 恰一行 queued intent / saga 审计链合法)
 *  3 授权源:模型冒充真人确认(合法 actor+合法快照,仅摘要/伪造 nonce)→ 拒绝且零 outbox;
 *    伪造 receipt_id 拒绝;重新呈现后旧挑战/旧 nonce 确认拒绝
 *  4 一次性消费与并发:同 receipt 重放 approval-claimed;双连接竞争;双进程领取竞争恰一赢家
 *  5 绑定/过期:金额漂移/traveler-guests 摘要漂移 → fingerprint-mismatch;receipt/挑战过期;
 *    跨 intent 重放/跨租户 receipt 拒绝
 *  6 存储物理红线(裸 SQL 直接否证,应用层 if 不可替代):空 receipt CHECK、跨租户复合外键、
 *    dispatching 必携领取字段 CHECK、queued 必无领取字段 CHECK、attempt_id 不可变触发器、
 *    dispatch_status 只进不退触发器、nonce 唯一约束
 *  7 崩溃注入:事务1 三崩溃点(claim 消费/pending 转移/outbox 写入)注入 RAISE(ABORT)
 *    → 全有或全无;恢复后重放恰一次;崩溃→重启(重开 DB)后 durable 领取恰一次
 *  8 派发前复验 + L4 撤回:撤回在发行/消费/派发三点阻断未来副作用;复验失败 → rejected
 *    零写且永不回 queued;unknown 口径(dispatching 不回退,next_action=query,禁止盲目重试)
 * 运行(在 ts/ 下):npx tsx scripts/write-gate-tests.ts
 * 纪律:所有 stateRoot 走 mkdtemp(/tmp)隔离,不触 ts/gotry-state 与 dsh-runtime 共享状态。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { StateLedger, ensureLedger } from '../src/state-ledger.ts'
import {
  WRITE_GATE_SCHEMA,
  WRITE_GATE_SEAMS,
  WRITE_REQUEST_FINGERPRINT_SCHEMA,
  WriteGate,
  canonicalJson,
  computeRequestFingerprint,
  type WriteRequestFields,
} from '../src/write-gate.ts'

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

function sqliteErrorCode(fn: () => unknown): string {
  try {
    fn()
    return 'NO-ERROR'
  } catch (e) {
    return (e as { code?: string }).code ?? 'UNKNOWN'
  }
}

const TS_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function baseFields(over: Partial<WriteRequestFields> = {}): WriteRequestFields {
  return {
    tenantId: 'local',
    actorRef: 'actor:founder',
    principalRef: 'principal:traveler-1',
    seam: 'hotelbyte-hotel-book-confirm',
    supplier: 'hotelbyte:staicli@0.0.3:buyer-digest-abc',
    productRef: 'sessionId-x/ratePkgId-y',
    travelTerms: '2026-10-01..2026-10-02|1room|2guests|free-cancel|tax-incl',
    amountTotal: 128800,
    currency: 'CNY',
    commissionDisclosure: 'commission:5%',
    validUntil: new Date(Date.now() + 3600_000).toISOString(),
    presentationKey: sha('card-v1'),
    ...over,
  }
}

interface FlowResult { receiptId: string; fields: WriteRequestFields }

/** 一条走通到 outbox 入队的主路径(返回句柄供各反例在此基础上漂移) */
function fullFlow(wg: WriteGate, ledger: StateLedger, idemKey: string, over: Partial<WriteRequestFields> = {}): FlowResult {
  const fields = baseFields(over)
  ledger.requestPendingWrite({ idemKey, seam: fields.seam, payload: { note: 'fixture' } })
  const prep = wg.preparePresentation({ idemKey, fields, expiresAt: new Date(Date.now() + 600_000).toISOString() })
  if (!prep.ok) throw new Error(`prepare failed: ${prep.reason}`)
  const conf = wg.trustedHostConfirm({ challengeId: prep.card.challenge_id, deliveryNonce: prep.trustedDelivery.deliveryNonce, actorRef: fields.actorRef, seam: fields.seam })
  if (!conf.ok) throw new Error(`confirm failed: ${conf.reason}`)
  const consumed = wg.consumeApprovalAndEnqueue({ receiptId: conf.receiptId, idemKey, fields, effectName: 'hotel-book' })
  if (!consumed.ok) throw new Error(`consume failed: ${consumed.reason}`)
  return { receiptId: conf.receiptId, fields }
}

/** 发行到「已确认未消费」(供消费点反例在 receipt 在手时注入撤回/漂移) */
function flowToReceipt(wg: WriteGate, ledger: StateLedger, idemKey: string, over: Partial<WriteRequestFields> = {}): FlowResult {
  const fields = baseFields(over)
  ledger.requestPendingWrite({ idemKey, seam: fields.seam, payload: { note: 'fixture' } })
  const prep = wg.preparePresentation({ idemKey, fields, expiresAt: new Date(Date.now() + 600_000).toISOString() })
  if (!prep.ok) throw new Error(`prepare failed: ${prep.reason}`)
  const conf = wg.trustedHostConfirm({ challengeId: prep.card.challenge_id, deliveryNonce: prep.trustedDelivery.deliveryNonce, actorRef: fields.actorRef, seam: fields.seam })
  if (!conf.ok) throw new Error(`confirm failed: ${conf.reason}`)
  return { receiptId: conf.receiptId, fields }
}

// ---- 1:契约封闭性 ------------------------------------------------------------------

{
  console.log('  -- 1 契约封闭性(指纹 canonical / seam 封闭集)')
  const f1 = baseFields()
  const digestA = computeRequestFingerprint(f1, sha('nonce-1'))
  const digestB = computeRequestFingerprint({ ...f1, sponsorRef: undefined }, sha('nonce-1'))
  assert(WRITE_GATE_SCHEMA === 'write_gate.v1' && WRITE_REQUEST_FINGERPRINT_SCHEMA === 'gotry_write_request_fingerprint.v1', 'schema 词与设计 §3/§4 逐字一致')
  assert(digestA === digestB && digestA.length === 64, '指纹对等输入稳定(64 hex);canonical 序列化键序无关')
  const drift: Array<[string, WriteRequestFields, string]> = [
    ['金额+1', { ...f1, amountTotal: f1.amountTotal + 1 }, sha('nonce-1')],
    ['币种漂移', { ...f1, currency: 'USD' }, sha('nonce-1')],
    ['条款漂移(holder/guests 摘要)', { ...f1, travelTerms: f1.travelTerms.replace('2guests', '3guests') }, sha('nonce-1')],
    ['披露漂移', { ...f1, commissionDisclosure: 'none' }, sha('nonce-1')],
    ['卡片版本漂移', { ...f1, presentationKey: sha('card-v2') }, sha('nonce-1')],
    ['nonce 漂移', f1, sha('nonce-2')],
    ['traveler 漂移', { ...f1, principalRef: 'principal:traveler-2' }, sha('nonce-1')],
    ['actor 漂移', { ...f1, actorRef: 'actor:other' }, sha('nonce-1')],
    ['Buyer/路由漂移', { ...f1, supplier: f1.supplier.replace('buyer-digest-abc', 'buyer-digest-zzz') }, sha('nonce-1')],
  ]
  assert(drift.every(([, f, n]) => computeRequestFingerprint(f, n) !== digestA), '任一授权字段漂移 → 指纹字节不等(呈现/确认后不可变性的判定基准)')
  assert((WRITE_GATE_SEAMS as readonly string[]).join(',') === 'hotelbyte-hotel-book-confirm', '具名 seam 词汇封闭集(冻结属 M5 Entry 拍板,当前仅设计文档字面量)')
  assert(canonicalJson({ b: 1, a: [2, { c: 3 }] }) === canonicalJson({ a: [2, { c: 3 }], b: 1 }), 'canonicalJson 递归键排序')
}

// ---- 2/3/4/5:主路径与全部 API 级反例(隔离账本 #1) ----------------------------------

const root1 = mkdtempSync(join(tmpdir(), 'gotry-write-gate-'))
try {
  const ledger = ensureLedger(root1)
  const wg = new WriteGate(ledger)
  const sagaEventsOf = (key: string): Array<{ seq: number; kind: string; payload: string }> =>
    ledger.db.prepare(`SELECT seq, kind, payload FROM events WHERE tenant_id = ? AND subject_id = ? AND kind IN ('write.pending','write.confirmed','write.compensated') ORDER BY seq`).all(ledger.tenant, key) as Array<{ seq: number; kind: string; payload: string }>

  {
    console.log('  -- 2 主路径:L2 → 呈现前备妥 → 可信确认 → 原子消费+outbox(单事务)')
    const fields = baseFields()
    ledger.requestPendingWrite({ idemKey: 'wg:main', seam: fields.seam, payload: { note: 'main' } })
    const prep = wg.preparePresentation({ idemKey: 'wg:main', fields, expiresAt: new Date(Date.now() + 600_000).toISOString() })
    assert(prep.ok, '呈现前备妥成功(L2 已登记 + seam 在封闭集)')
    if (prep.ok) {
      const card = prep.card
      assert(card.request_fingerprint_sha256 === computeRequestFingerprint(fields, card.delivery_nonce_digest), '卡片指纹 = 字段+nonce 摘要的服务端冻结值(呈现前已含 nonce)')
      assert(!('deliveryNonce' in card) && card.delivery_nonce_digest === sha(prep.trustedDelivery.deliveryNonce), '卡片只含 nonce 摘要;原始 nonce 只在可信宿主交付面')
      const rawNonceRow = ledger.db.prepare('SELECT COUNT(*) AS n FROM prepared_challenges WHERE delivery_nonce_digest = ?').get(prep.trustedDelivery.deliveryNonce) as { n: number }
      assert(rawNonceRow.n === 0, '原始 nonce 不落库(只存摘要)')
      const conf = wg.trustedHostConfirm({ challengeId: card.challenge_id, deliveryNonce: prep.trustedDelivery.deliveryNonce, actorRef: fields.actorRef, seam: fields.seam })
      assert(conf.ok, '可信宿主真人确认回调 → 发行 receipt(issuance 记录,consumed_at 仍空)')
      if (conf.ok) {
        const claim = wg.getClaim(conf.receiptId) as Record<string, unknown> | undefined
        assert(claim !== undefined && claim['consumed_at'] === null, '发行记录在案且未消费')
        const ch = wg.getChallenge(card.challenge_id) as Record<string, unknown> | undefined
        assert(ch !== undefined && ch['status'] === 'confirmed', '挑战 prepared→confirmed(prepared 不构成授权,确认后才可消费)')
        const consumed = wg.consumeApprovalAndEnqueue({ receiptId: conf.receiptId, idemKey: 'wg:main', fields, effectName: 'hotel-book' })
        assert(consumed.ok, '原子消费 + outbox 入队成功')
        const intent = wg.getIntent('wg:main') as Record<string, unknown> | undefined
        assert(intent !== undefined && intent['dispatch_status'] === 'queued' && intent['receipt_id'] === conf.receiptId, 'durable outbox 恰一行 queued,绑定 receipt')
        assert(intent !== undefined && intent['attempt_id'] === null && intent['fencing_token'] === null, 'queued 行无领取字段(领取前不存在 attempt)')
        const pendingRow = ledger.listPendingWrites().find(w => w.idem_key === 'wg:main')
        assert(pendingRow?.status === 'confirmed' && pendingRow?.receipt === conf.receiptId, 'pending_writes pending→confirmed 且携 receipt(saga 物理面对账)')
        const claimAfter = wg.getClaim(conf.receiptId) as Record<string, unknown>
        assert(typeof claimAfter['consumed_at'] === 'string', 'approval_claims.consumed_at 恰被置一次')
        const chAfter = wg.getChallenge(card.challenge_id) as Record<string, unknown>
        assert(chAfter['status'] === 'consumed', '挑战 confirmed→consumed(字母表闭环)')
        const kinds = sagaEventsOf('wg:main').map(e => e.kind).join(',')
        assert(kinds === 'write.pending,write.confirmed', 'saga 审计链 = write.pending→write.confirmed(被拒调用零事件)')
      }
    }
  }

  {
    console.log('  -- 3 授权源:模型冒充/伪造凭据/重新呈现后旧挑战')
    const fields = baseFields()
    ledger.requestPendingWrite({ idemKey: 'wg:model', seam: fields.seam, payload: {} })
    const prep = wg.preparePresentation({ idemKey: 'wg:model', fields, expiresAt: new Date(Date.now() + 600_000).toISOString() })
    if (!prep.ok) throw new Error('unreachable')
    // 模型可见面只有卡片(摘要);即使携带合法 actor + 合法快照,凭摘要/伪造 nonce 的确认一律拒绝
    const m1 = wg.trustedHostConfirm({ challengeId: prep.card.challenge_id, deliveryNonce: prep.card.delivery_nonce_digest, actorRef: fields.actorRef, seam: fields.seam })
    const m2 = wg.trustedHostConfirm({ challengeId: prep.card.challenge_id, deliveryNonce: sha('forged'), actorRef: fields.actorRef, seam: fields.seam })
    const m3 = wg.trustedHostConfirm({ challengeId: prep.card.challenge_id, deliveryNonce: prep.trustedDelivery.deliveryNonce, actorRef: 'actor:attacker', seam: fields.seam })
    assert(!m1.ok && m1.reason === 'nonce-mismatch' && !m2.ok && m2.reason === 'nonce-mismatch', '摘要/伪造 nonce 冒充真人确认 → nonce-mismatch(字段匹配 ≠ 用户许可)')
    assert(!m3.ok && m3.reason === 'binding-mismatch', 'actor 绑定不一致 → binding-mismatch')
    assert(wg.getClaim('rc-forged') === undefined, '被拒确认零发行记录')
    const claimRows = (ledger.db.prepare("SELECT COUNT(*) AS n FROM approval_claims WHERE idem_key = 'wg:model'").get() as { n: number }).n
    const intentRows = (ledger.db.prepare("SELECT COUNT(*) AS n FROM write_effect_intents WHERE idem_key = 'wg:model'").get() as { n: number }).n
    assert(claimRows === 0 && intentRows === 0, '模型冒充路径零 claim、零 outbox 行(无 outbox 即无派发权)')

    const fake = wg.consumeApprovalAndEnqueue({ receiptId: 'rc-not-issued', idemKey: 'wg:model', fields, effectName: 'hotel-book' })
    assert(!fake.ok && fake.reason === 'no-issuance-record', '客户端自supply receipt_id → no-issuance-record(只有账本发行记录有效)')

    // 重新呈现:同 idem 二次备妥 → 旧挑战(携旧 nonce)立即失效,旧 nonce 不得再确认
    const oldNonce = prep.trustedDelivery.deliveryNonce
    const prep2 = wg.preparePresentation({ idemKey: 'wg:model', fields, expiresAt: new Date(Date.now() + 600_000).toISOString() })
    if (!prep2.ok) throw new Error('unreachable: ' + prep2.reason)
    assert(prep2.card.challenge_id !== prep.card.challenge_id, '重新呈现生成新挑战')
    const stale = wg.trustedHostConfirm({ challengeId: prep.card.challenge_id, deliveryNonce: oldNonce, actorRef: fields.actorRef, seam: fields.seam })
    assert(!stale.ok && stale.reason === 'challenge-not-prepared', '重新呈现后旧挑战/旧 nonce 确认 → 拒绝(stale 失败关闭)')
    const fresh = wg.trustedHostConfirm({ challengeId: prep2.card.challenge_id, deliveryNonce: prep2.trustedDelivery.deliveryNonce, actorRef: fields.actorRef, seam: fields.seam })
    assert(fresh.ok, '只有最新挑战可被可信宿主确认')
  }

  {
    console.log('  -- 4 一次性消费:同 receipt 重放 / 双连接竞争 / 双进程领取竞争恰一赢家')
    const { receiptId, fields } = fullFlow(wg, ledger, 'wg:replay')
    const replay = wg.consumeApprovalAndEnqueue({ receiptId, idemKey: 'wg:replay', fields, effectName: 'hotel-book' })
    assert(!replay.ok && replay.reason === 'approval-claimed', '同 receipt 重放 → approval-claimed')
    const intents = wg.listIntents().filter(i => i['idem_key'] === 'wg:replay')
    assert(intents.length === 1, '重放后 outbox 仍恰一行(不重复入队)')
    const confirmedEvents = ledger.readEvents('write.confirmed', 50).filter(e => e.subject_id === 'wg:replay')
    assert(confirmedEvents.length === 1, 'write.confirmed 恰一次(单次确认)')

    // 双连接(独立句柄)重放同一 receipt:输家 approval-claimed,零新行
    const db2 = new Database(ledger.dbPath)
    db2.pragma('busy_timeout = 5000')
    const ledger2 = new StateLedger(db2, root1, 'local')
    const wg2 = new WriteGate(ledger2)
    const { receiptId: rid2, fields: f2 } = fullFlow(wg, ledger, 'wg:replay2')
    const loser = wg2.consumeApprovalAndEnqueue({ receiptId: rid2, idemKey: 'wg:replay2', fields: f2, effectName: 'hotel-book' })
    assert(!loser.ok && loser.reason === 'approval-claimed', '第二连接重放同一 receipt → approval-claimed(条件 UPDATE 恰 1 行语义)')
    db2.close()

    // 双进程领取竞争:两个真实子进程就绪后同时 claim 同一 queued intent,恰一赢家
    const fullFlow3 = fullFlow(wg, ledger, 'wg:race')
    void fullFlow3
    const goPath = join(root1, 'go')
    const readyA = join(root1, 'ready-a')
    const readyB = join(root1, 'ready-b')
    const childSrc = `
import { createRequire } from 'node:module'
import { existsSync, writeFileSync } from 'node:fs'
const req = createRequire(process.env.TS_PKG)
const Database = req('better-sqlite3')
const { StateLedger } = await import(process.env.STATE_LEDGER_TS)
const { WriteGate } = await import(process.env.WRITE_GATE_TS)
const db = new Database(process.env.DB_PATH)
db.pragma('busy_timeout = 10000')
const ledger = new StateLedger(db, process.env.STATE_ROOT, 'local')
const wg = new WriteGate(ledger)
writeFileSync(process.env.CHILD_READY, 'ready')
while (!existsSync(process.env.GO_PATH)) { await new Promise(r => setTimeout(r, 5)) }
const v = wg.claimForDispatch({ idemKey: 'wg:race', claimedBy: 'proc-' + process.pid, leaseUntil: new Date(Date.now() + 60000).toISOString() })
console.log(JSON.stringify(v))
`
    const childPath = join(root1, 'claim-child.mjs')
    writeFileSync(childPath, childSrc)
    const childEnv = {
      ...process.env,
      TS_PKG: join(TS_DIR, 'package.json'),
      STATE_LEDGER_TS: 'file://' + join(TS_DIR, 'src', 'state-ledger.ts'),
      WRITE_GATE_TS: 'file://' + join(TS_DIR, 'src', 'write-gate.ts'),
      DB_PATH: ledger.dbPath,
      STATE_ROOT: root1,
      GO_PATH: goPath,
    }
    const tsxCli = join(TS_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const startChild = (readyFlag: string) => spawn(process.execPath, [tsxCli, childPath], { cwd: TS_DIR, env: { ...childEnv, CHILD_READY: readyFlag } })
    const waitExit = (p: ReturnType<typeof spawn>): Promise<{ stdout: string; stderr: string }> => new Promise((resolve, reject) => {
      let out = ''
      let err = ''
      p.stdout?.on('data', d => { out += String(d) })
      p.stderr?.on('data', d => { err += String(d) })
      p.on('error', reject)
      p.on('exit', () => resolve({ stdout: out, stderr: err }))
    })
    const c1 = startChild(readyA)
    const c2 = startChild(readyB)
    const deadline = Date.now() + 120_000
    while ((!existsSync(readyA) || !existsSync(readyB)) && Date.now() < deadline) await sleep(50)
    assert(existsSync(readyA) && existsSync(readyB), '两个竞争子进程均已就绪(真双进程)')
    writeFileSync(goPath, 'go')
    const [r1, r2] = await Promise.all([waitExit(c1), waitExit(c2)])
    const out1 = r1.stdout.trim()
    const out2 = r2.stdout.trim()
    const wins = [out1, out2].filter(o => o.includes('"ok":true')).length
    assert(wins === 1, `双进程领取竞争恰一赢家(out1=${out1 || 'ERR:' + r1.stderr.slice(-160)} out2=${out2 || 'ERR:' + r2.stderr.slice(-160)})`)
    const raceIntent = wg.getIntent('wg:race') as Record<string, unknown>
    assert(raceIntent['dispatch_status'] === 'dispatching' && typeof raceIntent['attempt_id'] === 'string' && raceIntent['fencing_token'] === 1, '赢家居于 dispatching 且携唯一 attempt/fencing(先于任何外部调用落库)')
    const winnerRows = ledger.db.prepare("SELECT COUNT(*) AS n FROM write_effect_intents WHERE attempt_id IS NOT NULL AND idem_key = 'wg:race'").get() as { n: number }
    assert(winnerRows.n === 1, '同 intent 恰一个持久化 attempt(输家零变更)')
    const claimAgain = wg.claimForDispatch({ idemKey: 'wg:race', claimedBy: 'main', leaseUntil: new Date(Date.now() + 60000).toISOString() })
    assert(!claimAgain.ok && claimAgain.reason === 'not-claimable', '派发后重试领取 → not-claimable(不可重新派发)')
  }

  {
    console.log('  -- 5 绑定/过期:字段漂移 / 过期 / 跨 intent / 跨租户')
    const bindKeyOf = (over: Partial<WriteRequestFields>): string => 'wg:bind-' + sha(JSON.stringify(over)).slice(0, 8)
    const mk = (over: Partial<WriteRequestFields>): FlowResult => {
      const key = bindKeyOf(over)
      const fields = baseFields(over)
      ledger.requestPendingWrite({ idemKey: key, seam: fields.seam, payload: {} })
      const prep = wg.preparePresentation({ idemKey: key, fields, expiresAt: new Date(Date.now() + 600_000).toISOString() })
      if (!prep.ok) throw new Error('prepare: ' + prep.reason)
      const conf = wg.trustedHostConfirm({ challengeId: prep.card.challenge_id, deliveryNonce: prep.trustedDelivery.deliveryNonce, actorRef: fields.actorRef, seam: fields.seam })
      if (!conf.ok) throw new Error('confirm: ' + conf.reason)
      return { receiptId: conf.receiptId, fields }
    }
    // 金额漂移(绑定一致、指纹不等)
    const amount = mk({})
    const amountKey = bindKeyOf({})
    const amountDrift = wg.consumeApprovalAndEnqueue({ receiptId: amount.receiptId, idemKey: amountKey, fields: { ...amount.fields, amountTotal: amount.fields.amountTotal + 1 }, effectName: 'hotel-book' })
    assert(!amountDrift.ok && amountDrift.reason === 'fingerprint-mismatch', '呈现/确认后金额+1 → fingerprint-mismatch')
    assert((wg.getIntent(amountKey) ?? null) === null, '金额漂移消费零 outbox 行')
    // guests 摘要漂移(绑定一致、指纹不等)——确认后改履约字段零写
    const terms = mk({ principalRef: 'principal:traveler-9' })
    const termsKey = bindKeyOf({ principalRef: 'principal:traveler-9' })
    const swapped = wg.consumeApprovalAndEnqueue({ receiptId: terms.receiptId, idemKey: termsKey, fields: { ...terms.fields, travelTerms: terms.fields.travelTerms.replace('2guests', '9guests') }, effectName: 'hotel-book' })
    assert(!swapped.ok && swapped.reason === 'fingerprint-mismatch', '确认后改 holder/guests 摘要 → fingerprint-mismatch(换旅客/人数零写)')
    // 跨 intent 重放
    const crossIntent = wg.consumeApprovalAndEnqueue({ receiptId: amount.receiptId, idemKey: 'wg:other-intent', fields: amount.fields, effectName: 'hotel-book' })
    assert(!crossIntent.ok && crossIntent.reason === 'cross-intent-replay', '同 receipt 跨 intent 重放 → cross-intent-replay')
    assert((wg.getIntent('wg:other-intent') ?? null) === null, '跨 intent 重放零 outbox 行')
    // receipt 过期(报价/授权有效期在消费点已过)
    const pastValid = new Date(Date.now() - 1000).toISOString()
    const exp = mk({ validUntil: pastValid })
    const expired = wg.consumeApprovalAndEnqueue({ receiptId: exp.receiptId, idemKey: bindKeyOf({ validUntil: pastValid }), fields: exp.fields, effectName: 'hotel-book' })
    assert(!expired.ok && expired.reason === 'receipt-expired', '消费点凭据过期 → receipt-expired(零供应商写)')
    assert((wg.getIntent(bindKeyOf({ validUntil: pastValid })) ?? null) === null, '过期消费零 outbox 行')
    // 挑战过期:prepared 且 expires_at 已过 → 不得确认;无确认即无发行无派发
    ledger.requestPendingWrite({ idemKey: 'wg:chexp', seam: baseFields().seam, payload: {} })
    const chexp = wg.preparePresentation({ idemKey: 'wg:chexp', fields: baseFields(), expiresAt: new Date(Date.now() - 1000).toISOString() })
    if (!chexp.ok) throw new Error('unreachable: ' + chexp.reason)
    const lateConfirm = wg.trustedHostConfirm({ challengeId: chexp.card.challenge_id, deliveryNonce: chexp.trustedDelivery.deliveryNonce, actorRef: baseFields().actorRef, seam: baseFields().seam })
    assert(!lateConfirm.ok && lateConfirm.reason === 'challenge-expired', '过期挑战确认 → challenge-expired')
    assert(wg.sweepExpiredChallenges() >= 1, '过期清理 sweep 生效(prepared → expired)')
    // 跨租户:tenant-b 用 A 的 receipt 消费/领取 → 租户作用域查无;A/B 同 idem_key 意图隔离
    const dbB = new Database(ledger.dbPath)
    dbB.pragma('busy_timeout = 5000')
    const ledgerB = new StateLedger(dbB, root1, 'tenant-b')
    const wgB = new WriteGate(ledgerB)
    const tenantA = fullFlow(wg, ledger, 'wg:tenant-a')
    const crossTenant = wgB.consumeApprovalAndEnqueue({ receiptId: tenantA.receiptId, idemKey: 'wg:tenant-a', fields: tenantA.fields, effectName: 'hotel-book' })
    assert(!crossTenant.ok && crossTenant.reason === 'no-issuance-record', '跨租户消费他租户 receipt → 查无发行记录(tenant 一等字段)')
    const crossClaim = wgB.claimForDispatch({ idemKey: 'wg:tenant-a', claimedBy: 'tenant-b-worker', leaseUntil: new Date(Date.now() + 60000).toISOString() })
    assert(!crossClaim.ok && crossClaim.reason === 'missing-intent', 'tenant-b 按 idem_key 领取 A 的意图 → missing-intent(cross-tenant affected rows=0)')
    ledgerB.requestPendingWrite({ idemKey: 'wg:tenant-a', seam: baseFields().seam, payload: {} })
    const prepB = wgB.preparePresentation({ idemKey: 'wg:tenant-a', fields: baseFields(), expiresAt: new Date(Date.now() + 600_000).toISOString() })
    assert(prepB.ok, '同 idem_key 在 tenant-b 可独立备妥(互不可见)')
    dbB.close()
  }
} finally {
  rmSync(root1, { recursive: true, force: true })
}

// ---- 6/6b/8:存储物理红线 + 撤回/复验(隔离账本 #2,不关闭连接) ------------------------

const root2 = mkdtempSync(join(tmpdir(), 'gotry-write-gate-phys-'))
try {
  const ledger = ensureLedger(root2)
  const wg = new WriteGate(ledger)

  {
    console.log('  -- 6 存储物理红线(裸 SQL 直接否证;应用层 if 不可替代)')
    const { receiptId } = fullFlow(wg, ledger, 'wg:phys')
    // 空 receipt → CHECK;outbox 零行
    const emptyReceipt = sqliteErrorCode(() => ledger.db.prepare(
      `INSERT INTO write_effect_intents (tenant_id, idem_key, effect_name, receipt_id, supplier_attempt_key, request_fingerprint_sha256, nonce_digest, actor_ref, principal_ref, seam, attempt_budget, next_action, dispatch_status, created, updated)
       VALUES ('local','wg:phys-empty','x','', 'sa-empty', ?, ?, 'a', 'p', 'hotelbyte-hotel-book-confirm', 1, 'dispatch', 'queued', '2026-01-01', '2026-01-01')`,
    ).run(sha('f'), sha('n')))
    assert(emptyReceipt === 'SQLITE_CONSTRAINT_CHECK', `空 receipt 直插 outbox → 物理 CHECK 拒绝(${emptyReceipt})`)
    assert((wg.getIntent('wg:phys-empty') ?? null) === null, '空 receipt 的 outbox 行不存在(零行)')
    // 跨租户 receipt → 复合外键;outbox 零行
    const crossTenant = sqliteErrorCode(() => ledger.db.prepare(
      `INSERT INTO write_effect_intents (tenant_id, idem_key, effect_name, receipt_id, supplier_attempt_key, request_fingerprint_sha256, nonce_digest, actor_ref, principal_ref, seam, attempt_budget, next_action, dispatch_status, created, updated)
       VALUES ('tenant-z','wg:phys-cross','x', ?, 'sa-cross', ?, ?, 'a', 'p', 'hotelbyte-hotel-book-confirm', 1, 'dispatch', 'queued', '2026-01-01', '2026-01-01')`,
    ).run(receiptId, sha('f2'), sha('n2')))
    assert(crossTenant === 'SQLITE_CONSTRAINT_FOREIGNKEY', `跨租户 receipt 直插 → 复合外键物理拒绝(${crossTenant})`)
    assert((wg.getIntent('wg:phys-cross') ?? null) === null, '跨租户 receipt 的 outbox 行不存在(tenant-z 作用域零行)')
    // nonce 唯一约束(物理)
    const dupNonce = sqliteErrorCode(() => ledger.db.prepare(
      `INSERT INTO prepared_challenges (tenant_id, challenge_id, idem_key, request_fingerprint_sha256, presentation_key, delivery_nonce_digest, actor_ref, principal_ref, seam, amount_total, currency, valid_until, prepared_at, expires_at, status)
       VALUES ('local','ch-dup','wg:phys', ?, 'pk', (SELECT delivery_nonce_digest FROM prepared_challenges WHERE tenant_id='local' LIMIT 1), 'a', 'p', 'hotelbyte-hotel-book-confirm', 1, 'CNY', '2027-01-01', '2026-01-01', '2027-01-01', 'prepared')`,
    ).run(sha('f3')))
    assert(dupNonce === 'SQLITE_CONSTRAINT_UNIQUE', `同 nonce 摘要重复呈现面 → UNIQUE 物理拒绝(${dupNonce})`)
    // dispatching 直插但缺领取字段 → CHECK(「调用先于领取落库」在存储层不可能成立)
    const missingAttempt = sqliteErrorCode(() => ledger.db.prepare(
      `INSERT INTO write_effect_intents (tenant_id, idem_key, effect_name, receipt_id, supplier_attempt_key, request_fingerprint_sha256, nonce_digest, actor_ref, principal_ref, seam, attempt_budget, next_action, dispatch_status, created, updated)
       VALUES ('local','wg:phys-noattempt','x', ?, 'sa-noattempt', ?, ?, 'a', 'p', 'hotelbyte-hotel-book-confirm', 1, 'dispatch', 'dispatching', '2026-01-01', '2026-01-01')`,
    ).run(receiptId, sha('f4'), sha('n4')))
    assert(missingAttempt === 'SQLITE_CONSTRAINT_CHECK', `dispatching 直插缺 attempt/领取字段 → 物理 CHECK 拒绝(${missingAttempt})`)
    // queued 直插携领取字段 → CHECK
    const queuedWithAttempt = sqliteErrorCode(() => ledger.db.prepare(
      `INSERT INTO write_effect_intents (tenant_id, idem_key, effect_name, receipt_id, supplier_attempt_key, request_fingerprint_sha256, nonce_digest, actor_ref, principal_ref, seam, attempt_budget, next_action, dispatch_status, attempt_id, fencing_token, claimed_by, lease_until, created, updated)
       VALUES ('local','wg:phys-qwa','x', ?, 'sa-qwa', ?, ?, 'a', 'p', 'hotelbyte-hotel-book-confirm', 1, 'dispatch', 'queued', 'at-x', 1, 'w', '2027-01-01', '2026-01-01', '2026-01-01')`,
    ).run(receiptId, sha('f5'), sha('n5')))
    assert(queuedWithAttempt === 'SQLITE_CONSTRAINT_CHECK', `queued 携领取字段直插 → 物理 CHECK 拒绝(${queuedWithAttempt})`)
  }

  {
    console.log('  -- 6b attempt_id 不可变 / dispatch_status 只进不退(触发器物理否证)')
    fullFlow(wg, ledger, 'wg:fence')
    const got = wg.claimForDispatch({ idemKey: 'wg:fence', claimedBy: 'w1', leaseUntil: new Date(Date.now() + 60000).toISOString() })
    assert(got.ok, '领取成功(dispatching + 不可变 attempt 落库)')
    if (got.ok) {
      const swapAttempt = sqliteErrorCode(() => ledger.db.prepare(`UPDATE write_effect_intents SET attempt_id = 'at-forged' WHERE tenant_id = 'local' AND idem_key = 'wg:fence'`).run())
      assert(swapAttempt === 'SQLITE_CONSTRAINT_TRIGGER', `attempt_id 落库后改写 → 触发器物理 ABORT(${swapAttempt})`)
      const backToQueued = sqliteErrorCode(() => ledger.db.prepare(`UPDATE write_effect_intents SET dispatch_status = 'queued' WHERE tenant_id = 'local' AND idem_key = 'wg:fence'`).run())
      assert(backToQueued === 'SQLITE_CONSTRAINT_TRIGGER', `dispatching → queued(崩溃/租约过期重置)→ 触发器物理 ABORT(${backToQueued})`)
      const intent = wg.getIntent('wg:fence') as Record<string, unknown>
      assert(intent['attempt_id'] === got.attempt_id && intent['dispatch_status'] === 'dispatching', '两次物理拒绝后行状态不变(attempt/dispatching 保持)')
    }
    fullFlow(wg, ledger, 'wg:fence-d')
    wg.claimForDispatch({ idemKey: 'wg:fence-d', claimedBy: 'w1', leaseUntil: new Date(Date.now() + 60000).toISOString() })
    wg.markIntentDispatched({ idemKey: 'wg:fence-d' })
    const dispatchedToQueued = sqliteErrorCode(() => ledger.db.prepare(`UPDATE write_effect_intents SET dispatch_status = 'queued' WHERE tenant_id = 'local' AND idem_key = 'wg:fence-d'`).run())
    assert(dispatchedToQueued === 'SQLITE_CONSTRAINT_TRIGGER', 'dispatched → queued 物理拒绝')
    fullFlow(wg, ledger, 'wg:fence-r')
    wg.claimForDispatch({ idemKey: 'wg:fence-r', claimedBy: 'w1', leaseUntil: new Date(Date.now() + 60000).toISOString() })
    wg.rejectIntentBeforeDispatch({ idemKey: 'wg:fence-r', reason: 'quote-expired' })
    const rejectedToQueued = sqliteErrorCode(() => ledger.db.prepare(`UPDATE write_effect_intents SET dispatch_status = 'queued' WHERE tenant_id = 'local' AND idem_key = 'wg:fence-r'`).run())
    assert(rejectedToQueued === 'SQLITE_CONSTRAINT_TRIGGER', 'rejected → queued 物理拒绝(拒绝即终态,永不回队)')
  }

  {
    console.log('  -- 8 派发前复验 + L4 撤回(发行/消费/派发三点阻断未来副作用)')
    // (a) 撤回在派发前(principal 级):领取仍成功,复验失败 → rejected 终态零写,永不回 queued
    const c = fullFlow(wg, ledger, 'wg:rev-dispatch', { principalRef: 'principal:revoke-me' })
    const claimC = wg.claimForDispatch({ idemKey: 'wg:rev-dispatch', claimedBy: 'w1', leaseUntil: new Date(Date.now() + 60000).toISOString() })
    assert(claimC.ok, '领取成功(领取≠派发;复验在任何外部调用前拦截)')
    wg.revokeAuthority({ principalRef: 'principal:revoke-me', reason: 'traveler revoked consent' })
    const rev = wg.preDispatchRevalidate({ idemKey: 'wg:rev-dispatch', fields: c.fields })
    assert(!rev.ok && rev.reason === 'authority-revoked', '撤回后派发前复验 → authority-revoked(L4 撤回阻断未来副作用)')
    const rejected = wg.rejectIntentBeforeDispatch({ idemKey: 'wg:rev-dispatch', reason: 'authority-revoked' })
    assert(rejected.ok, '复验失败 → outbox 层置 rejected(零供应商写)')
    const rj = wg.getIntent('wg:rev-dispatch') as Record<string, unknown>
    assert(rj['dispatch_status'] === 'rejected' && rj['reject_reason'] === 'authority-revoked', 'rejected 终态携原因(reject_reason)')
    const back = sqliteErrorCode(() => ledger.db.prepare(`UPDATE write_effect_intents SET dispatch_status = 'queued' WHERE tenant_id = 'local' AND idem_key = 'wg:rev-dispatch'`).run())
    assert(back === 'SQLITE_CONSTRAINT_TRIGGER', 'rejected 不得回 queued(物理)')

    // (b) 撤回不能抹已执行效果:dispatched 行不受影响(已执行效果只能走补偿,#233 面)
    const disp = wg.getIntent('wg:fence-d') as Record<string, unknown>
    assert(disp['dispatch_status'] === 'dispatched', '撤回不影响已派发行(已执行效果只能走补偿,不由撤回消除)')

    // (c) 派发点凭据过期(队列中过期):now 注入跨过 valid_until → receipt-expired → rejected
    const t0 = new Date().toISOString()
    const tValid = new Date(Date.parse(t0) + 60_000).toISOString()
    const expKey = 'wg:rev-expiry'
    ledger.requestPendingWrite({ idemKey: expKey, seam: baseFields().seam, payload: {} })
    const expPrep = wg.preparePresentation({ idemKey: expKey, fields: baseFields({ validUntil: tValid }), expiresAt: new Date(Date.parse(t0) + 3600_000).toISOString(), now: t0 })
    if (!expPrep.ok) throw new Error('unreachable')
    const expConf = wg.trustedHostConfirm({ challengeId: expPrep.card.challenge_id, deliveryNonce: expPrep.trustedDelivery.deliveryNonce, actorRef: baseFields().actorRef, seam: baseFields().seam, now: t0 })
    if (!expConf.ok) throw new Error('unreachable')
    const expConsume = wg.consumeApprovalAndEnqueue({ receiptId: expConf.receiptId, idemKey: expKey, fields: baseFields({ validUntil: tValid }), effectName: 'hotel-book', now: t0 })
    assert(expConsume.ok, '有效期窗口内消费入队成功')
    const tLate = new Date(Date.parse(t0) + 120_000).toISOString()
    wg.claimForDispatch({ idemKey: expKey, claimedBy: 'w2', leaseUntil: new Date(Date.parse(tLate) + 60000).toISOString(), now: tLate })
    const revE = wg.preDispatchRevalidate({ idemKey: expKey, fields: baseFields({ validUntil: tValid }), now: tLate })
    assert(!revE.ok && revE.reason === 'receipt-expired', '排队期间凭据过期,派发点复验 → receipt-expired(零供应商写,重新报价+确认)')
    wg.rejectIntentBeforeDispatch({ idemKey: expKey, reason: 'receipt-expired' })
    assert((wg.getIntent(expKey) as Record<string, unknown>)['dispatch_status'] === 'rejected', '过期效果置 rejected 终态(永不回 queued)')

    // (d) 复验健康路径 + unknown 口径
    const h = fullFlow(wg, ledger, 'wg:reval-ok')
    wg.claimForDispatch({ idemKey: 'wg:reval-ok', claimedBy: 'w2', leaseUntil: new Date(Date.now() + 60000).toISOString() })
    const revH = wg.preDispatchRevalidate({ idemKey: 'wg:reval-ok', fields: h.fields })
    assert(revH.ok, '授权/有效期/不可变指纹/无撤回 → 复验通过')
    const unk = wg.markIntentUnknown({ idemKey: 'wg:reval-ok', reason: 'supplier-timeout' })
    assert(unk.ok, '崩溃/超时 → unknown 记账')
    const ui = wg.getIntent('wg:reval-ok') as Record<string, unknown>
    assert(ui['dispatch_status'] === 'dispatching' && ui['next_action'] === 'query', 'unknown:dispatching 保持(不回 queued),next_action=query(只许查询/人工对账)')
    const blindRetry = wg.claimForDispatch({ idemKey: 'wg:reval-ok', claimedBy: 'w3', leaseUntil: new Date(Date.now() + 60000).toISOString() })
    assert(!blindRetry.ok, 'unknown 期间盲目重试领取 → 拒绝(禁止盲目重试)')

    // (e) 撤回在消费前(actor 级):已发行 receipt 的消费被拒,零 outbox
    const b = flowToReceipt(wg, ledger, 'wg:rev-consume', { actorRef: 'actor:revoke-me' })
    wg.revokeAuthority({ actorRef: 'actor:revoke-me', reason: 'actor revoked' })
    const consumeRevoked = wg.consumeApprovalAndEnqueue({ receiptId: b.receiptId, idemKey: 'wg:rev-consume', fields: b.fields, effectName: 'hotel-book' })
    assert(!consumeRevoked.ok && consumeRevoked.reason === 'authority-revoked', '撤回在消费前 → authority-revoked(零 outbox)')
    assert((wg.getIntent('wg:rev-consume') ?? null) === null, '撤回消费路径零 outbox 行')
    const claimRow = wg.getClaim(b.receiptId) as Record<string, unknown>
    assert(claimRow['consumed_at'] === null, '被撤回的发行记录保持未消费')

    // (f) 撤回在发行前(seam 级,封闭集内唯一名;放最后——撤回后该 seam 不可再发行)
    wg.revokeAuthority({ seam: 'hotelbyte-hotel-book-confirm', reason: 'L4 policy revoked' })
    ledger.requestPendingWrite({ idemKey: 'wg:rev-issue', seam: baseFields().seam, payload: {} })
    const issuePrep = wg.preparePresentation({ idemKey: 'wg:rev-issue', fields: baseFields(), expiresAt: new Date(Date.now() + 600_000).toISOString() })
    assert(issuePrep.ok, '撤回不拦呈现前备妥(备妥 ≠ 授权)')
    if (issuePrep.ok) {
      const issueConf = wg.trustedHostConfirm({ challengeId: issuePrep.card.challenge_id, deliveryNonce: issuePrep.trustedDelivery.deliveryNonce, actorRef: baseFields().actorRef, seam: baseFields().seam })
      assert(!issueConf.ok && issueConf.reason === 'authority-revoked', '撤回后可信确认 → authority-revoked(不发行 receipt)')
      const issuedRows = (ledger.db.prepare("SELECT COUNT(*) AS n FROM approval_claims WHERE idem_key = 'wg:rev-issue'").get() as { n: number }).n
      assert(issuedRows === 0, '撤回后零发行记录')
      assert((wg.getIntent('wg:rev-issue') ?? null) === null, '撤回后零 outbox 行')
    }
  }
} finally {
  rmSync(root2, { recursive: true, force: true })
}

// ---- 7:崩溃注入 + 崩溃后重启恢复(隔离账本 #3;本块会关闭连接) ------------------------

const root3 = mkdtempSync(join(tmpdir(), 'gotry-write-gate-crash-'))
try {
  const ledger = ensureLedger(root3)
  const wg = new WriteGate(ledger)
  console.log('  -- 7 崩溃注入:事务1 三崩溃点全有或全无;恢复后重放恰一次;重启后 durable 领取恰一次')
  const crashCase = (key: string, label: string, triggerBody: string): void => {
    const f = baseFields()
    ledger.requestPendingWrite({ idemKey: key, seam: f.seam, payload: {} })
    const prep = wg.preparePresentation({ idemKey: key, fields: f, expiresAt: new Date(Date.now() + 600_000).toISOString() })
    if (!prep.ok) throw new Error('prepare ' + prep.reason)
    const conf = wg.trustedHostConfirm({ challengeId: prep.card.challenge_id, deliveryNonce: prep.trustedDelivery.deliveryNonce, actorRef: f.actorRef, seam: f.seam })
    if (!conf.ok) throw new Error('confirm ' + conf.reason)
    ledger.db.exec(`DROP TRIGGER IF EXISTS crash_inject`)
    ledger.db.exec(`CREATE TRIGGER crash_inject ${triggerBody}`)
    let threw = false
    try {
      wg.consumeApprovalAndEnqueue({ receiptId: conf.receiptId, idemKey: key, fields: f, effectName: 'hotel-book' })
    } catch {
      threw = true
    }
    ledger.db.exec(`DROP TRIGGER IF EXISTS crash_inject`)
    assert(threw, `[${label}] 消费事务被注入 ABORT 中断`)
    const claim = ledger.db.prepare(`SELECT consumed_at FROM approval_claims WHERE tenant_id = 'local' AND receipt_id = ?`).get(conf.receiptId) as { consumed_at: string | null }
    const pending = ledger.listPendingWrites().find(w => w.idem_key === key)
    const intent = wg.getIntent(key)
    const confirmedEv = ledger.readEvents('write.confirmed', 100).filter(e => e.subject_id === key)
    assert(claim.consumed_at === null && pending?.status === 'pending' && intent === undefined && confirmedEv.length === 0,
      `[${label}] 崩溃后零残留:claim 未消费 / pending 未转移 / outbox 零行 / 零 write.confirmed(全有或全无)`)
    const retry = wg.consumeApprovalAndEnqueue({ receiptId: conf.receiptId, idemKey: key, fields: f, effectName: 'hotel-book' })
    assert(retry.ok, `[${label}] 恢复后重放恰一次成功`)
    const after = wg.getIntent(key) as Record<string, unknown>
    assert(after !== undefined && after['dispatch_status'] === 'queued', `[${label}] 重放后 outbox 恰一行 queued(不重复入队)`)
  }
  crashCase('wg:crash-a', 'claim 消费点', `BEFORE UPDATE OF consumed_at ON approval_claims WHEN NEW.consumed_at IS NOT NULL AND NEW.tenant_id = 'local' BEGIN SELECT RAISE(ABORT, 'injected crash at claim consumption'); END`)
  crashCase('wg:crash-b', 'pending 转移点', `BEFORE UPDATE OF status ON pending_writes WHEN NEW.status = 'confirmed' AND NEW.tenant_id = 'local' BEGIN SELECT RAISE(ABORT, 'injected crash at pending transition'); END`)
  crashCase('wg:crash-c', 'outbox 写入点', `BEFORE INSERT ON write_effect_intents WHEN NEW.tenant_id = 'local' BEGIN SELECT RAISE(ABORT, 'injected crash at outbox append'); END`)

  // 崩溃后重启恢复:全部连接关闭重开(durable 语义)——intent 仍在,领取恰一次
  ledger.close()
  const ledgerRe = ensureLedger(root3)
  const wgRe = new WriteGate(ledgerRe)
  const dur = wgRe.claimForDispatch({ idemKey: 'wg:crash-c', claimedBy: 'recovered-worker', leaseUntil: new Date(Date.now() + 60000).toISOString() })
  assert(dur.ok, '崩溃→重启(重开 DB)后 queued intent 可恢复领取(durable outbox)')
  const dur2 = wgRe.claimForDispatch({ idemKey: 'wg:crash-c', claimedBy: 'second-worker', leaseUntil: new Date(Date.now() + 60000).toISOString() })
  assert(!dur2.ok && dur2.reason === 'not-claimable', '恢复后第二 worker 领取 → not-claimable(不可重复派发)')
  ledgerRe.close()
} finally {
  rmSync(root3, { recursive: true, force: true })
}

console.log(`\nWRITE GATE TESTS: ${pass} ok, ${fail} fail`)
if (fail > 0) process.exit(1)
