/**
 * 会话双区记忆分区契约纯核单测(P4-1,design/session-dual-zone-memory-design.md §5):
 * 闭集拒收/写侧负面清单(证件·手机号·URL·凭证)/rev CAS(同 rev 幂等 no-op、stale_rev
 * fail-closed 类型化)/注入时钟分层 TTL(30min resource·24h intent,只自写入起算,
 * 读不续命)/确定性 fold(重建==直读)。全离线:零 IO、零定时器、零网络、零账本。
 * 运行:cd ts && npx tsx scripts/session-zones-tests.ts
 */

import assert from 'node:assert/strict'
import {
  CONFIRM_SURFACES,
  HOT_NOTE_KINDS,
  HOT_TIERS,
  NOTEBOOK_KINDS,
  SESSION_ZONES,
  captureHotNote,
  canonicalJson,
  dropHotNote,
  dropNotebookEntry,
  expiresAtOf,
  foldZoneEvents,
  isConfirmSurface,
  isHotNoteKind,
  isHotTier,
  isNotebookKind,
  isSessionZone,
  isHotNoteLive,
  makeHotNoteId,
  promoteHotNote,
  readNotebook,
  readWorkingZone,
  reviseHotNote,
  reviseNotebookEntry,
  zoneIdemKey,
  zoneWriteViolation,
  type ZoneEvent,
  type ZoneState,
  type ZoneWriteResult,
} from '../src/session-zones.ts'

let n = 0
function pass(name: string, body: () => void) {
  body()
  console.log(`  ${++n}. ${name} OK`)
}

/** 断言写门产出待追加事件并推进直读状态(每追加即 fold = 直读投影) */
function apply(state: { events: ZoneEvent[]; zone: ZoneState }, r: ZoneWriteResult): void {
  assert.ok(r.ok, `写门必须接受:${JSON.stringify(r)}`)
  assert.equal(r.appended, true, `必须产生事件:${r.detail ?? ''}`)
  state.events.push(r.event!)
  state.zone = foldZoneEvents(state.events)
}

function rejectedCode(r: ZoneWriteResult, code: string): void {
  assert.ok(!r.ok, `应被拒:${JSON.stringify(r)}`)
  assert.equal(r.code, code)
}

const T0 = '2026-10-02T08:00:00.000Z'
const MIN = 60_000
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString()

const SESS_A = 'sess-alpha-001'
const SESS_B = 'sess-beta-002'

function freshZone(): { events: ZoneEvent[]; zone: ZoneState } {
  return { events: [], zone: foldZoneEvents([]) }
}

function captureInput(over: Partial<Parameters<typeof captureHotNote>[1]> = {}) {
  return {
    session_ref: SESS_A,
    tier: 'intent' as const,
    kind: 'destination' as const,
    payload: { city: '大理' },
    evidence_ref: { session_ref: SESS_A, turn: 2 },
    ts: T0,
    ...over,
  }
}

// ---- 1. 闭集 ----------------------------------------------------------------------

pass('闭集:两区/tier/kind/确认表面守卫,未知分区拒收', () => {
  assert.equal(isSessionZone('hot_context'), true)
  assert.equal(isSessionZone('trip_notebook'), true)
  assert.equal(isSessionZone('archive'), false, '未知分区必须拒收')
  assert.equal(isSessionZone('hot'), false, '设计分区名是 hot_context/trip_notebook,不是 hot/durable 简写')
  assert.deepEqual(SESSION_ZONES, ['hot_context', 'trip_notebook'])
  assert.equal(isHotTier('resource') && isHotTier('intent'), true)
  assert.equal(isHotTier('warm'), false)
  assert.deepEqual(HOT_TIERS, ['resource', 'intent'])
  assert.equal(isHotNoteKind('availability'), true)
  assert.equal(isHotNoteKind('vibe'), false)
  assert.deepEqual(HOT_NOTE_KINDS.length, 6)
  assert.equal(isNotebookKind('trip_fact') && isNotebookKind('lesson'), true)
  assert.equal(isNotebookKind('note'), false)
  assert.deepEqual(NOTEBOOK_KINDS, ['trip_fact', 'preference', 'constraint', 'lesson'])
  assert.equal(isConfirmSurface('user_reply') && isConfirmSurface('approval_card'), true)
  assert.equal(isConfirmSurface('sms'), false)
  assert.deepEqual(CONFIRM_SURFACES, ['user_reply', 'approval_card'])
})

