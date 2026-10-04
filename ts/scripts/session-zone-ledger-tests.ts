/**
 * 会话双区记忆账本落点单测(P4-2,design/session-dual-zone-memory-design.md §5):
 *  - 六个 kind 以日志类事件落在**既有** events 表(零新表/零 schema 迁移);
 *  - 单事务{fold 读 rev;守门闸;INSERT}:stale_rev / 负面清单 / 闭集在插入前拒绝,零新行;
 *  - 同 rev 重放 = 物理 no-op(守门层 + UNIQUE 索引两道);drop→重捕获不被幂等键吞;
 *  - kill -9 中途 = 要么全有要么全无(真实子进程 SIGKILL,事务未提交即零行);
 *  - forget 物理硬删分区事件 + 恰一行审计;会话级多主体仍只一行审计;
 *  - 导出视图 == fold 输出(逐字节),且导出零新事件(视图永不是写路径);
 *  - 日志触读上界 → log_truncated fail-closed;坏行/伪造文档确定性跳过不投影;
 *  - 分区事件对既有投影零影响(日志类事件在 foldEvent default 分支无投影)。
 *
 * 全离线:mkdtemp 隔离 stateRoot(绝不碰 ts/dsh-runtime/gotry-state),零网络,
 * 零真实 LLM;子进程有界 timeout;临时目录在 finally 清理。
 * 运行:cd ts && npx tsx scripts/session-zone-ledger-tests.ts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLedger, openLedgerIfExists, type StateLedger } from '../src/state-ledger.ts'
import {
  HOT_ZONE_EVENT_KINDS,
  NOTEBOOK_ZONE_EVENT_KINDS,
  ZONE_EXPORT_HOT_FILE,
  ZONE_EXPORT_NOTEBOOK_FILE,
  appendZoneWrite,
  appendZoneWrites,
  forgetZoneSession,
  forgetZoneSubjects,
  readZoneExportViews,
  readZoneLog,
  renderZoneExportViews,
  type ZoneAppendResult,
} from '../src/session-zone-ledger.ts'
import { ZONE_EVENT_KINDS, foldZoneEvents, readWorkingZone, zoneIdemKey } from '../src/session-zones.ts'

let n = 0
function pass(name: string, body: () => void) {
  body()
  console.log(`  ${++n}. ${name} OK`)
}

const T0 = '2026-10-04T08:00:00.000Z'
const MIN = 60_000
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString()
const SESS_A = 'sess-zone-ledger-a'
const SESS_B = 'sess-zone-ledger-b'
const QUOTE = '我以后出门都不坐红眼航班'

const roots: string[] = []
function freshRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `gotry-zone-${tag}-`))
  roots.push(root)
  return root
}
function freshLedger(tag: string): { root: string; ledger: StateLedger } {
  const root = freshRoot(tag)
  return { root, ledger: ensureLedger(root) }
}

function captureReq(over: Partial<{ session_ref: string; tier: 'resource' | 'intent'; kind: 'destination' | 'price_band' | 'availability'; payload: Record<string, unknown>; turn: number; ts: string }> = {}) {
  const session_ref = over.session_ref ?? SESS_A
  return {
    op: 'capture' as const,
    input: {
      session_ref,
      tier: over.tier ?? ('intent' as const),
      kind: over.kind ?? ('destination' as const),
      payload: over.payload ?? { city: '大理' },
      evidence_ref: { session_ref, turn: over.turn ?? 1 },
      ts: over.ts ?? T0,
    },
  }
}

function ok(r: ZoneAppendResult): ZoneAppendResult & { ok: true } {
  assert.ok(r.ok, `写门必须接受:${JSON.stringify(r)}`)
  return r
}

function zoneEventCount(ledger: StateLedger): number {
  return ZONE_EVENT_KINDS.reduce((sum, k) => sum + ledger.readEvents(k, 10_000).length, 0)
}

try {
  // 1. 落账形状:事件 kind/subject/idem_key/actor + 读回 fold == 直读
  pass('六 kind 落既有 events 表:事件行形状 + readZoneLog fold == 直读投影', () => {
    const { ledger } = freshLedger('shape')
    const r = ok(appendZoneWrite(ledger, captureReq(), { actor: 'tool:gotry_session_zone_note' }))
    assert.equal(r.appended, true)
    const rows = ledger.readEvents('hotctx.note.captured', 10)
    assert.equal(rows.length, 1, '恰一行事件')
    const row = rows[0]!
    assert.equal(row.kind, 'hotctx.note.captured')
    assert.equal(row.actor, 'tool:gotry_session_zone_note')
    assert.equal(row.subject_id, r.event!.kind === 'hotctx.note.captured' ? r.event!.note.note_id : '')
    assert.equal(row.idem_key, zoneIdemKey(r.event!))
    assert.equal(row.ts, T0, '事件 ts 原样落账(drop 幂等键与 TTL 基点都依赖它)')
    const payload = JSON.parse(row.payload) as { note?: { zone?: string } }
    assert.equal(payload.note?.zone, 'hot_context', '全量文档随事件走(trip.logged 同形)')
    const read = readZoneLog(ledger)
    assert.equal(read.truncated, false)
    assert.equal(read.malformed, 0)
    assert.deepEqual(read.state, foldZoneEvents(read.events), '重建 == 直读')
    assert.equal(Object.keys(read.state.hot).length, 1)
    // 零新表:schema 仍只有既有表
    const tables = (ledger.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(t => t.name)
    assert.deepEqual(
      tables.filter(t => /zone|hot|notebook/i.test(t)),
      [],
      '零新表:分区不得引入任何专表',
    )
  })

  // 2. 同 rev 重放 = 物理 no-op
  pass('幂等:同 rev 同内容重放零新行(守门层 appended:false,countEvents 不变)', () => {
    const { ledger } = freshLedger('idem')
    ok(appendZoneWrite(ledger, captureReq()))
    const before = ledger.countEvents()
    const replay = ok(appendZoneWrite(ledger, captureReq()))
    assert.equal(replay.appended, false, '重放不得产生事件')
    assert.equal(ledger.countEvents(), before, '物理 no-op:事件总数不变')
    // 修订后重放修订(父 rev 旧值 + 同内容)同样是 no-op
    const noteId = Object.keys(readZoneLog(ledger).state.hot)[0]!
    ok(appendZoneWrite(ledger, { op: 'revise', input: { note_id: noteId, expected_rev: 1, payload: { city: '丽江' }, ts: at(10 * MIN) } }))
    const afterRevise = ledger.countEvents()
    const replayRevise = ok(appendZoneWrite(ledger, { op: 'revise', input: { note_id: noteId, expected_rev: 1, payload: { city: '丽江' }, ts: at(10 * MIN) } }))
    assert.equal(replayRevise.appended, false)
    assert.equal(ledger.countEvents(), afterRevise)
    assert.equal(readZoneLog(ledger).state.hot[noteId]!.rev, 2, '重放不得推进 rev')
  })

  // 3. UNIQUE 索引这一道:绕过守门的同语义事件也只落一行
  pass('幂等第二道:UNIQUE 索引让同幂等键的重复 INSERT 物理 no-op', () => {
    const { ledger } = freshLedger('unique')
    const r = ok(appendZoneWrite(ledger, captureReq()))
    const before = ledger.countEvents()
    const seq = ledger.insertEvent({
      actor: 'test:bypass',
      kind: 'hotctx.note.captured',
      subjectId: 'x',
      payload: { note: { forged: true } },
      idemKey: r.idemKey,
      ts: T0,
    })
    assert.equal(seq, null, '同幂等键的 INSERT 返回 null(物理 no-op)')
    assert.equal(ledger.countEvents(), before)
  })

  // 4. drop→重捕获在账本上真的复活(幂等键生代修复的回归锚)
  pass('drop→重捕获:同 id 同 rev 的新生命周期必须落账(不被幂等键吞)', () => {
    const { ledger } = freshLedger('relife')
    const first = ok(appendZoneWrite(ledger, captureReq()))
    const noteId = first.event!.kind === 'hotctx.note.captured' ? first.event!.note.note_id : ''
    ok(appendZoneWrite(ledger, { op: 'drop', note_id: noteId, ts: at(5 * MIN) }))
    assert.equal(Object.keys(readZoneLog(ledger).state.hot).length, 0, 'drop 后出状态')
    const reborn = ok(appendZoneWrite(ledger, captureReq({ ts: at(6 * MIN) })))
    assert.equal(reborn.appended, true, '更正后仍真:重捕获必须落账')
    const state = readZoneLog(ledger).state
    assert.equal(state.hot[noteId]!.created_at, at(6 * MIN), '新生命周期自新写入起算')
    assert.notEqual(reborn.idemKey, first.idemKey)
  })

  // 5. 插入前 fail-closed:stale_rev / 闭集 / 负面清单 / 未知主体,一律零新行
  pass('fail-closed:stale_rev / 负面清单 / 闭集 / 未知主体在 INSERT 前拒绝,账本零新行', () => {
    const { ledger } = freshLedger('failclosed')
    ok(appendZoneWrite(ledger, captureReq()))
    const noteId = Object.keys(readZoneLog(ledger).state.hot)[0]!
    const before = ledger.countEvents()
    const stale = appendZoneWrite(ledger, { op: 'revise', input: { note_id: noteId, expected_rev: 7, payload: { city: '香格里拉' }, ts: at(MIN) } })
    assert.ok(!stale.ok && stale.code === 'stale_rev', `应 stale_rev:${JSON.stringify(stale)}`)
    const neg = appendZoneWrite(ledger, captureReq({ payload: { city: '大理', note: '联系 13800138000' }, ts: at(2 * MIN) }))
    assert.ok(!neg.ok && neg.code === 'negative_list', `应 negative_list:${JSON.stringify(neg)}`)
    const url = appendZoneWrite(ledger, captureReq({ payload: { city: '大理', src: 'https://example.com/x' }, ts: at(3 * MIN) }))
    assert.ok(!url.ok && url.code === 'negative_list')
    const closed = appendZoneWrite(ledger, { op: 'capture', input: { ...captureReq().input, kind: 'nope' as never, ts: at(4 * MIN) } })
    assert.ok(!closed.ok && closed.code === 'closed_set')
    const unknown = appendZoneWrite(ledger, { op: 'drop', note_id: 'hn|nope', ts: at(5 * MIN) })
    assert.ok(!unknown.ok && unknown.code === 'unknown_subject')
    const noQuote = appendZoneWrite(ledger, { op: 'promote', input: { note_id: noteId, kind: 'preference', owner_confirm: { surface: 'user_reply', quote: '' }, ts: at(6 * MIN) } })
    assert.ok(!noQuote.ok && noQuote.code === 'owner_confirm', '缺 owner 引用的晋升必须拒收')
    assert.equal(ledger.countEvents(), before, '全部拒绝路径零新行(拒绝即回滚,账本无痕)')
  })

  // 6. 批量单事务:任一被拒 → 全批回滚
  pass('批量单事务:合法+非法混批 → 整批回滚,零新行', () => {
    const { ledger } = freshLedger('batch')
    const before = ledger.countEvents()
    const results = appendZoneWrites(ledger, [
      captureReq({ payload: { city: '清迈' } }),
      captureReq({ payload: { city: '清迈', phone: '13900139000' }, ts: at(MIN) }),
    ])
    assert.equal(results.length, 2)
    assert.ok(results[0]!.ok && results[0]!.appended, '首项在事务内被接受')
    assert.ok(!results[1]!.ok && results[1]!.code === 'negative_list')
    assert.equal(ledger.countEvents(), before, '全有或全无:首项也被回滚')
    assert.equal(Object.keys(readZoneLog(ledger).state.hot).length, 0)
    // 批内自洽:同事务链式 CAS 成立(第二项的父 rev 来自同事务内第一项的结果)
    ok(appendZoneWrite(ledger, captureReq({ payload: { city: '清迈' } })))
    const noteId = Object.keys(readZoneLog(ledger).state.hot)[0]!
    const chain = appendZoneWrites(ledger, [
      { op: 'revise', input: { note_id: noteId, expected_rev: 1, payload: { city: '拜县' }, ts: at(3 * MIN) } },
      { op: 'revise', input: { note_id: noteId, expected_rev: 2, payload: { city: '湄宏顺' }, ts: at(4 * MIN) } },
    ])
    assert.ok(chain.every(r => r.ok && r.appended), `同事务链式 CAS 应全部接受:${JSON.stringify(chain)}`)
    assert.equal(readZoneLog(ledger).state.hot[noteId]!.rev, 3)
  })

  // 7. kill -9:要么全有要么全无
  pass('崩溃注入:提交前 SIGKILL → 账本零分区事件;同两次追加正常提交 → 恰两行', () => {
    const crashRoot = freshRoot('crash')
    const crash = spawnSync('npx', ['tsx', 'scripts/session-zone-crash.ts', crashRoot, 'pre-commit'], {
      encoding: 'utf-8',
      timeout: 120_000,
    })
    // npx 外壳会把子进程的致命信号折算成 status 137(128+9);两种形态都算 kill -9
    assert.ok(
      crash.signal === 'SIGKILL' || crash.status === 137,
      `探针必须被 SIGKILL(signal=SIGKILL 或 status=137):${crash.status}/${crash.signal}/${crash.stderr?.slice(0, 300)}`,
    )
    assert.equal(crash.stdout?.includes('committed'), false, '崩溃路径不得走到提交后的输出')
    const crashed = openLedgerIfExists(crashRoot)
    assert.ok(crashed, '崩溃后账本文件应存在')
    assert.equal(zoneEventCount(crashed!), 0, '未提交事务:零分区事件(全无)')
    assert.equal(Object.keys(readZoneLog(crashed!).state.hot).length, 0)

    const okRoot = freshRoot('crash-ok')
    const good = spawnSync('npx', ['tsx', 'scripts/session-zone-crash.ts', okRoot, 'committed'], {
      encoding: 'utf-8',
      timeout: 120_000,
    })
    assert.equal(good.status, 0, `正常提交探针应 exit 0:${good.stderr?.slice(0, 300)}`)
    const committed = openLedgerIfExists(okRoot)!
    assert.equal(zoneEventCount(committed), 2, '正常提交:恰两行(全有)')
    assert.equal(Object.keys(readZoneLog(committed).state.hot).length, 2)
  })

  // 8. 晋升链 + 笔记本修订/删除全链落账
  pass('晋升→修订→移除全链落账:owner 引用随事件走,血缘保留', () => {
    const { ledger } = freshLedger('promote')
    ok(appendZoneWrite(ledger, captureReq()))
    const noteId = Object.keys(readZoneLog(ledger).state.hot)[0]!
    const promoted = ok(appendZoneWrite(ledger, {
      op: 'promote',
      input: { note_id: noteId, kind: 'preference', owner_confirm: { surface: 'user_reply', quote: QUOTE }, ts: at(MIN) },
    }))
    const entryId = promoted.event!.kind === 'notebook.entry.promoted' ? promoted.event!.entry.entry_id : ''
    const afterPromote = readZoneLog(ledger).state
    assert.equal(afterPromote.notebook[entryId]!.owner_confirm.quote, QUOTE)
    assert.deepEqual(afterPromote.notebook[entryId]!.origin, { session_ref: SESS_A, note_id: noteId }, '血缘保留')
    assert.ok(afterPromote.hot[noteId], '晋升不移除工作区笔记')
    ok(appendZoneWrite(ledger, {
      op: 'notebook_revise',
      input: { entry_id: entryId, expected_rev: 1, payload: { redeye: 'never', since: '2026' }, owner_confirm: { surface: 'approval_card', quote: QUOTE }, ts: at(2 * MIN) },
    }))
    assert.equal(readZoneLog(ledger).state.notebook[entryId]!.rev, 2)
    ok(appendZoneWrite(ledger, { op: 'notebook_drop', entry_id: entryId, ts: at(3 * MIN) }))
    assert.equal(readZoneLog(ledger).state.notebook[entryId], undefined, 'drop 后出状态')
    assert.equal(ledger.readEvents('notebook.entry.dropped', 10).length, 1, '审计行仍在事件日志')
  })

  // 9. forget:物理硬删 + 恰一行审计
  pass('forget 主体级:物理硬删该主体分区事件 + 恰一行审计;其他主体不受影响', () => {
    const { ledger } = freshLedger('forget')
    ok(appendZoneWrite(ledger, captureReq()))
    ok(appendZoneWrite(ledger, captureReq({ payload: { city: '清迈' }, ts: at(MIN) })))
    const ids = Object.keys(readZoneLog(ledger).state.hot).sort()
    const target = ids[0]!
    const auditBefore = ledger.readEvents('forget.executed', 100).length
    const r = forgetZoneSubjects(ledger, [{ zone: 'hot_context', id: target }])
    assert.equal(r.deleted, 1, '物理删除该主体的 1 条事件')
    const after = readZoneLog(ledger)
    assert.equal(after.state.hot[target], undefined, '被遗忘主体彻底消失')
    assert.equal(Object.keys(after.state.hot).length, 1, '其他主体不受影响')
    assert.equal(ledger.readEvents('forget.executed', 100).length, auditBefore + 1, '删除本身恰留一行审计')
    const audit = JSON.parse(ledger.readEvents('forget.executed', 1)[0]!.payload) as { subjects: Array<{ kinds: string[]; subjectId: string }> }
    assert.deepEqual(audit.subjects[0]!.kinds, [...HOT_ZONE_EVENT_KINDS], '审计行记录被删的 kind 集合')
  })

  pass('forget 会话级:多主体一次调用 → 仍恰一行审计;笔记本血缘同会话一并删除', () => {
    const { ledger } = freshLedger('forget-session')
    ok(appendZoneWrite(ledger, captureReq()))
    ok(appendZoneWrite(ledger, captureReq({ payload: { city: '清迈' }, ts: at(MIN) })))
    ok(appendZoneWrite(ledger, captureReq({ session_ref: SESS_B, payload: { city: '东京' }, ts: at(2 * MIN) })))
    const noteId = Object.keys(readZoneLog(ledger).state.hot).find(id => id.includes(SESS_A))!
    ok(appendZoneWrite(ledger, {
      op: 'promote',
      input: { note_id: noteId, kind: 'preference', owner_confirm: { surface: 'user_reply', quote: QUOTE }, ts: at(3 * MIN) },
    }))
    const auditBefore = ledger.readEvents('forget.executed', 100).length
    const r = forgetZoneSession(ledger, SESS_A)
    assert.ok(r.ok, JSON.stringify(r))
    assert.equal(r.subjects, 3, '2 条笔记 + 1 条笔记本条目')
    assert.equal(r.deleted, 3)
    assert.equal(ledger.readEvents('forget.executed', 100).length, auditBefore + 1, '多主体仍只一行审计')
    const sessionAudit = JSON.parse(ledger.readEvents('forget.executed', 1)[0]!.payload) as { subjects: Array<{ kinds: string[] }> }
    assert.ok(
      sessionAudit.subjects.some(s => s.kinds.join(',') === [...NOTEBOOK_ZONE_EVENT_KINDS].join(',')),
      '审计行覆盖笔记本三 kind',
    )
    const after = readZoneLog(ledger).state
    assert.equal(Object.keys(after.notebook).length, 0)
    assert.deepEqual(Object.values(after.hot).map(h => h.session_ref), [SESS_B], '另一会话不受影响')
    const nobody = forgetZoneSession(ledger, 'sess-nobody')
    assert.ok(nobody.ok)
    assert.equal(nobody.deleted, 0, '无主体时零删除零审计')
    assert.equal(ledger.readEvents('forget.executed', 100).length, auditBefore + 1)
  })

  // 10b. 截断日志上的遗忘/导出一律拒绝(红线 6「可删除」不得 fail-open)
  pass('截断即拒:遗忘与导出都拒绝在不完整 fold 上执行(readEvents 丢的是最老事件)', () => {
    const { root, ledger } = freshLedger('truncated-forget')
    ok(appendZoneWrite(ledger, captureReq()))
    ok(appendZoneWrite(ledger, captureReq({ payload: { city: '清迈' }, ts: at(MIN) })))
    ok(appendZoneWrite(ledger, captureReq({ payload: { city: '东京' }, ts: at(2 * MIN) })))
    const auditBefore = ledger.readEvents('forget.executed', 100).length
    const forget = forgetZoneSession(ledger, SESS_A, 'system:test', { limit: 2 })
    assert.equal(forget.ok, false, '截断时遗忘必须拒绝(否则静默漏删主体)')
    assert.equal((forget as { code?: string }).code, 'log_truncated')
    assert.equal(ledger.readEvents('forget.executed', 100).length, auditBefore, '拒绝路径零审计行零删除')
    assert.equal(Object.keys(readZoneLog(ledger).state.hot).length, 3, '主体一个都没被删')
    const views = readZoneExportViews(ledger, { limit: 2 })
    assert.equal(views.ok, false, '截断时导出必须拒绝(残缺视图会被当全量)')
    assert.equal((views as { code?: string }).code, 'log_truncated')
    const full = readZoneExportViews(ledger)
    assert.ok(full.ok)
    assert.equal(full.views.hotContextJsonl.split('\n').filter(Boolean).length, 3)
    void root
  })

  // 10. 导出视图 == fold 输出,且导出零新事件
  pass('state-cli export:两个派生视图逐字节 == fold 输出,且导出零新事件', () => {
    const { root, ledger } = freshLedger('export')
    ok(appendZoneWrite(ledger, captureReq()))
    ok(appendZoneWrite(ledger, captureReq({ tier: 'resource', kind: 'price_band', payload: { low: 400, high: 900 }, ts: at(MIN) })))
    const noteId = Object.keys(readZoneLog(ledger).state.hot).find(id => id.includes('destination'))!
    ok(appendZoneWrite(ledger, {
      op: 'promote',
      input: { note_id: noteId, kind: 'preference', owner_confirm: { surface: 'user_reply', quote: QUOTE }, ts: at(2 * MIN) },
    }))
    const expected = renderZoneExportViews(readZoneLog(ledger).state)
    const before = ledger.countEvents()
    ledger.close()
    const run = spawnSync('npx', ['tsx', 'scripts/state-cli.ts', 'export', root], { encoding: 'utf-8', timeout: 120_000 })
    assert.equal(run.status, 0, `export 应 exit 0:${run.stderr?.slice(0, 400)}`)
    const dir = join(root, 'gotry-state')
    assert.equal(readFileSync(join(dir, ZONE_EXPORT_HOT_FILE), 'utf-8'), expected.hotContextJsonl, 'hot 视图 == fold 输出')
    assert.equal(readFileSync(join(dir, ZONE_EXPORT_NOTEBOOK_FILE), 'utf-8'), expected.notebookJson, 'notebook 视图 == fold 输出')
    const reopened = openLedgerIfExists(root)!
    assert.equal(reopened.countEvents(), before, '导出是视图,不是写路径:零新事件')
    // 空分区不产生空文件(与既有 legacy 视图同纪律)
    const { root: emptyRoot } = freshLedger('export-empty')
    const empty = spawnSync('npx', ['tsx', 'scripts/state-cli.ts', 'export', emptyRoot], { encoding: 'utf-8', timeout: 120_000 })
    assert.equal(empty.status, 0)
    assert.equal(existsSync(join(emptyRoot, 'gotry-state', ZONE_EXPORT_HOT_FILE)), false)
    assert.equal(existsSync(join(emptyRoot, 'gotry-state', ZONE_EXPORT_NOTEBOOK_FILE)), false)
  })

  // 10c. capture_or_touch:过期后重捕获 / 同一检索重复出现都必须续命
  pass('capture_or_touch:过期笔记续命复活、重复同形观察续 TTL;纯 capture 仍 stale_rev', () => {
    const { ledger } = freshLedger('touch')
    const birth = ok(appendZoneWrite(ledger, { op: 'capture_or_touch', input: captureReq({ tier: 'resource', kind: 'availability', payload: { tool: 'gotry_flyai_search', verdict: 'hit', option_count: 2 } }).input }))
    assert.equal(birth.appended, true)
    const noteId = Object.keys(readZoneLog(ledger).state.hot)[0]!
    const first = readZoneLog(ledger).state.hot[noteId]!
    assert.equal(first.rev, 1)
    assert.equal(first.ttl_expires_at, new Date(Date.parse(T0) + 30 * MIN).toISOString())
    // 纯 capture:同 id 不同时刻 → stale_rev(未修复时观察缝就卡在这里)
    const plain = appendZoneWrite(ledger, { op: 'capture', input: { ...captureReq({ tier: 'resource', kind: 'availability', payload: { tool: 'gotry_flyai_search', verdict: 'hit', option_count: 2 }, ts: at(40 * MIN) }).input } })
    assert.ok(!plain.ok && plain.code === 'stale_rev', `纯 capture 仍应 stale_rev:${JSON.stringify(plain)}`)
    // 40 分钟后(已过期)同形观察:续命 → rev 2 且到期时刻推到 40min+30min
    const touched = ok(appendZoneWrite(ledger, { op: 'capture_or_touch', input: captureReq({ tier: 'resource', kind: 'availability', payload: { tool: 'gotry_flyai_search', verdict: 'hit', option_count: 2 }, ts: at(40 * MIN) }).input }))
    assert.equal(touched.appended, true, '过期笔记必须能被续命(否则工作区永久停供该形态)')
    assert.equal(touched.event?.kind, 'hotctx.note.revised')
    const revived = readZoneLog(ledger).state.hot[noteId]!
    assert.equal(revived.rev, 2)
    assert.equal(revived.created_at, T0, '续命保留诞生时刻(血缘不漂移)')
    assert.equal(revived.last_touched_at, at(40 * MIN))
    assert.equal(revived.ttl_expires_at, new Date(Date.parse(T0) + 70 * MIN).toISOString(), 'TTL 自最后一次写入起算')
    assert.deepEqual(
      readWorkingZone(readZoneLog(ledger).state, { now: at(41 * MIN), session_ref: SESS_A }).map(x => x.rev),
      [2],
      '续命后重新进入读视图',
    )
    // 同 ts 同内容重放仍是幂等 no-op(不白记一条)
    const replay = ok(appendZoneWrite(ledger, { op: 'capture_or_touch', input: captureReq({ tier: 'resource', kind: 'availability', payload: { tool: 'gotry_flyai_search', verdict: 'hit', option_count: 2 }, ts: at(40 * MIN) }).input }))
    assert.equal(replay.appended, false)
    // 其他拒收(负面清单)不得被 capture_or_touch 放宽
    const neg = appendZoneWrite(ledger, { op: 'capture_or_touch', input: captureReq({ payload: { city: '大理', phone: '13800138000' }, ts: at(41 * MIN) }).input })
    assert.ok(!neg.ok && neg.code === 'negative_list')
  })

  // 10d. 生代碰撞:显式报错,不静默吞
  pass('生代碰撞:同毫秒 capture→drop→重捕获 → idem_collision 显式失败(不报假幂等)', () => {
    const { ledger } = freshLedger('collision')
    const first = ok(appendZoneWrite(ledger, captureReq()))
    const noteId = Object.keys(readZoneLog(ledger).state.hot)[0]!
    ok(appendZoneWrite(ledger, { op: 'drop', note_id: noteId, ts: at(MIN) }))
    const before = ledger.countEvents()
    const same = appendZoneWrite(ledger, captureReq()) // 与诞生同一毫秒 → 同一幂等键
    assert.equal(same.ok, false, '必须显式失败而不是报 appended:false')
    assert.equal((same as { code?: string }).code, 'idem_collision')
    assert.equal(ledger.countEvents(), before, '失败路径零新行')
    assert.equal(first.idemKey, `hotctx:${noteId}:${T0}:1`)
    // 换一个写入时刻即可成功(生代不同)
    const later = ok(appendZoneWrite(ledger, captureReq({ ts: at(2 * MIN) })))
    assert.equal(later.appended, true)
  })

  // 11. 读上界 fail-closed
  pass('日志触读上界 → log_truncated fail-closed:零写入,不在不全日志上猜 rev', () => {
    const { ledger } = freshLedger('truncate')
    ok(appendZoneWrite(ledger, captureReq()))
    ok(appendZoneWrite(ledger, captureReq({ payload: { city: '清迈' }, ts: at(MIN) })))
    const read = readZoneLog(ledger, { limit: 2 })
    assert.equal(read.truncated, true, '触顶即标记')
    const before = ledger.countEvents()
    const r = appendZoneWrite(ledger, captureReq({ payload: { city: '东京' }, ts: at(2 * MIN) }), { limit: 2 })
    assert.ok(!r.ok && r.code === 'log_truncated', `应 log_truncated:${JSON.stringify(r)}`)
    assert.equal(ledger.countEvents(), before)
  })

  // 12. 坏行/伪造文档:确定性跳过,不投影
  pass('坏行与伪造文档:坏 JSON/错形状/闭集外文档确定性跳过,fold 不投影', () => {
    const { ledger } = freshLedger('malformed')
    ok(appendZoneWrite(ledger, captureReq()))
    ledger.insertEvent({ actor: 'test:junk', kind: 'hotctx.note.captured', subjectId: 'junk-1', payload: 'not-json-object', idemKey: 'junk:1', ts: at(MIN) })
    ledger.insertEvent({ actor: 'test:junk', kind: 'hotctx.note.captured', subjectId: 'junk-2', payload: { note: 'string-not-doc' }, idemKey: 'junk:2', ts: at(2 * MIN) })
    ledger.insertEvent({ actor: 'test:junk', kind: 'hotctx.note.dropped', subjectId: 'junk-3', payload: {}, idemKey: 'junk:3', ts: at(3 * MIN) })
    ledger.insertEvent({
      actor: 'test:junk',
      kind: 'hotctx.note.captured',
      subjectId: 'junk-4',
      payload: { note: { zone: 'hot_context', tier: 'forever', kind: 'destination', note_id: 'junk-4', rev: 1 } },
      idemKey: 'junk:4',
      ts: at(4 * MIN),
    })
    const read = readZoneLog(ledger)
    assert.equal(read.malformed, 3, '三条形状不合法的行被跳过(坏 JSON/错类型/缺字段)')
    assert.equal(Object.keys(read.state.hot).length, 1, '闭集外 tier 的伪造文档不被投影')
    assert.deepEqual(readZoneLog(ledger).state, read.state, '同一日志两次读结果一致(确定性)')
  })

  // 13. 与既有面互不干扰
  pass('与既有账本面互不干扰:分区事件无投影;rebuild 后分区读回不变;租户隔离', () => {
    const { root, ledger } = freshLedger('coexist')
    ledger.appendWish({ name: '冰岛极光', conditions: { days: 9 } })
    ledger.appendMotivationPatch({ weights: { escape_rest: 0.7 }, evidence: ['想躺平'] })
    ok(appendZoneWrite(ledger, captureReq()))
    const zoneBefore = readZoneLog(ledger).state
    const rebuilt = ledger.rebuildProjections()
    assert.equal(rebuilt.wishes, 1, '既有投影照常重建')
    assert.ok(ledger.readMotivation())
    assert.deepEqual(readZoneLog(ledger).state, zoneBefore, 'rebuild 不影响分区读回(日志类事件无投影)')
    const projections = ledger.db.prepare('SELECT COUNT(*) AS n FROM projection_items').get() as { n: number }
    assert.equal(projections.n, 1, '分区事件不写 projection_items(只有 wish 一条)')
    const other = ensureLedger(root, 'tenant-x')
    assert.equal(zoneEventCount(other), 0, '租户隔离:另一租户读不到本租户分区事件')
    assert.equal(Object.keys(readZoneLog(other).state.hot).length, 0)
  })

  // 14. 过期是读时视图(账本里没有过期事件)
  pass('过期是读时视图:账本零过期事件;resource 30min 过期后不入读视图,事件仍在', () => {
    const { ledger } = freshLedger('expiry')
    ok(appendZoneWrite(ledger, captureReq({ tier: 'resource', kind: 'availability', payload: { rooms: 3 } })))
    ok(appendZoneWrite(ledger, captureReq({ tier: 'intent', payload: { city: '大理' }, ts: at(MIN) })))
    const state = readZoneLog(ledger).state
    assert.equal(readWorkingZone(state, { now: at(10 * MIN), session_ref: SESS_A }).length, 2)
    const later = readWorkingZone(state, { now: at(31 * MIN), session_ref: SESS_A })
    assert.deepEqual(later.map(x => x.tier), ['intent'], 'resource 层 30min 后出读视图')
    assert.equal(readWorkingZone(state, { now: at(25 * 60 * MIN), session_ref: SESS_A }).length, 0, 'intent 层 24h 后出读视图')
    assert.equal(Object.keys(state.hot).length, 2, '过期不删事件:fold 状态仍有两条')
    const kinds = new Set(ledger.readEvents(undefined, 100).map(e => e.kind))
    for (const k of kinds) {
      assert.ok(!/expir|sweep|ttl/i.test(k), `账本不得出现过期/清扫类事件:${k}`)
    }
  })

  console.log(`\nSESSION ZONE LEDGER TESTS: ${n}/18 OK(P4-2 账本落点:六 kind 落既有表/单事务守门 fail-closed/双道幂等/kill -9 全有或全无/forget 一行审计/导出视图==fold;隔离 stateRoot,全离线)`)
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}
