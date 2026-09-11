/**
 * HotelByte 假 CLI spawn 级完整链路 E2E(issue #232 验收 §5;全离线 fixture,零真实供应商调用):
 * 本地假 hbcli 二进制(shell fixture,经真实 child_process spawn)跑通
 * quote(check-avail)→ approval(L3 receipt digest)→ book(trade book)→ unknown(enterUnknown)
 * → query-orders(advanceReconciliation)完整链,证明纯函数契约(hotelbyte-transaction.ts)
 * 在真实子进程边界上成立。时间轴为模拟常量;进程边界(exit/signal/timeout/stdout)是真实 spawn 产物。
 *
 * 场景×结果矩阵(每行先红后绿:同一次 spawn 的真实输出,先喂「无对账层的裸调用」证明会处理错,
 * 再走契约全链证明终态正确):
 *   1. quote 面:check-avail 真实 spawn 返回 session/ratePkgId/金额/币种/条款/有效期——book 前绑定钉死(验收 §2)
 *   2. 裸调用红基线:exit0 即成功/非零即失败/查无即无订单——timeout 被当失败(会盲目重订→双订风险)、
 *      exit0 垃圾/无绑定/部分确认被当成功、窗口内 miss 被当无订单——全部证伪(红)
 *   3. golden 链:book exit0+success 且 customerReferenceNo/ratePkgId 经 argv 回传一致 → binding_verified,不进对账
 *   4. timeout→miss→迟到成功(验收 §4 组合):30s abort→unknown→窗口内 miss 保 unknown 不重订→窗口外
 *      查到 confirmed→reconciled_success(迟到成功收敛,不重订)
 *   5. timeout→miss→迟到自动取消(验收 §4 组合):unknown→miss→auto_canceled→reconciled_failed
 *      (权威负证据,唯一允许新 intent 路径)
 *   6. exit0+非 JSON 垃圾→unknown(坏响应不可当成功)→查单 confirmed→reconciled_success
 *   7. exit0+success 无绑定参考号→unknown(不可归因)→查单 confirmed→reconciled_success
 *   8. 部分确认(pending)→unknown→非终态 processing 保 unknown→窗口届满 miss→转人工
 *      (时间届满本身不是无订单证明,不重订不允许新 intent)
 *   9. 进程被杀(kill -9)→unknown(副作用不可判定)
 *   10. 同 ref 多单→显式 conflict+manual_reconcile,不静默当成功也不丢弃
 *   11. 查单探针失败面:查询 crash→query_failed/垃圾→malformed(均保 unknown:探针失败不证明订单不存在);
 *       permission_denied→转人工
 *   12. 显式业务失败(exit3+{"status":"failed"})→supplier_failed(唯一非 unknown 失败分类,对比裸调用此例碰巧同判)
 *
 * 红线(结构性保证):唯一被执行的可执行文件是 mkdtemp 下的本地 fixture 脚本;
 * 套件零 PATH 上的 hbcli 解析、零网络、零凭据;GOTRY_HBCLI_LIVE 不参与、置 1 也不改变本套件行为;
 * 所有 spawn 带有界超时(hang 场景 500ms 内 SIGKILL 收敛)。
 *
 * 运行: cd ts && npx tsx scripts/hotelbyte-spawn-e2e-tests.ts
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

// ── 时间轴(模拟常量;窗口 = 180s Phase1 + ≤600s Phase2) ─────────────────────
const T0 = '2026-09-11T10:00:00.000Z'
const WINDOW_END = recoveryWindowEndsAt(T0)
const IN_WINDOW = '2026-09-11T10:00:30.000Z' // T0+30s:Phase1 内
const PAST_WINDOW = '2026-09-11T10:20:00.000Z' // T0+20min:780s 窗口外

// ── 链路固定绑定键(不可变 attempt;全程同一 ref) ────────────────────────────
const REF = 'REF-GOTRY-E2E-0001'
const ATTEMPT_ID = 'att-e2e-0001'
const RATE_PKG = 'pkg-e2e-42'

function seedBase(): Parameters<typeof enterUnknown>[0] {
  return {
    attemptId: ATTEMPT_ID,
    customerReferenceNo: REF,
    intentIdemKey: 'idem-e2e-0001',
    requestFingerprintSha256: 'e'.repeat(64),
    enteredUnknownAt: T0,
    recoveryWindowEndsAt: WINDOW_END,
    factId: 'fact_hotel_e2e',
    approvalReceiptDigest: undefined, // 各场景 book 前由 approval 面填入
    outboxIntentRef: 'outbox-intent-e2e-01',
  }
}

// ── 假 CLI fixture:单脚本,行为由环境变量编程,argv 形态对齐 staicli 0.0.3 ────
const FAKE_CLI = `#!/bin/sh
# 本地假 hbcli(spawn 级 E2E fixture;零真实供应商接触):行为由 FAKE_* 环境变量编程。
cmd="$1 $2"
read_flag() {
  flag="$1"; shift
  prev=""
  for a in "$@"; do
    [ "$prev" = "$flag" ] && printf '%s' "$a"
    prev="$a"
  done
}
case "$cmd" in
  "search check-avail")
    printf '{"session":"sess-fixture-01","ratePkgId":"%s","totalAmount":1280,"currency":"CNY","terms":"non-refundable","validUntil":"2026-09-11T10:05:00Z"}' "$FAKE_RATE_PKG_ID"
    ;;
  "trade book")
    ref=$(read_flag --customer-reference-no "$@")
    pkg=$(read_flag --rate-pkg-id "$@")
    case "$FAKE_BOOK_MODE" in
      ok)      printf '{"status":"success","customerReferenceNo":"%s","ratePkgId":"%s","orderRef":"HB-ORD-77"}' "$ref" "$pkg" ;;
      hang)    echo 'waiting on supplier...' >&2; while :; do sleep 1; done ;;
      garbage) printf 'HTTP/1.1 200 OK\\n<html>your booking maybe succeeded?</html>' ;;
      pending) printf '{"status":"pending","customerReferenceNo":"%s","orderRef":"HB-ORD-88"}' "$ref" ;;
      unbound) printf '{"status":"success","orderRef":"HB-ORD-99"}' ;;
      suicide) kill -9 $$ ;;
      bizfail) printf '{"status":"failed","reason":"inventory_gone","customerReferenceNo":"%s"}' "$ref"; exit 3 ;;
      crash)   echo 'kaboom' >&2; exit 2 ;;
      *)       echo "unknown FAKE_BOOK_MODE=$FAKE_BOOK_MODE" >&2; exit 64 ;;
    esac
    ;;
  "trade query-orders")
    ref=$(read_flag --customer-reference-no "$@")
    case "$FAKE_QUERY_MODE" in
      miss)             printf '{"orders":[]}' ;;
      hit-confirmed)    printf '{"orders":[{"customerReferenceNo":"%s","orderRef":"HB-ORD-77","supplierStatus":"confirmed"}]}' "$ref" ;;
      hit-auto-canceled) printf '{"orders":[{"customerReferenceNo":"%s","orderRef":"HB-ORD-77","supplierStatus":"auto_canceled"}]}' "$ref" ;;
      hit-processing)   printf '{"orders":[{"customerReferenceNo":"%s","orderRef":"HB-ORD-77","supplierStatus":"processing"}]}' "$ref" ;;
      multi)            printf '{"orders":[{"customerReferenceNo":"%s","orderRef":"HB-ORD-A","supplierStatus":"confirmed"},{"customerReferenceNo":"%s","orderRef":"HB-ORD-B","supplierStatus":"confirmed"}]}' "$ref" "$ref" ;;
      denied)           printf '{"error":"permission_denied"}' ;;
      crash)            echo 'query transport down' >&2; exit 4 ;;
      garbage)          printf '<<<not json at all>>>' ;;
      *)                echo "unknown FAKE_QUERY_MODE=$FAKE_QUERY_MODE" >&2; exit 64 ;;
    esac
    ;;
  *)
    echo "error: unknown command '$1 $2'" >&2
    exit 1
    ;;
esac
`

// ── 真实 spawn 驱动:有界超时,超时即 SIGKILL;收集 exit/signal/stdout/stderr ──
interface SpawnOutcome {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  stdout: string
  stderr: string
  latencyMs: number
}

async function runFake(
  bin: string,
  args: string[],
  envVars: Record<string, string>,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const started = Date.now()
    const child = spawn(bin, args, { env: { ...process.env, ...envVars } })
    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true
        child.kill('SIGKILL')
      }
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        stdout,
        stderr,
        latencyMs: Date.now() - started,
      })
    })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`fixture spawn 失败(测试自身缺陷,非场景):${e.message}`))
    })
  })
}

function toBookExecutionResult(o: SpawnOutcome): BookExecutionResult {
  return { exitCode: o.exitCode, signal: o.signal, timedOut: o.timedOut, stdout: o.stdout, stderr: o.stderr }
}

/** 查单 spawn → 授权查询面探针映射(exit≠0/超时/被杀=探针自身失败;探针失败≠订单不存在)。 */
function probeFromQuerySpawn(o: SpawnOutcome): QueryOrdersProbe {
  if (o.timedOut) return { kind: 'query_failed', reason: `query timeout(${o.latencyMs}ms abort;探针失败≠订单不存在)` }
  if (o.signal) return { kind: 'query_failed', reason: `query process killed:${o.signal}(探针失败≠订单不存在)` }
  if (o.exitCode !== 0) {
    return { kind: 'query_failed', reason: `exit ${o.exitCode}:${o.stderr.trim().slice(0, 120)}` }
  }
  const start = o.stdout.search(/[{[]/)
  if (start < 0) return { kind: 'malformed', reason: 'no-json-marker' }
  let parsed: unknown
  try {
    parsed = JSON.parse(o.stdout.slice(start))
  } catch (e) {
    return { kind: 'malformed', reason: `unparseable:${(e as Error).message.slice(0, 80)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'malformed', reason: 'non-object-json' }
  }
  const body = parsed as Record<string, unknown>
  if (body['error'] === 'permission_denied') return { kind: 'permission_denied' }
  if (!Array.isArray(body['orders'])) return { kind: 'malformed', reason: 'orders field missing' }
  const orders: Array<{ customerReferenceNo: string; orderRef: string; supplierStatus: string }> = []
  for (const raw of body['orders']) {
    const x = raw as Record<string, unknown>
    if (
      x === null || typeof x !== 'object' ||
      typeof x['customerReferenceNo'] !== 'string' ||
      typeof x['orderRef'] !== 'string' ||
      typeof x['supplierStatus'] !== 'string'
    ) {
      return { kind: 'malformed', reason: 'order entry shape' }
    }
    orders.push({ customerReferenceNo: x['customerReferenceNo'], orderRef: x['orderRef'], supplierStatus: x['supplierStatus'] })
  }
  return orders.length === 0 ? { kind: 'miss' } : { kind: 'hit', orders }
}

// ── 裸调用基线(红):无对账层时,一个「exit0 即成功/非零即失败」的天真接线 ────
type NaiveVerdict = 'success' | 'failed'
function naiveBareBook(o: SpawnOutcome): NaiveVerdict {
  return o.exitCode === 0 ? 'success' : 'failed'
}
function naiveBareQueryAllowsRebook(o: SpawnOutcome): boolean {
  // 天真接线:查无订单 → 判「无订单」→ 允许立即重订(这正是要证伪的危险行为)
  return probeLikeOrders(o).length === 0
}
function probeLikeOrders(o: SpawnOutcome): Array<Record<string, unknown>> {
  try {
    const start = o.stdout.search(/[{[]/)
    if (start < 0) return []
    const parsed: unknown = JSON.parse(o.stdout.slice(start))
    const orders = (parsed as { orders?: unknown } | null)?.orders
    return Array.isArray(orders) ? orders as Array<Record<string, unknown>> : []
  } catch {
    return []
  }
}

const tmp = await mkdtemp(join(tmpdir(), 'hb-spawn-e2e-'))
try {
  const fakeBin = join(tmp, 'hbfake')
  await writeFile(fakeBin, FAKE_CLI, { mode: 0o755 })
  await chmod(fakeBin, 0o755)
  assert.ok(fakeBin.startsWith(tmpdir()), '红线自检:唯一可执行文件在临时目录(零 PATH 解析,零真实 hbcli)')

  // book 复用参数:绑定 ref 与 rate-pkg 经真实 argv 进子进程(回传断言即 spawn 边界证明)
  const bookArgs = ['trade', 'book', '--json', '--rate-pkg-id', RATE_PKG, '--customer-reference-no', REF]
  async function bookSpawn(mode: string, args: string[] = bookArgs, timeoutMs = 2000): Promise<SpawnOutcome> {
    return runFake(fakeBin, args, { FAKE_BOOK_MODE: mode, FAKE_RATE_PKG_ID: RATE_PKG }, timeoutMs)
  }
  async function querySpawn(mode: string): Promise<SpawnOutcome> {
    return runFake(
      fakeBin,
      ['trade', 'query-orders', '--json', '--customer-reference-no', REF],
      { FAKE_QUERY_MODE: mode },
      2000,
    )
  }

  // ── 1. quote 面:check-avail 真实 spawn,book 前绑定钉死(验收 §2) ──────────
  const quoteOutcome = await runFake(
    fakeBin,
    ['search', 'check-avail', '--json', '--rate-pkg-id', RATE_PKG],
    { FAKE_RATE_PKG_ID: RATE_PKG },
    2000,
  )
  assert.equal(quoteOutcome.exitCode, 0, 'quote spawn exit0')
  assert.equal(quoteOutcome.timedOut, false, 'quote spawn 不超时')
  const quote = JSON.parse(quoteOutcome.stdout) as Record<string, unknown>
  for (const field of ['session', 'ratePkgId', 'totalAmount', 'currency', 'terms', 'validUntil'] as const) {
    const v = quote[field]
    assert.ok(v !== undefined && v !== null && String(v).length > 0, `quote 绑定字段 ${field} 必须在场(验收 §2)`)
  }
  assert.equal(quote['ratePkgId'], RATE_PKG, 'quote 绑定本 attempt 的 ratePkg')
  assert.equal(quote['currency'], 'CNY', '币种在场')
  // approval 面:L3 receipt 只携摘要(sha256),不落敏感原值
  const quoteSnapshotDigest = createHash('sha256').update(quoteOutcome.stdout).digest('hex')
  const approvalReceiptDigest = createHash('sha256')
    .update(JSON.stringify({ seam: 'hotelbyte.book.v1', quoteSnapshotDigest, approver: 'L3-fixture-approval', approvedAt: T0 }))
    .digest('hex')
  assert.match(approvalReceiptDigest, /^[0-9a-f]{64}$/, '审批 receipt 为 sha256 摘要')
  console.log('1. quote 面(真实 spawn:session/rate/金额币种/条款/有效期绑定)+ L3 审批摘要 OK')

  // ── 2. 裸调用红基线:同批真实 spawn 输出,证明无对账层的天真接线会处理错 ────
  const redTimeout = await bookSpawn('hang', bookArgs, 500)
  assert.equal(redTimeout.timedOut, true, 'hang 场景被 500ms 有界超时 SIGKILL 收敛')
  assert.equal(naiveBareBook(redTimeout), 'failed', '红:timeout 被裸调用判 failed(会盲目重订→双订风险)')
  const redGarbage = await bookSpawn('garbage')
  assert.equal(naiveBareBook(redGarbage), 'success', '红:exit0+非 JSON 垃圾被裸调用判 success')
  const redUnbound = await bookSpawn('unbound')
  assert.equal(naiveBareBook(redUnbound), 'success', '红:exit0+无绑定成功被裸调用判 success(不可归因也当成了成功)')
  const redPending = await bookSpawn('pending')
  assert.equal(naiveBareBook(redPending), 'success', '红:exit0+部分确认(pending)被裸调用判 success')
  const redCrash = await bookSpawn('crash')
  assert.equal(naiveBareBook(redCrash), 'failed', '红:非零退码且无业务结论被裸调用判 failed(实际副作用不可判定)')
  const redMiss = await querySpawn('miss')
  assert.equal(naiveBareQueryAllowsRebook(redMiss), true, '红:窗口内 miss 被裸调用判「无订单可重订」(供应商可能迟到建单)')
  console.log('2. 裸调用红基线(6 个真实 spawn 输出全被天真接线处理错)OK')

  // ── 3. golden 链:quote→approval→book(exit0+success,argv 回传绑定一致) ────
  const goldenOutcome = await bookSpawn('ok')
  assert.equal(goldenOutcome.exitCode, 0)
  const goldenPayload = JSON.parse(goldenOutcome.stdout) as Record<string, unknown>
  assert.equal(goldenPayload['customerReferenceNo'], REF, 'customerReferenceNo 经真实 argv 进子进程并回传(spawn 边界绑定证明)')
  assert.equal(goldenPayload['ratePkgId'], RATE_PKG, 'ratePkgId 与 quote 绑定一致(quote→book 链未断)')
  const goldenCls = classifyBookExecution(toBookExecutionResult(goldenOutcome), REF)
  assert.deepEqual(goldenCls, { kind: 'binding_verified', customerReferenceNo: REF, payload: goldenPayload }, 'golden → binding_verified')
  console.log('3. golden 链(ref/ratePkg argv 回传一致 → binding_verified,不进对账)OK')

  // ── 4. timeout→miss→迟到成功(验收 §4 组合一) ──────────────────────────────
  const s4book = await bookSpawn('hang', bookArgs, 500)
  const s4cls = classifyBookExecution(toBookExecutionResult(s4book), REF)
  assert.equal(s4cls.kind, 'unknown', 'timeout → unknown(CLI abort ≠ 后端停止)')
  assert.match(s4cls.reason, /timeout/)
  let s4: ReconciliationState = enterUnknown({ ...seedBase(), approvalReceiptDigest })
  assert.equal(s4.nextAction, 'keep_querying', '进 unknown 即禁止盲目重试/重订')
  const s4miss = advanceReconciliation(s4, probeFromQuerySpawn(await querySpawn('miss')), IN_WINDOW)
  assert.equal(s4miss.status, 'unknown', '窗口内 miss → 保持 unknown')
  assert.equal(s4miss.nextAction, 'keep_querying', '窗口内 miss → 继续查,结构性禁止重订')
  assert.equal(newIntentAllowed(s4miss), false, 'unknown 期间禁止新 intent')
  s4 = s4miss
  const s4hit = advanceReconciliation(s4, probeFromQuerySpawn(await querySpawn('hit-confirmed')), PAST_WINDOW)
  assert.equal(s4hit.status, 'reconciled_success', '迟到成功(窗口外查到 confirmed)→ reconciled_success,不重订')
  assert.equal(newIntentAllowed(s4hit), false, '订单已成立 → 不允许同请求新 intent')
  assert.ok(s4hit.history.some((e) => e.action === 'query_miss_within_window'), '窗口内 miss 进审计链')
  assert.ok(s4hit.history.some((e) => e.action === 'supplier_terminal_success'), '迟到收敛进审计链')
  const s4hitOrders = probeFromQuerySpawn(await querySpawn('hit-confirmed'))
  assert.ok(s4hitOrders.kind === 'hit' && s4hitOrders.orders.every((o) => o.customerReferenceNo === REF), '查单确实按本 attempt 的 ref 查(argv 回传)')
  console.log('4. timeout→miss→迟到成功(unknown 全程不重订,收敛 reconciled_success)OK')

  // ── 5. timeout→miss→迟到自动取消(验收 §4 组合二) ──────────────────────────
  const s5book = await bookSpawn('hang', bookArgs, 500)
  assert.equal(classifyBookExecution(toBookExecutionResult(s5book), REF).kind, 'unknown')
  const s5unknown = enterUnknown({ ...seedBase(), approvalReceiptDigest })
  const s5miss = advanceReconciliation(s5unknown, probeFromQuerySpawn(await querySpawn('miss')), IN_WINDOW)
  assert.equal(s5miss.status, 'unknown', '窗口内 miss 保 unknown')
  const s5cancel = advanceReconciliation(s5miss, probeFromQuerySpawn(await querySpawn('hit-auto-canceled')), IN_WINDOW)
  assert.equal(s5cancel.status, 'reconciled_failed', '迟到自动取消按供应商回执收敛 reconciled_failed')
  assert.equal(newIntentAllowed(s5cancel), true, '绑定 attempt 的权威负证据 → 唯一允许新 intent 路径')
  assert.ok(s5cancel.history.every((e) => e.probeDigest.length === 64), '审计链带 probeDigest')
  console.log('5. timeout→miss→迟到自动取消(收敛 reconciled_failed,允许新 intent)OK')

  // ── 6. exit0+非 JSON 垃圾→unknown→查单收敛 ─────────────────────────────────
  const s6book = await bookSpawn('garbage')
  const s6cls = classifyBookExecution(toBookExecutionResult(s6book), REF)
  assert.equal(s6cls.kind, 'unknown', '坏响应不可当成功')
  assert.match(s6cls.reason, /exit0_non_json/)
  const s6hit = advanceReconciliation(
    enterUnknown({ ...seedBase(), approvalReceiptDigest }),
    probeFromQuerySpawn(await querySpawn('hit-confirmed')),
    IN_WINDOW,
  )
  assert.equal(s6hit.status, 'reconciled_success', '垃圾响应场景经查单收敛 reconciled_success')
  console.log('6. exit0 垃圾→unknown(不假成功)→查单收敛 OK')

  // ── 7. exit0+success 无绑定参考号→unknown→查单收敛 ─────────────────────────
  const s7book = await bookSpawn('unbound')
  const s7cls = classifyBookExecution(toBookExecutionResult(s7book), REF)
  assert.equal(s7cls.kind, 'unknown', '无绑定成功不可归因')
  assert.match(s7cls.reason, /missing_reference/)
  const s7hit = advanceReconciliation(
    enterUnknown({ ...seedBase(), approvalReceiptDigest }),
    probeFromQuerySpawn(await querySpawn('hit-confirmed')),
    IN_WINDOW,
  )
  assert.equal(s7hit.status, 'reconciled_success', '无绑定场景经查单按 ref 归因收敛')
  console.log('7. exit0 无绑定成功→unknown→查单归因收敛 OK')

  // ── 8. 部分确认(pending)→非终态→窗口届满 miss→转人工(不重订) ─────────────
  const s8book = await bookSpawn('pending')
  const s8cls = classifyBookExecution(toBookExecutionResult(s8book), REF)
  assert.equal(s8cls.kind, 'unknown', '部分确认 ≠ 成功')
  assert.match(s8cls.reason, /partial_or_indeterminate/)
  let s8: ReconciliationState = enterUnknown({ ...seedBase(), approvalReceiptDigest })
  const s8processing = advanceReconciliation(s8, probeFromQuerySpawn(await querySpawn('hit-processing')), IN_WINDOW)
  assert.equal(s8processing.status, 'unknown', '订单存在但非终态 → 保持 unknown')
  assert.equal(s8processing.nextAction, 'keep_querying', '非终态 → 继续查单')
  s8 = s8processing
  const s8expired = advanceReconciliation(s8, probeFromQuerySpawn(await querySpawn('miss')), PAST_WINDOW)
  assert.equal(s8expired.status, 'unknown', '窗口届满 miss → 仍 unknown(时间届满不是无订单证明)')
  assert.equal(s8expired.nextAction, 'manual_reconcile', '窗口届满 → 转人工对账')
  assert.equal(newIntentAllowed(s8expired), false, '届满不自动允许新 intent(不重订)')
  console.log('8. pending→processing→窗口届满转人工(仍 unknown,不重订)OK')

  // ── 9. 进程被杀(kill -9)→unknown(副作用不可判定) ─────────────────────────
  const s9book = await bookSpawn('suicide')
  assert.equal(s9book.exitCode, null, '被杀进程无退码')
  assert.equal(s9book.signal, 'SIGKILL', '真实 spawn 捕获 SIGKILL')
  const s9cls = classifyBookExecution(toBookExecutionResult(s9book), REF)
  assert.equal(s9cls.kind, 'unknown', '被杀 → unknown')
  assert.match(s9cls.reason, /process_killed/)
  const s9unknown = enterUnknown({ ...seedBase(), approvalReceiptDigest })
  assert.equal(s9unknown.status, 'unknown', '被杀场景进显式对账')
  console.log('9. 进程被杀(SIGKILL 真实捕获)→unknown OK')

  // ── 10. 同 ref 多单→显式 conflict+manual_reconcile ─────────────────────────
  const s10multi = advanceReconciliation(
    enterUnknown({ ...seedBase(), approvalReceiptDigest }),
    probeFromQuerySpawn(await querySpawn('multi')),
    IN_WINDOW,
  )
  assert.equal(s10multi.status, 'unknown', '多单不静默当成功')
  assert.equal(s10multi.nextAction, 'manual_reconcile', '多单冲突 → 人工对账')
  assert.equal(s10multi.conflict, true, '冲突显式标记')
  assert.equal(newIntentAllowed(s10multi), false, '冲突未解 → 冻结新 intent')
  console.log('10. 同 ref 多单(真实查询返回 2 笔)→显式冲突交人工 OK')

  // ── 11. 查单探针失败面:crash/garbage/denied(探针失败≠订单不存在) ──────────
  const s11unknown = enterUnknown({ ...seedBase(), approvalReceiptDigest })
  const s11crash = advanceReconciliation(s11unknown, probeFromQuerySpawn(await querySpawn('crash')), IN_WINDOW)
  assert.equal(s11crash.status, 'unknown', '查询 crash → 探针失败,保持 unknown')
  assert.equal(s11crash.nextAction, 'keep_querying', '查询失败 → 继续查')
  const s11garbage = advanceReconciliation(s11crash, probeFromQuerySpawn(await querySpawn('garbage')), IN_WINDOW)
  assert.equal(s11garbage.status, 'unknown', '查询垃圾输出 → malformed,不静默当 miss')
  const s11denied = advanceReconciliation(s11garbage, probeFromQuerySpawn(await querySpawn('denied')), IN_WINDOW)
  assert.equal(s11denied.nextAction, 'manual_reconcile', 'permission_denied → 自助查单不可用,转人工')
  assert.equal(s11denied.status, 'unknown', 'permission_denied → 仍 unknown')
  console.log('11. 查单探针失败面(crash→query_failed/garbage→malformed/denied→人工)OK')

  // ── 12. 显式业务失败(exit3+{"status":"failed"})→supplier_failed ───────────
  const s12book = await bookSpawn('bizfail')
  assert.equal(s12book.exitCode, 3)
  const s12cls = classifyBookExecution(toBookExecutionResult(s12book), REF)
  assert.equal(s12cls.kind, 'supplier_failed', '带显式业务失败 payload 的非零退码 → supplier_failed')
  assert.ok(s12cls.kind === 'supplier_failed' && s12cls.payload !== null && (s12cls.payload as Record<string, unknown>)['reason'] === 'inventory_gone', 'payload 保留业务结论')
  console.log('12. 显式业务失败(exit3+failed payload)→supplier_failed OK')

  console.log('\nHOTELBYTE SPAWN E2E TESTS: 12/12 OK(假 CLI 经真实 spawn 跑通 quote→approval→book→unknown→query-orders 全链;裸调用红基线 6 证伪;timeout→miss→迟到成功/自动取消;垃圾/无绑定/部分确认不假成功;届满转人工;冲突显式;零真实 hbcli·网络·凭据)')
} finally {
  await rm(tmp, { recursive: true, force: true })
}