pass('闭集:写门拒收未知 tier/kind/确认表面(类型化 closed_set)', () => {
  const z = freshZone()
  apply(z, captureHotNote(z.zone, captureInput()))
  const noteId = Object.keys(z.zone.hot)[0]!
  rejectedCode(captureHotNote(z.zone, captureInput({ tier: 'ephemeral' as never })), 'closed_set')
  rejectedCode(captureHotNote(z.zone, captureInput({ kind: 'weather' as never })), 'closed_set')
  rejectedCode(
    promoteHotNote(z.zone, { note_id: noteId, kind: 'diary' as never, owner_confirm: { surface: 'user_reply', quote: 'q' }, ts: T0 }),
    'closed_set',
  )
  rejectedCode(
    promoteHotNote(z.zone, { note_id: noteId, kind: 'trip_fact', owner_confirm: { surface: 'sms' as never, quote: 'q' }, ts: T0 }),
    'closed_set',
  )
})

pass('闭集:fold 对伪造未知分区/未知事件 kind 的文档拒投影(fail-closed)', () => {
  const ok = freshZone()
  const cap = captureHotNote(ok.zone, captureInput())
  const ev = cap.ok && cap.appended ? cap.event : undefined
  if (!ev || ev.kind !== 'hotctx.note.captured') throw new Error('fixture: 应产出 captured 事件')
  const forgedZone = { ...ev, note: { ...ev.note, zone: 'trip_notebook' as never } } as ZoneEvent
  assert.equal(Object.keys(foldZoneEvents([forgedZone]).hot).length, 0, '伪造分区值不得进状态')
  const unknownKind = { kind: 'hotctx.note.expired', ts: T0, note_id: 'n1' } as unknown as ZoneEvent
  assert.equal(Object.keys(foldZoneEvents([unknownKind]).hot).length, 0, '未知事件 kind 拒投影')
  const badTierDoc = { ...ev, note: { ...ev.note, tier: 'warm' as never } } as ZoneEvent
  assert.equal(Object.keys(foldZoneEvents([badTierDoc]).hot).length, 0, '伪造 tier 拒投影')
})

// ---- 2. 写侧负面清单(设计 §4 双重负面清单的写侧) ----------------------------------

pass('负面清单:证件号/手机号/URL/凭证形态载荷拒收入区', () => {
  const z = freshZone()
  const cases: Array<Record<string, unknown>> = [
    { holder: '证件 110101199001011234' },
    { contact: '电话 13812345678' },
    { link: 'https://example.com/hotel' },
    { link: 'http://foo.cn/x?a=1' },
    { link: '详情见 www.foo.com/bar' },
    { link: '供应商 foo.cn' },
    { cred: 'api_key=abcd1234efgh' },
    { cred: 'sk-abcdefgh12345678' },
    { cred: 'Bearer eyJhbGciOi' },
  ]
  for (const payload of cases) {
    rejectedCode(captureHotNote(z.zone, captureInput({ payload: payload as Record<string, unknown> })), 'negative_list')
  }
})

pass('负面清单:确认引用同样扫描(owner 原话里的手机号/URL 不入区)', () => {
  const z = freshZone()
  apply(z, captureHotNote(z.zone, captureInput()))
  const noteId = Object.keys(z.zone.hot)[0]!
  rejectedCode(
    promoteHotNote(z.zone, { note_id: noteId, kind: 'trip_fact', owner_confirm: { surface: 'user_reply', quote: '打我电话 13812345678' }, ts: T0 }),
    'negative_list',
  )
  rejectedCode(
    promoteHotNote(z.zone, { note_id: noteId, kind: 'trip_fact', owner_confirm: { surface: 'approval_card', quote: '看 https://x.io/c' }, ts: T0 }),
    'negative_list',
  )
  assert.ok(zoneWriteViolation('www.foo.com')?.includes('负面清单'))
  assert.equal(zoneWriteViolation('就定大理,11 月中出发'), null, '干净引用放行')
})

pass('负面清单:干净载荷放行(行为/偏好/结构片段,非敏感身份)', () => {
  const z = freshZone()
  apply(z, captureHotNote(z.zone, captureInput({ tier: 'resource', kind: 'availability', payload: { city: '大理', window: '2026-11-14..2026-11-18', rooms: 1 } })))
  apply(z, captureHotNote(z.zone, captureInput({ tier: 'intent', kind: 'budget_stance', payload: { stance: '宽松', max_cny: 7000 }, evidence_ref: { session_ref: SESS_A, turn: 3 } })))
  assert.equal(Object.keys(z.zone.hot).length, 2)
})

// ---- 3. 形状与有界闸 ---------------------------------------------------------------

pass('形状闸:session_ref 路径字符/空白/超长拒收;turn 非负整数', () => {
  const z = freshZone()
  rejectedCode(captureHotNote(z.zone, captureInput({ session_ref: 'a/b' })), 'bad_session_ref')
  rejectedCode(captureHotNote(z.zone, captureInput({ session_ref: 'a b' })), 'bad_session_ref')
  rejectedCode(captureHotNote(z.zone, captureInput({ session_ref: '..' })), 'bad_session_ref')
  rejectedCode(captureHotNote(z.zone, captureInput({ session_ref: 'x'.repeat(65) })), 'bad_session_ref')
  rejectedCode(captureHotNote(z.zone, captureInput({ evidence_ref: { session_ref: SESS_A, turn: -1 } })), 'bad_evidence_ref')
  rejectedCode(captureHotNote(z.zone, captureInput({ evidence_ref: { session_ref: SESS_A, turn: 1.5 } })), 'bad_evidence_ref')
  rejectedCode(captureHotNote(z.zone, captureInput({ ts: 'not-a-time' })), 'bad_ts')
})

pass('有界闸:payload 必须结构化/有界/无环/超深拒收;确认引用缺失或超界拒收', () => {
  const z = freshZone()
  rejectedCode(captureHotNote(z.zone, captureInput({ payload: ['arr'] as unknown as Record<string, unknown> })), 'payload_bound')
  rejectedCode(captureHotNote(z.zone, captureInput({ payload: { blob: 'x'.repeat(3000) } })), 'payload_bound')
  const cyclic: Record<string, unknown> = { city: '大理' }
  cyclic['self'] = cyclic
  rejectedCode(captureHotNote(z.zone, captureInput({ payload: cyclic })), 'payload_bound')
  const deep: Record<string, unknown> = { v: 0 }
  for (let i = 0; i < 9; i++) deep['v'] = { v: deep['v'] }
  rejectedCode(captureHotNote(z.zone, captureInput({ payload: { deep } })), 'payload_bound')
  apply(z, captureHotNote(z.zone, captureInput()))
  const noteId = Object.keys(z.zone.hot)[0]!
  rejectedCode(
    promoteHotNote(z.zone, { note_id: noteId, kind: 'trip_fact', owner_confirm: { surface: 'user_reply', quote: '' }, ts: T0 }),
    'owner_confirm',
  )
  rejectedCode(
    promoteHotNote(z.zone, { note_id: noteId, kind: 'trip_fact', owner_confirm: { surface: 'user_reply', quote: '好'.repeat(201) }, ts: T0 }),
    'owner_confirm',
  )
  rejectedCode(
    promoteHotNote(z.zone, { note_id: noteId, kind: 'trip_fact', owner_confirm: undefined as never, ts: T0 }),
    'owner_confirm',
  )
})

// ---- 4. rev CAS:同 rev 幂等 no-op / stale_rev fail-closed --------------------------

pass('rev CAS:同 rev 同内容重放是幂等 no-op(捕获与修订两侧,零新事件)', () => {
  const z = freshZone()
  apply(z, captureHotNote(z.zone, captureInput()))
  const noteId = Object.keys(z.zone.hot)[0]!
  const replayCapture = captureHotNote(z.zone, captureInput())
  assert.ok(replayCapture.ok && replayCapture.appended === false, '捕获重放必须 no-op')
  apply(z, reviseHotNote(z.zone, { note_id: noteId, expected_rev: 1, payload: { city: '大理', region: '云南' }, ts: at(10 * MIN) }))
  assert.equal(z.zone.hot[noteId]!.rev, 2)
  const eventsBefore = z.events.length
  const replayRevise = reviseHotNote(z.zone, { note_id: noteId, expected_rev: 1, payload: { city: '大理', region: '云南' }, ts: at(10 * MIN) })
  assert.ok(replayRevise.ok && replayRevise.appended === false, '产生当前 rev 的那次写的重放必须 no-op')
  assert.equal(z.events.length, eventsBefore, 'no-op 不得追加事件')
})

pass('rev CAS:父 rev ≠ 当前 fold rev → stale_rev fail-closed(旧父/未来父/活笔记上再捕获)', () => {
  const z = freshZone()
  apply(z, captureHotNote(z.zone, captureInput()))
  const noteId = Object.keys(z.zone.hot)[0]!
  apply(z, reviseHotNote(z.zone, { note_id: noteId, expected_rev: 1, payload: { city: '大理' }, ts: at(5 * MIN) }))
  rejectedCode(reviseHotNote(z.zone, { note_id: noteId, expected_rev: 1, payload: { city: '丽江' }, ts: at(6 * MIN) }), 'stale_rev')
  rejectedCode(reviseHotNote(z.zone, { note_id: noteId, expected_rev: 5, payload: { city: '丽江' }, ts: at(6 * MIN) }), 'stale_rev')
  rejectedCode(captureHotNote(z.zone, captureInput({ ts: at(7 * MIN) })), 'stale_rev')
  rejectedCode(reviseHotNote(z.zone, { note_id: 'hn|missing', expected_rev: 1, ts: at(7 * MIN) }), 'unknown_subject')
  rejectedCode(dropHotNote(z.zone, 'hn|missing', at(7 * MIN)), 'unknown_subject')
  // no-op 重放不改变事件流;stale 写零事件零状态变化
  assert.equal(z.events.length, 2, '只有捕获+修订两事件落地')
  assert.equal(z.zone.hot[noteId]!.rev, 2)
})

pass('rev CAS:笔记本修订同款(重放 no-op/旧父 stale/无确认拒收)', () => {
  const z = freshZone()
  apply(z, captureHotNote(z.zone, captureInput()))
  const noteId = Object.keys(z.zone.hot)[0]!
  apply(z, promoteHotNote(z.zone, { note_id: noteId, kind: 'trip_fact', owner_confirm: { surface: 'user_reply', quote: '就定大理,11 月中出发' }, ts: at(10 * MIN) }))
  const entryId = Object.keys(z.zone.notebook)[0]!
  // 同源同 kind 的即时重晋升 = 同 entry_id 同内容 = 幂等 no-op(修订发生前)
  const rePromote = promoteHotNote(z.zone, { note_id: noteId, kind: 'trip_fact', owner_confirm: { surface: 'user_reply', quote: '就定大理,11 月中出发' }, ts: at(10 * MIN) })
  assert.ok(rePromote.ok && rePromote.appended === false, '同 rev 重晋升必须 no-op')
  apply(z, reviseNotebookEntry(z.zone, { entry_id: entryId, expected_rev: 1, payload: { city: '大理', days: 5 }, owner_confirm: { surface: 'approval_card', quote: '改成 5 天' }, ts: at(15 * MIN) }))
  assert.equal(z.zone.notebook[entryId]!.rev, 2)
  const replay = reviseNotebookEntry(z.zone, { entry_id: entryId, expected_rev: 1, payload: { city: '大理', days: 5 }, owner_confirm: { surface: 'approval_card', quote: '改成 5 天' }, ts: at(15 * MIN) })
  assert.ok(replay.ok && replay.appended === false, '笔记本修订重放必须 no-op')
  rejectedCode(reviseNotebookEntry(z.zone, { entry_id: entryId, expected_rev: 1, payload: { city: '丽江' }, owner_confirm: { surface: 'user_reply', quote: '改目的地' }, ts: at(16 * MIN) }), 'stale_rev')
  rejectedCode(
    reviseNotebookEntry(z.zone, { entry_id: entryId, expected_rev: 2, payload: { city: '丽江' }, owner_confirm: undefined as never, ts: at(16 * MIN) }),
    'owner_confirm',
  )
  // 条目已演进到 rev2:旧诞生写(重晋升)fail-closed 为 stale_rev
  rejectedCode(
    promoteHotNote(z.zone, { note_id: noteId, kind: 'trip_fact', owner_confirm: { surface: 'user_reply', quote: '就定大理,11 月中出发' }, ts: at(20 * MIN) }),
    'stale_rev',
  )
})

// ---- 5. 注入时钟的分层 TTL(读时纯函数视图,读不续命) -------------------------------

pass('TTL 分层:resource 30min / intent 24h,自写入起算,边界即过期', () => {
  const z = freshZone()
  apply(z, captureHotNote(z.zone, captureInput({ tier: 'resource', kind: 'availability', payload: { city: '大理' }, evidence_ref: { session_ref: SESS_A, turn: 1 } })))
  apply(z, captureHotNote(z.zone, captureInput({ tier: 'intent', kind: 'destination', payload: { city: '大理' }, evidence_ref: { session_ref: SESS_A, turn: 2 } })))
  assert.equal(expiresAtOf('resource', T0), at(30 * MIN))
  assert.equal(expiresAtOf('intent', T0), at(24 * 60 * MIN))
  const [resourceNote, intentNote] = Object.values(z.zone.hot)
  assert.equal(resourceNote!.tier, 'resource')
  assert.equal(intentNote!.tier, 'intent')
  assert.ok(isHotNoteLive(resourceNote!, at(29 * MIN + 999)), 'resource 29m59.999s 仍活')
  assert.ok(!isHotNoteLive(resourceNote!, at(30 * MIN)), 'resource 到 30m 边界即过期')
  assert.ok(isHotNoteLive(intentNote!, at(23 * 60 * MIN + 999)), 'intent 23h59m59.999s 仍活')
  assert.ok(!isHotNoteLive(intentNote!, at(24 * 60 * MIN)), 'intent 到 24h 边界即过期')
})

pass('TTL 分层:同一时刻 resource 已死而 intent 仍活(分层可否证面)', () => {
  const z = freshZone()
  apply(z, captureHotNote(z.zone, captureInput({ tier: 'resource', kind: 'price_band', payload: { band: '中档' }, evidence_ref: { session_ref: SESS_A, turn: 1 } })))
  apply(z, captureHotNote(z.zone, captureInput({ tier: 'intent', kind: 'destination', payload: { city: '大理' }, evidence_ref: { session_ref: SESS_A, turn: 2 } })))
  const at2h = at(2 * 60 * MIN)
  const view = readWorkingZone(z.zone, { now: at2h, session_ref: SESS_A })
  assert.equal(view.length, 1, '2h 后只剩 intent 层')
  assert.equal(view[0]!.tier, 'intent')
})

pass('TTL:修订(写)续命、读不续命;过期随注入时钟单调(一旦过期不再复活)', () => {
  const z = freshZone()
  apply(z, captureHotNote(z.zone, captureInput({ tier: 'resource', kind: 'price_band', payload: { band: '中档' }, evidence_ref: { session_ref: SESS_A, turn: 1 } })))
  const noteId = Object.keys(z.zone.hot)[0]!
  // 读 100 次不续命:视图不 mutate 状态,last_touched/expires 不动
  for (let i = 0; i < 100; i++) readWorkingZone(z.zone, { now: at(20 * MIN), session_ref: SESS_A })
  assert.equal(z.zone.hot[noteId]!.last_touched_at, T0, '读路径零写入')
  assert.equal(z.zone.hot[noteId]!.ttl_expires_at, at(30 * MIN))
  // 写续命:20m 处修订,窗口自该写重算
  apply(z, reviseHotNote(z.zone, { note_id: noteId, expected_rev: 1, payload: { band: '中高档' }, ts: at(20 * MIN) }))
  assert.equal(z.zone.hot[noteId]!.ttl_expires_at, at(50 * MIN), 'TTL 自最后一次写入起算')
  assert.ok(isHotNoteLive(z.zone.hot[noteId]!, at(45 * MIN)), '修订后 45m 仍活')
  // 单调:固定事件流上,过期一旦发生,更晚的时钟都过期
  const note = z.zone.hot[noteId]!
  let sawExpired = false
  for (let m = 45; m <= 120; m += 5) {
    const live = isHotNoteLive(note, at(m * MIN))
    if (sawExpired) assert.ok(!live, `过期后不得复活(${m}min)`)
    if (!live) sawExpired = true
  }
  assert.ok(sawExpired, '采样窗内必须见过期')
  // 坏时钟 fail-closed
  assert.ok(!isHotNoteLive(note, 'not-a-clock'), '坏时钟不得判活')
})

pass('TTL:会话域可见性——resource 只在本会话可读,intent 跨会话可读到过期', () => {
  const z = freshZone()
  apply(z, captureHotNote(z.zone, captureInput({ tier: 'resource', kind: 'availability', payload: { city: '大理' }, evidence_ref: { session_ref: SESS_A, turn: 1 } })))
  apply(z, captureHotNote(z.zone, captureInput({ tier: 'intent', kind: 'destination', payload: { city: '大理' }, evidence_ref: { session_ref: SESS_A, turn: 2 } })))
  const inA = readWorkingZone(z.zone, { now: at(10 * MIN), session_ref: SESS_A })
  assert.equal(inA.length, 2, '本会话两层可读')
  const inB = readWorkingZone(z.zone, { now: at(10 * MIN), session_ref: SESS_B })
  assert.equal(inB.length, 1, '他乡会话只见 intent')
  assert.equal(inB[0]!.tier, 'intent')
  // intent 跨会话可读到 24h 届满(「第二天回访」窗口)
  assert.equal(readWorkingZone(z.zone, { now: at(23 * 60 * MIN), session_ref: SESS_B }).length, 1)
  assert.equal(readWorkingZone(z.zone, { now: at(24 * 60 * MIN), session_ref: SESS_B }).length, 0, '24h 届满跨会话也不可读')
})

// ---- 6. 晋升:owner 确认是唯一入口;过期源 fail-closed;lineage 保真 ----------------

pass('晋升:活源+owner 确认 → durable 条目(lineage/证据引用/持久无 TTL)', () => {
  const z = freshZone()
  apply(z, captureHotNote(z.zone, captureInput({ payload: { city: '大理', window: '11 月中' } })))
  const noteId = Object.keys(z.zone.hot)[0]!
  apply(z, promoteHotNote(z.zone, { note_id: noteId, kind: 'trip_fact', owner_confirm: { surface: 'user_reply', quote: '就定大理,11 月中出发' }, ts: at(10 * MIN) }))
  const entries = readNotebook(z.zone)
  assert.equal(entries.length, 1)
  const e = entries[0]!
  assert.equal(e.zone, 'trip_notebook')
  assert.equal(e.kind, 'trip_fact')
  assert.equal(e.origin.note_id, noteId, '晋升血缘保真')
  assert.equal(e.origin.session_ref, SESS_A)
  assert.equal(e.owner_confirm.surface, 'user_reply')
  assert.equal(e.evidence, '就定大理,11 月中出发', '证据=owner 原话有界引用')
  assert.equal(e.rev, 1)
  // 持久区与时钟无关:源笔记过期后条目仍在(且晋升后工作区笔记不受影响)
  assert.equal(readNotebook(foldZoneEvents(z.events)).length, 1)
  assert.ok(z.zone.hot[noteId], '晋升不移除工作区笔记(仍服务本会话到过期)')
})

pass('晋升:过期源 fail-closed(source_expired);drop 后源不可晋升', () => {
  const z = freshZone()
  apply(z, captureHotNote(z.zone, captureInput({ tier: 'resource', kind: 'price_band', payload: { band: '中档' }, evidence_ref: { session_ref: SESS_A, turn: 1 } })))
  const noteId = Object.keys(z.zone.hot)[0]!
  rejectedCode(
    promoteHotNote(z.zone, { note_id: noteId, kind: 'trip_fact', owner_confirm: { surface: 'user_reply', quote: '现在就要' }, ts: at(31 * MIN) }),
    'source_expired',
  )
  apply(z, dropHotNote(z.zone, noteId, at(32 * MIN)))
  rejectedCode(
    promoteHotNote(z.zone, { note_id: noteId, kind: 'trip_fact', owner_confirm: { surface: 'user_reply', quote: '现在就要' }, ts: at(33 * MIN) }),
    'unknown_subject',
  )
  // owner 移除条目 = 物理移出状态(审计行随事件日志)
  apply(z, captureHotNote(z.zone, captureInput({ tier: 'intent', kind: 'party_size', payload: { adults: 2 }, evidence_ref: { session_ref: SESS_A, turn: 4 } })))
  const note2 = Object.keys(z.zone.hot).find(id => id !== noteId)!
  apply(z, promoteHotNote(z.zone, { note_id: note2, kind: 'constraint', owner_confirm: { surface: 'approval_card', quote: '两大人无娃' }, ts: at(34 * MIN) }))
  const entryId = Object.keys(z.zone.notebook)[0]!
  apply(z, dropNotebookEntry(z.zone, entryId, at(35 * MIN)))
  assert.equal(readNotebook(z.zone).length, 0)
})

// ---- 7. fold 纯函数:重建==直读;重复事件 no-op;drop→重捕获;纯度 -------------------

pass('fold:确定性纯函数——逐步直读投影 == 全量重建(含全六类事件)', () => {
  const z = freshZone()
  apply(z, captureHotNote(z.zone, captureInput({ payload: { city: '大理', window: '11 月中' } })))
  const dest = Object.keys(z.zone.hot)[0]!
  apply(z, captureHotNote(z.zone, captureInput({ tier: 'resource', kind: 'availability', payload: { city: '大理', rooms: 1 }, evidence_ref: { session_ref: SESS_A, turn: 3 } })))
  const avail = Object.keys(z.zone.hot).find(id => id !== dest)!
  apply(z, reviseHotNote(z.zone, { note_id: avail, expected_rev: 1, payload: { city: '大理', rooms: 2 }, ts: at(10 * MIN) }))
  apply(z, dropHotNote(z.zone, dest, at(11 * MIN)))
  apply(z, captureHotNote(z.zone, captureInput({ tier: 'intent', kind: 'budget_stance', payload: { stance: '宽松' }, evidence_ref: { session_ref: SESS_A, turn: 5 } })))
  const budget = Object.keys(z.zone.hot).find(id => id !== avail)!
  apply(z, promoteHotNote(z.zone, { note_id: budget, kind: 'preference', owner_confirm: { surface: 'user_reply', quote: '预算宽松些' }, ts: at(12 * MIN) }))
  const entry = Object.keys(z.zone.notebook)[0]!
  apply(z, reviseNotebookEntry(z.zone, { entry_id: entry, expected_rev: 1, payload: { stance: '宽松', max_cny: 8000 }, owner_confirm: { surface: 'approval_card', quote: '上限 8000' }, ts: at(13 * MIN) }))
  apply(z, dropNotebookEntry(z.zone, entry, at(14 * MIN)))
  apply(z, promoteHotNote(z.zone, { note_id: budget, kind: 'constraint', owner_confirm: { surface: 'user_reply', quote: '预算宽松' }, ts: at(15 * MIN) }))
  const kinds = new Set(z.events.map(e => e.kind))
  for (const k of ['hotctx.note.captured', 'hotctx.note.revised', 'hotctx.note.dropped', 'notebook.entry.promoted', 'notebook.entry.revised', 'notebook.entry.dropped']) {
    assert.ok(kinds.has(k as ZoneEvent['kind']), `事件覆盖 ${k}`)
  }
  const rebuild = foldZoneEvents(z.events)
  assert.deepEqual(rebuild, z.zone, '全量重建 == 逐步直读投影')
  // 事件序不变时 fold 是全纯函数:重放整段事件流结果逐字节一致
  assert.deepEqual(foldZoneEvents([...z.events]), foldZoneEvents(z.events))
})

pass('fold:重复事件(同 rev 重放)天然 no-op;幂等键遵循设计钉死格式', () => {
  const z = freshZone()
  apply(z, captureHotNote(z.zone, captureInput()))
  const noteId = Object.keys(z.zone.hot)[0]!
  apply(z, reviseHotNote(z.zone, { note_id: noteId, expected_rev: 1, payload: { city: '丽江' }, ts: at(10 * MIN) }))
  const once = foldZoneEvents(z.events)
  const twice = foldZoneEvents([...z.events, ...z.events])
  assert.deepEqual(once, twice, '同 rev 重放物理 no-op')
  assert.equal(twice.hot[noteId]!.rev, 2, '重放不得推进 rev')
  const cap = z.events[0]!
  const rev = z.events[1]!
  assert.match(zoneIdemKey(cap), /^hotctx:.+:1$/)
  assert.match(zoneIdemKey(rev), /^hotctx:.+:2$/)
})

pass('fold:drop→重捕获生命周期(更正后仍真);fold 不改入参(纯度)', () => {
  const z = freshZone()
  apply(z, captureHotNote(z.zone, captureInput()))
  const noteId = Object.keys(z.zone.hot)[0]!
  apply(z, dropHotNote(z.zone, noteId, at(5 * MIN)))
  apply(z, captureHotNote(z.zone, captureInput({ evidence_ref: { session_ref: SESS_A, turn: 6 }, ts: at(6 * MIN) })))
  const reborn = z.zone.hot[noteId]!
  assert.ok(reborn, 'drop 后重捕获应复活')
  assert.equal(reborn.created_at, at(6 * MIN), '新生命周期自新写入起算')
  // 纯度:fold/读视图不 mutate 事件入参与状态
  const snapshot = JSON.stringify(z.events)
  const zoneSnapshot = JSON.stringify(z.zone)
  foldZoneEvents(z.events)
  readWorkingZone(z.zone, { now: at(7 * MIN), session_ref: SESS_A })
  readNotebook(z.zone)
  assert.equal(JSON.stringify(z.events), snapshot, '事件入参不可变')
  assert.equal(JSON.stringify(z.zone), zoneSnapshot, '读视图零写入')
})

pass('契约原语:canonicalJson 键序规范化与 makeHotNoteId 稳定性', () => {
  assert.equal(canonicalJson({ b: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"b":1}')
  assert.equal(canonicalJson({ a: undefined }), null, 'undefined 不猜')
  const a = makeHotNoteId({ session_ref: SESS_A, tier: 'intent', kind: 'destination', payload: { city: '大理', days: 5 } })
  const b = makeHotNoteId({ session_ref: SESS_A, tier: 'intent', kind: 'destination', payload: { days: 5, city: '大理' } })
  assert.equal(a, b, '键序无关:同语义载荷同 id(重放天然幂等)')
  assert.notEqual(a, makeHotNoteId({ session_ref: SESS_A, tier: 'intent', kind: 'destination', payload: { city: '丽江' } }))
})

console.log(`\nSESSION ZONES TESTS: ${n}/21 OK(P4-1 分区契约纯核:闭集/负面清单写侧/rev CAS/注入时钟分层 TTL/确定性 fold;全离线)`)
