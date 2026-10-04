/**
 * 会话双区记忆会话接线单测(P4-3,design/session-dual-zone-memory-design.md §5):
 *  - 总闸默认关:工具清单与注入面输出逐字节不变、零账本事件、读回空串(未知值同样关);
 *  - 捕获缝:白名单闭集内工具的结果信封只投影形状字段(verdict/条数/价格带),
 *    零名称零 URL零自由文本;证据只走指针(摘要 session_ref + 观察序号);
 *  - 负面清单端到端:证件号/手机号/URL/凭证形态的载荷永不进任何一区;
 *  - 首访读回为空;有活笔记后读回有界(条数上界 + 字符上界);
 *  - 晋升:缺 owner 原话引用拒收;模型只可提议(propose 零落账);过期源拒收;
 *  - 路由规则(§3):preference→动机闸 / trip_fact→时间线闸 / 同行人约束→同行人闸,
 *    缺路由载荷 routing_required 拒收(笔记本绝不私存该语义);既有闸拒绝即整笔回滚;
 *  - 更正即弃(drop)。
 *
 * 全离线:真实 apply() 注册面 + mkdtemp 隔离 stateRoot;零网络、零真实 LLM、
 * 零对 ts/dsh-runtime/gotry-state 的写入(用前后快照断言)。
 * 运行:cd ts && npx tsx scripts/session-zone-wiring-tests.ts
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/index.ts'
import { ensureLedger, openLedgerIfExists } from '../src/state-ledger.ts'
import { readZoneLog } from '../src/session-zone-ledger.ts'
import {
  ZONE_BRIEF_MAX_CHARS,
  ZONE_OBSERVABLE_TOOLS,
  classifyPromotionRouting,
  observeToolResult,
  projectToolObservation,
  promoteWithRouting,
  renderSessionZoneBrief,
  renderZoneBrief,
  resetZoneSessionBindingForTests,
  resolveZoneSwitch,
  routingEscapeViolation,
  zoneSessionRef,
} from '../src/session-zone-wiring.ts'
import { ZONE_EVENT_KINDS, readWorkingZone } from '../src/session-zones.ts'

let n = 0
function pass(name: string, body: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(body()).then(() => {
    console.log(`  ${++n}. ${name} OK`)
  })
}

type ToolLike = { name: string; execute?: (args: unknown, exec: unknown) => Promise<unknown> }

const roots: string[] = []
function freshRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `gotry-zone-wire-${tag}-`))
  roots.push(root)
  return root
}

/**
 * 离线检索夹具:注入 apply() 的 effect 缝,保证**绝不**触达真实 FlyAI
 * (真实路径会从 homedir/env 读 key 并可能 spawn 真实 CLI,结果随机器而变)。
 */
const fixtureEffect = (async (fx: { effect: string; params?: { kind?: string } }) => {
  if (fx.effect === 'FLYAI_SEARCH') {
    return {
      result: {
        ok: true,
        via: 'fixture',
        evidence: '[fixture:zone-wiring] offline',
        latencyMs: 0,
        verdict: 'hit',
        kind: fx.params?.kind ?? 'flight',
        options: [
          { no: 'MU5111', name: '东方航空', depDateTime: '2027-11-11T07:35:00+08:00', arrDateTime: '2027-11-11T10:05:00+08:00', price: 880, jumpUrl: 'https://flights.example.com/a' },
          { no: 'CA1234', name: '国航', depDateTime: '2027-11-11T12:35:00+08:00', arrDateTime: '2027-11-11T15:05:00+08:00', price: 1260, jumpUrl: 'https://flights.example.com/b' },
        ],
      },
      trace: { effect: fx.effect, channel: 'fixture', attempts: 1, backoffMs: 0, breaker: 'off', evidence: ['[fixture:zone-wiring]'] },
    }
  }
  return { result: null, trace: { effect: fx.effect, channel: 'fixture', attempts: 0, backoffMs: 0, breaker: 'off', evidence: ['[fixture:declined]'] } }
}) as never

/** 真实 apply() 注册面(与 smoke 同款极简 ctx:只收工具与注入变量) */
function harness(cfg: Partial<Config> & { stateRoot: string }): {
  tools: ToolLike[]
  variables: Record<string, (context?: { scope?: object }) => string>
  tool: (name: string) => ToolLike
} {
  const tools: ToolLike[] = []
  const variables: Record<string, (context?: { scope?: object }) => string> = {}
  const ctx = {
    tools: { register: (t: unknown) => tools.push(t as ToolLike) },
    systemPrompt: { variable: (name: string, provider: (context?: { scope?: object }) => string) => { variables[name] = provider } },
    get: () => undefined,
    on: () => () => {},
  } as unknown as Context
  apply(ctx, {
    timeoutMs: 30_000,
    hbcliBin: 'hbcli-not-on-path',
    sessionAccess: 'off',
    ...cfg,
  } as Config, { effect: fixtureEffect })
  return {
    tools,
    variables,
    tool: (name: string) => {
      const t = tools.find(x => x.name === name)
      if (!t) throw new Error(`tool ${name} 未注册`)
      return t
    },
  }
}

const SESSION_ID = 'dsh-session-abcdef-0123456789'
/** scope 键 = dsh agent-loop 的 ScopeKey(agent 对象身份);exec.agent 是同一对象 */
const AGENT_A = { session: { id: SESSION_ID } }
const EXEC = { agent: AGENT_A }
const SESS = zoneSessionRef(SESSION_ID)!
const SESSION_ID_B = 'dsh-session-999999-9876543210'
const AGENT_B = { session: { id: SESSION_ID_B } }
const EXEC_B = { agent: AGENT_B }
const SESS_B = zoneSessionRef(SESSION_ID_B)!
const QUOTE = '对,我以后都不坐红眼航班,记着'

function zoneEventCount(root: string): number {
  const ledger = openLedgerIfExists(root)
  if (!ledger) return 0
  return ZONE_EVENT_KINDS.reduce((sum, k) => sum + ledger.readEvents(k, 10_000).length, 0)
}

/** 产品真实状态目录快照:本套件必须对它零写入 */
const RUNTIME_STATE = join(process.cwd(), 'dsh-runtime', 'gotry-state')
function runtimeSnapshot(): string {
  if (!existsSync(RUNTIME_STATE)) return 'ABSENT'
  return readdirSync(RUNTIME_STATE).sort().map(f => {
    const s = statSync(join(RUNTIME_STATE, f))
    return `${f}:${s.size}:${s.mtimeMs}`
  }).join('|')
}
const runtimeBefore = runtimeSnapshot()

async function main(): Promise<void> {
  // ---- 总闸语义 ----
  await pass('总闸:仅明示 on 开启;缺省/未知值/大小写变体一律 fail-closed 关', () => {
    assert.equal(resolveZoneSwitch('on'), 'on')
    for (const raw of [undefined, null, '', 'off', 'ON', 'true', '1', 'enabled', 0, {}]) {
      assert.equal(resolveZoneSwitch(raw), 'off', `未知值必须关:${JSON.stringify(raw)}`)
    }
  })

  await pass('会话引用:单向摘要、不透明有界、绝不含宿主 session id 原文;无身份即无引用', () => {
    assert.ok(SESS.startsWith('s-'))
    assert.ok(SESS.length <= 64)
    assert.equal(SESS.includes(SESSION_ID), false, '摘要不得回带原文')
    assert.equal(zoneSessionRef(SESSION_ID), SESS, '同 id 同引用(确定性)')
    assert.notEqual(zoneSessionRef('other-session'), SESS)
    for (const bad of [undefined, null, '', '   ', 42]) assert.equal(zoneSessionRef(bad), null)
  })

  // ---- 关闸惰性 ----
  await pass('关闸惰性:工具清单与注入面变量清单都与基线逐项一致(关闸与 main 不可区分)', async () => {
    const offRoot = freshRoot('off')
    const off = harness({ stateRoot: offRoot })
    const onRoot = freshRoot('on')
    const on = harness({ stateRoot: onRoot, sessionZones: 'on' })
    const offNames = off.tools.map(t => t.name)
    const onNames = on.tools.map(t => t.name)
    assert.equal(offNames.includes('gotry_session_zone_note'), false, '关闸时模型看不到分区入口')
    assert.equal(offNames.includes('gotry_session_zone_promote'), false)
    assert.deepEqual(
      onNames.filter(x => !x.startsWith('gotry_session_zone')),
      offNames,
      '开关只增两件分区工具,其他工具清单逐项不变',
    )
    // 注入面:关闸时**连变量名都不得多出**——多一个名字就是可观测差异
    // (§48 benchmark-environment-bridge-tests 对产品模式变量清单逐项断言)。
    assert.deepEqual(
      Object.keys(off.variables),
      ['current_date', 'time_anchor_card', 'motivation_brief', 'channel_routing_card'],
      '关闸注入面与 main 逐项一致(session_zone_brief 未注册)',
    )
    assert.equal('session_zone_brief' in off.variables, false, '关闸不得注册分区读回变量')
    assert.equal(typeof on.variables['session_zone_brief'], 'function', '开闸才注册分区读回变量')
    assert.deepEqual(
      Object.keys(on.variables).filter(k => k !== 'session_zone_brief'),
      Object.keys(off.variables),
      '开闸只增 session_zone_brief 一个变量名,其余注入面顺序与内容不变',
    )
    assert.equal(existsSync(join(offRoot, 'gotry-state', 'gotry-state.db')), false, '关闸不得建库')
    // 其他既有注入面输出不受影响(逐字节)。channel_routing_card 内含「卡生成于 <ISO 时间戳>」,两次渲染相隔数毫秒就不同——
    // 先把 ISO 时间戳归一化再逐字节比较,否则这条断言取决于两次渲染是否落在同一毫秒(间歇性红,CI 上实测过)。
    const stripStamp = (text: string): string => text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<ts>')
    for (const key of ['current_date', 'time_anchor_card', 'motivation_brief', 'channel_routing_card']) {
      assert.equal(stripStamp(off.variables[key]!()), stripStamp(on.variables[key]!()), `既有注入面 ${key} 输出逐字节不变(时间戳归一化后)`)
    }
  })

  await pass('关闸惰性:白名单工具 execute 不被包裹——跑一次检索后账本零分区事件', async () => {
    const root = freshRoot('off-observe')
    const off = harness({ stateRoot: root })
    const search = off.tool('gotry_flyai_search')
    await search.execute!({ kind: 'flight', from: '上海', to: '大理', date: '2027-11-11' }, EXEC)
    assert.equal(zoneEventCount(root), 0, '关闸时检索不产生任何分区事件')
    const ledger = openLedgerIfExists(root)
    if (ledger) {
      const kinds = new Set(ledger.readEvents(undefined, 200).map(e => e.kind))
      for (const k of ZONE_EVENT_KINDS) assert.equal(kinds.has(k), false, `关闸不得出现 ${k}`)
    }
  })

  // ---- 捕获缝投影纯度 ----
  await pass('捕获缝:白名单闭集外零捕获;投影只含形状字段(零名称/零 URL/零自由文本)', () => {
    const base = { session_ref: SESS, turn: 3, ts: new Date().toISOString() }
    assert.deepEqual(projectToolObservation({ ...base, tool: 'gotry_motivation_save', result: { ok: true } }), [], '白名单外工具零捕获')
    assert.deepEqual(projectToolObservation({ ...base, tool: 'gotry_flyai_search', result: null }), [])
    assert.deepEqual(projectToolObservation({ ...base, tool: 'gotry_flyai_search', result: 'string' }), [])
    const result = {
      ok: true,
      verdict: 'hit',
      summary: '用户说想去大理,联系人 13800138000',
      evidence: '[实时API:flyai] https://example.com/trace?token=abc',
      options: [
        { no: 'MU5111', name: '东方航空', price: 880, jumpUrl: 'https://flights.example.com/a?uid=42' },
        { no: 'CA1234', name: '国航', price: 1260, jumpUrl: 'https://flights.example.com/b' },
      ],
    }
    const captures = projectToolObservation({ ...base, tool: 'gotry_flyai_search', result })
    assert.equal(captures.length, 2, 'availability + price_band')
    assert.deepEqual(captures.map(c => c.kind), ['availability', 'price_band'])
    assert.deepEqual(captures.map(c => c.tier), ['resource', 'resource'])
    assert.deepEqual(captures[0]!.payload, { tool: 'gotry_flyai_search', verdict: 'hit', option_count: 2 })
    assert.deepEqual(captures[1]!.payload, { tool: 'gotry_flyai_search', low: 880, high: 1260, samples: 2 })
    const serialized = JSON.stringify(captures)
    for (const forbidden of ['13800138000', 'https://', 'example.com', 'token=abc', '东方航空', '用户说想去大理']) {
      assert.equal(serialized.includes(forbidden), false, `投影不得携带:${forbidden}`)
    }
    assert.deepEqual(captures.map(c => c.evidence_ref), [{ session_ref: SESS, turn: 3 }, { session_ref: SESS, turn: 3 }], '证据只走指针')
    // 无价格的结果只产生 availability
    const miss = projectToolObservation({ ...base, tool: 'gotry_session_search', result: { ok: true, verdict: 'miss', rates: [] } })
    assert.equal(miss.length, 1)
    assert.deepEqual(miss[0]!.payload, { tool: 'gotry_session_search', verdict: 'miss', option_count: 0 })
    assert.deepEqual([...ZONE_OBSERVABLE_TOOLS].sort(), ['gotry_anything_search', 'gotry_flyai_search', 'gotry_hotel_search', 'gotry_session_search'])
  })

  await pass('开闸捕获:白名单工具跑完后 resource 层笔记落账,证据为指针,会话引用为摘要', async () => {
    const root = freshRoot('on-observe')
    const on = harness({ stateRoot: root, sessionZones: 'on' })
    const search = on.tool('gotry_flyai_search')
    const out = await search.execute!({ kind: 'flight', from: '上海', to: '大理', date: '2027-11-11' }, EXEC) as { verdict?: string }
    assert.ok(out, '工具返回值不被捕获缝改写')
    const ledger = openLedgerIfExists(root)!
    const { state } = readZoneLog(ledger)
    const notes = Object.values(state.hot)
    assert.ok(notes.length >= 1, `应落至少一条 resource 笔记:${JSON.stringify(notes)}`)
    for (const note of notes) {
      assert.equal(note.tier, 'resource')
      assert.equal(note.session_ref, SESS)
      assert.equal(note.evidence_ref.session_ref, SESS)
      assert.ok(Number.isInteger(note.evidence_ref.turn) && note.evidence_ref.turn >= 0)
      assert.equal(JSON.stringify(note).includes(SESSION_ID), false, '分区不得出现宿主 session id 原文')
    }
    // 投影出的形状来自离线夹具(两条候选 + 880/1260 价格带),不依赖任何真实供应商
    const payloads = notes.map(x => JSON.stringify(x.payload)).sort()
    assert.ok(payloads.some(p => p.includes('"option_count":2')), `应有 availability 形状:${payloads.join(' | ')}`)
    assert.ok(payloads.some(p => p.includes('"low":880') && p.includes('"high":1260')), `应有价格带形状:${payloads.join(' | ')}`)
    const serialized = JSON.stringify(notes)
    for (const forbidden of ['https://', 'example.com', '东方航空', '国航']) {
      assert.equal(serialized.includes(forbidden), false, `落账的笔记不得携带:${forbidden}`)
    }
  })

  await pass('捕获缝续命:同一检索在 TTL 之后再跑一次 → 续 TTL 并回到读视图(不被 stale_rev 吞掉)', async () => {
    const root = freshRoot('observe-touch')
    const ledger = ensureLedger(root)
    const t0 = new Date('2026-10-04T08:00:00.000Z')
    const result = { ok: true, verdict: 'hit', options: [{ no: 'MU1', price: 880 }, { no: 'CA1', price: 1260 }] }
    const first = observeToolResult(ledger, { tool: 'gotry_flyai_search', result, session_ref: SESS, ts: t0.toISOString() })
    assert.deepEqual(first, { captured: 2, touched: 0, rejected: 0 }, '首次观察:两条形状笔记诞生')
    const ids = Object.keys(readZoneLog(ledger).state.hot).sort()
    assert.equal(ids.length, 2)
    // 40 分钟后(resource 30min 已过期)同一检索再跑:必须续命,不得被默默丢掉
    const later = new Date(t0.getTime() + 40 * 60_000).toISOString()
    const second = observeToolResult(ledger, { tool: 'gotry_flyai_search', result, session_ref: SESS, ts: later })
    assert.deepEqual(second, { captured: 0, touched: 2, rejected: 0 }, '同形观察 = 续命,不是 rejected')
    assert.deepEqual(Object.keys(readZoneLog(ledger).state.hot).sort(), ids, '续命不新建主体')
    const state = readZoneLog(ledger).state
    for (const id of ids) {
      assert.equal(state.hot[id]!.rev, 2)
      assert.equal(state.hot[id]!.last_touched_at, later)
    }
    assert.equal(
      readWorkingZone(state, { now: new Date(t0.getTime() + 41 * 60_000).toISOString(), session_ref: SESS }).length,
      2,
      '续命后两条都回到读视图(未修复时这里是 0:工作区悄悄停供)',
    )
  })

  // ---- 负面清单端到端 ----
  await pass('负面清单端到端:证件号/手机号/URL/凭证形态的载荷永不进任何一区', async () => {
    const root = freshRoot('negative')
    const on = harness({ stateRoot: root, sessionZones: 'on' })
    const note = on.tool('gotry_session_zone_note')
    const payloads: Array<Record<string, unknown>> = [
      { city: '大理', id_no: '310101199001011234' },
      { city: '大理', contact: '13800138000' },
      { city: '大理', src: 'https://booking.example.com/x' },
      { city: '大理', cred: 'api_key: sk-abcdefghijklmnop' },
      { city: '大理', bearer: 'Bearer abcdefghijklmnop' },
    ]
    for (const payload of payloads) {
      const r = await note.execute!({ action: 'capture', tier: 'intent', kind: 'destination', payload }, EXEC) as { ok?: boolean; code?: string }
      assert.equal(r.ok, false, `应被拒:${JSON.stringify(payload)}`)
      assert.equal(r.code, 'negative_list', `应为负面清单码:${JSON.stringify(r)}`)
    }
    assert.equal(zoneEventCount(root), 0, '全部拒收路径零落账')
    // 合法片段照常落账
    const good = await note.execute!({ action: 'capture', tier: 'intent', kind: 'destination', payload: { city: '大理' } }, EXEC) as { ok?: boolean; note_id?: string }
    assert.equal(good.ok, true)
    assert.equal(zoneEventCount(root), 1)
  })

  // ---- 读回 ----
  await pass('读回:首访空串;有活笔记后有界(条数上界 + 字符上界);关闸即空', async () => {
    const root = freshRoot('brief')
    const on = harness({ stateRoot: root, sessionZones: 'on' })
    assert.equal(on.variables['session_zone_brief']!({ scope: AGENT_A }), '', '首访(无账本)读回空串')
    const note = on.tool('gotry_session_zone_note')
    for (const city of ['大理', '丽江', '香格里拉']) {
      await note.execute!({ action: 'capture', tier: 'intent', kind: 'destination', payload: { city } }, EXEC)
    }
    const brief = on.variables['session_zone_brief']!({ scope: AGENT_A })
    assert.ok(brief.includes('会话双区记忆'), `读回应含分区标题:${brief}`)
    assert.ok(brief.includes('大理'))
    assert.ok(brief.length <= ZONE_BRIEF_MAX_CHARS, '读回字符有界')
    // 同一账本在关闸配置下:变量压根不注册;纯函数层即便被直接调用也返回空串
    const offSame = harness({ stateRoot: root })
    assert.equal('session_zone_brief' in offSame.variables, false, '关闸即便账本里有活笔记也不注册读回变量')
    assert.equal(
      renderSessionZoneBrief({ ledger: openLedgerIfExists(root), now: new Date().toISOString(), sessionRef: SESS, zoneSwitch: 'off' }),
      '',
      '纯函数层的总闸守卫仍在(防御纵深:绕过注册点直调也读不出东西)',
    )
  })

  await pass('读回按 scope 隔离:两个会话同进程时 B 读不到 A 的 resource 层笔记(设计 §1.1)', async () => {
    const root = freshRoot('two-sessions')
    const on = harness({ stateRoot: root, sessionZones: 'on' })
    const note = on.tool('gotry_session_zone_note')
    // A 会话:一条 resource(本会话私有)+ 一条 intent(跨会话可读)
    await note.execute!({ action: 'capture', tier: 'resource', kind: 'availability', payload: { tool: 'gotry_flyai_search', verdict: 'hit', option_count: 7 } }, EXEC)
    await note.execute!({ action: 'capture', tier: 'intent', kind: 'destination', payload: { city: '大理' } }, EXEC)
    // B 会话:自己的 resource
    await note.execute!({ action: 'capture', tier: 'resource', kind: 'availability', payload: { tool: 'gotry_session_search', verdict: 'miss', option_count: 0 } }, EXEC_B)
    assert.notEqual(SESS, SESS_B)
    const briefA = on.variables['session_zone_brief']!({ scope: AGENT_A })
    const briefB = on.variables['session_zone_brief']!({ scope: AGENT_B })
    assert.ok(briefA.includes('option_count=7'), `A 读到自己的 resource:${briefA}`)
    assert.equal(briefB.includes('option_count=7'), false, 'B 绝不得读到 A 的 resource 层笔记')
    assert.ok(briefB.includes('gotry_session_search'), `B 读到自己的 resource:${briefB}`)
    assert.ok(briefA.includes('大理') && briefB.includes('大理'), 'intent 层按契约跨会话可读')
    // 无 scope(轻量宿主/未绑定)→ 不出 resource 段,fail-closed
    const briefNoScope = on.variables['session_zone_brief']!()
    assert.equal(briefNoScope.includes('本次会话查到的'), false, '取不到 scope 时不出 resource 段')
    assert.ok(briefNoScope.includes('大理'), 'intent 段仍在(跨会话可读)')
  })

  await pass('读回纯函数:条数上界生效;无会话绑定时 resource 层不出现(intent 跨会话可读)', () => {
    const now = new Date().toISOString()
    const working = Array.from({ length: 20 }, (_, i) => ({
      schema: 'session_zone_hot_note.v1' as const,
      note_id: `hn|${SESS}|intent|destination|${i}`,
      zone: 'hot_context' as const,
      tier: 'intent' as const,
      kind: 'destination' as const,
      payload: { city: `城市${i}` },
      evidence_ref: { session_ref: SESS, turn: i },
      session_ref: SESS,
      created_at: now,
      last_touched_at: now,
      ttl_expires_at: now,
      rev: 1,
    }))
    const resourceNote = { ...working[0]!, note_id: 'hn|res', tier: 'resource' as const, kind: 'availability' as const, payload: { tool: 'gotry_flyai_search', verdict: 'hit', option_count: 2 } }
    const bound = renderZoneBrief({ working: [...working, resourceNote], notebook: [], sessionRef: SESS })
    assert.ok(bound.includes('本次会话查到的'), '绑定会话时 resource 层出现')
    assert.ok(bound.length <= ZONE_BRIEF_MAX_CHARS)
    const unbound = renderZoneBrief({ working: [...working, resourceNote], notebook: [], sessionRef: null })
    assert.equal(unbound.includes('本次会话查到的'), false, '无会话绑定时 resource 层不出现')
    assert.equal(renderZoneBrief({ working: [], notebook: [], sessionRef: SESS }), '', '无活笔记 = 空串')
  })

  // ---- 晋升纪律 ----
  await pass('晋升:缺 owner 原话引用拒收;表面闭集外拒收;模型 propose 零落账', async () => {
    const root = freshRoot('promote-gate')
    const on = harness({ stateRoot: root, sessionZones: 'on' })
    const note = on.tool('gotry_session_zone_note')
    const promote = on.tool('gotry_session_zone_promote')
    const captured = await note.execute!({ action: 'capture', tier: 'intent', kind: 'budget_stance', payload: { redeye: 'never' } }, EXEC) as { note_id?: string }
    const noteId = captured.note_id!
    const before = zoneEventCount(root)
    const proposed = await note.execute!({ action: 'propose', noteId, promoteKind: 'preference' }, EXEC) as { ok?: boolean; requires_owner_confirm?: boolean }
    assert.equal(proposed.ok, true)
    assert.equal(proposed.requires_owner_confirm, true, '提议必须回「要 owner 确认」')
    assert.equal(zoneEventCount(root), before, '提议零落账:模型永不自晋升')
    // owner 引用闸(代码层类型化拒绝)
    for (const bad of [
      { noteId, kind: 'preference', ownerQuote: '', surface: 'user_reply' },
      { noteId, kind: 'preference', ownerQuote: '   ', surface: 'user_reply' },
      { noteId, kind: 'preference', ownerQuote: 'x'.repeat(201), surface: 'user_reply' },
    ]) {
      const r = await promote.execute!(bad, EXEC) as { ok?: boolean; code?: string }
      assert.equal(r.ok, false, `应被拒:${JSON.stringify(bad)}`)
      assert.equal(r.code, 'owner_confirm', `应为 owner_confirm:${JSON.stringify(r)}`)
    }
    // 闭集违规在宿主权 schema 闸即被拒(入口更前置;代码层闭集守卫是第二道)
    for (const bad of [
      { noteId, kind: 'preference', ownerQuote: QUOTE, surface: 'model_said_so' },
      { noteId, kind: 'habit', ownerQuote: QUOTE, surface: 'user_reply' },
    ]) {
      const r = await promote.execute!(bad, EXEC) as { ok?: boolean; summary?: string }
      assert.equal(r.ok, false, `应被拒:${JSON.stringify(bad)}`)
      assert.match(String(r.summary ?? ''), /invalid arguments|must be one of/, `宿主权 schema 闸应报闭集违规:${JSON.stringify(r)}`)
    }
    // 直调纯函数层:绕过宿主 schema 后闭集守卫仍在(第二道)
    const direct = promoteWithRouting(openLedgerIfExists(root), { noteId, kind: 'habit', ownerQuote: QUOTE, surface: 'user_reply', ts: new Date().toISOString() })
    assert.equal(direct.ok, false)
    assert.equal((direct as { code?: string }).code, 'closed_set')
    const directSurface = promoteWithRouting(openLedgerIfExists(root), { noteId, kind: 'preference', ownerQuote: QUOTE, surface: 'model_said_so', ts: new Date().toISOString() })
    assert.equal((directSurface as { code?: string }).code, 'closed_set')
    assert.equal(zoneEventCount(root), before, '全部拒收路径零落账')
  })

  await pass('路由分类(§3):preference→动机 / trip_fact→时间线 / 点名同行人的约束→同行人 / 其余→笔记本', () => {
    assert.equal(classifyPromotionRouting('preference', {}), 'motivation')
    assert.equal(classifyPromotionRouting('trip_fact', {}), 'timeline')
    assert.equal(classifyPromotionRouting('constraint', { companion_label: '爸爸' }), 'companion')
    assert.equal(classifyPromotionRouting('constraint', { companion: '妈妈' }), 'companion')
    assert.equal(classifyPromotionRouting('constraint', { redeye: 'never' }), 'notebook')
    assert.equal(classifyPromotionRouting('lesson', {}), 'notebook')
  })

  await pass('路由 fail-closed:命中既有语义但缺路由载荷 → routing_required,零落账', async () => {
    const root = freshRoot('routing-required')
    const on = harness({ stateRoot: root, sessionZones: 'on' })
    const note = on.tool('gotry_session_zone_note')
    const promote = on.tool('gotry_session_zone_promote')
    const pref = await note.execute!({ action: 'capture', tier: 'intent', kind: 'budget_stance', payload: { redeye: 'never' } }, EXEC) as { note_id?: string }
    const trip = await note.execute!({ action: 'capture', tier: 'intent', kind: 'destination', payload: { city: '大理', visited: true } }, EXEC) as { note_id?: string }
    const comp = await note.execute!({ action: 'capture', tier: 'intent', kind: 'party_size', payload: { companion_label: '爸爸', adults: 2 } }, EXEC) as { note_id?: string }
    const before = zoneEventCount(root)
    for (const bad of [
      { noteId: pref.note_id, kind: 'preference', ownerQuote: QUOTE, surface: 'user_reply' },
      { noteId: pref.note_id, kind: 'preference', ownerQuote: QUOTE, surface: 'user_reply', motivation: {} },
      { noteId: trip.note_id, kind: 'trip_fact', ownerQuote: QUOTE, surface: 'user_reply' },
      { noteId: comp.note_id, kind: 'constraint', ownerQuote: QUOTE, surface: 'user_reply' },
    ]) {
      const r = await promote.execute!(bad, EXEC) as { ok?: boolean; code?: string }
      assert.equal(r.ok, false, `应被拒:${JSON.stringify(bad)}`)
      assert.equal(r.code, 'routing_required', `应 routing_required:${JSON.stringify(r)}`)
    }
    assert.equal(zoneEventCount(root), before, '路由缺料零落账:笔记本不私存该语义')
    const ledger = openLedgerIfExists(root)!
    assert.equal(Object.keys(readZoneLog(ledger).state.notebook).length, 0)
  })

  await pass('路由逃逸:换个 kind 或抹掉 companion_label 都绕不过既有闸(模型选的 kind 不构成豁免)', async () => {
    const root = freshRoot('routing-escape')
    const on = harness({ stateRoot: root, sessionZones: 'on' })
    const note = on.tool('gotry_session_zone_note')
    const promote = on.tool('gotry_session_zone_promote')
    const ledger = ensureLedger(root)
    // ① 持久偏好声明成 lesson:源笔记 kind=budget_stance 属动机语义 → 拒
    const pref = await note.execute!({ action: 'capture', tier: 'intent', kind: 'budget_stance', payload: { redeye: 'never' } }, EXEC) as { note_id?: string }
    const asLesson = await promote.execute!({ noteId: pref.note_id, kind: 'lesson', ownerQuote: QUOTE, surface: 'user_reply' }, EXEC) as { ok?: boolean; code?: string; summary?: string }
    assert.equal(asLesson.ok, false, '偏好换 kind=lesson 必须被拒')
    assert.equal(asLesson.code, 'routing_required')
    assert.match(String(asLesson.summary), /budget_stance|motivation/)
    // ② 同行人约束抹掉 companion_label:载荷仍带 health → 拒
    const comp = await note.execute!({ action: 'capture', tier: 'intent', kind: 'destination', payload: { city: '大理' } }, EXEC) as { note_id?: string }
    const strippedLabel = await promote.execute!({ noteId: comp.note_id, kind: 'constraint', ownerQuote: QUOTE, surface: 'user_reply', payload: { health: ['晕车'] } }, EXEC) as { ok?: boolean; code?: string }
    assert.equal(strippedLabel.ok, false, '抹掉 companion_label 仍不得绕过同行人闸')
    assert.equal(strippedLabel.code, 'routing_required')
    // ③ 备了动机载荷却声明成 constraint:路由载荷与分类不符 → 拒
    const mismatch = await promote.execute!({ noteId: comp.note_id, kind: 'constraint', ownerQuote: QUOTE, surface: 'user_reply', payload: { quiet: true }, motivation: { hard: { wake_not_before: '07:00' } } }, EXEC) as { ok?: boolean; code?: string }
    assert.equal(mismatch.ok, false)
    assert.equal(mismatch.code, 'routing_required')
    assert.equal(Object.keys(readZoneLog(ledger).state.notebook).length, 0, '三条逃逸路径零笔记本条目')
    assert.equal(ledger.readMotivation(), null, '零动机写入')
    // 纯函数层同口径(无源权威语义的 lesson 正常通过)
    assert.equal(routingEscapeViolation({ kind: 'lesson', authority: 'notebook', payload: { lesson: 'too_tight' }, sourceKind: 'availability' }), null)
    assert.ok(routingEscapeViolation({ kind: 'lesson', authority: 'notebook', payload: { weights: { x: 1 } }, sourceKind: 'availability' }))
    assert.equal(routingEscapeViolation({ kind: 'preference', authority: 'motivation', payload: { weights: { x: 1 } }, sourceKind: 'budget_stance' }), null, '已走权威路由的不算逃逸')
  })

  await pass('动机闸拒绝即整笔回滚:被拒的偏好晋升不得留下笔记本条目(saved 二义性不可信)', async () => {
    const root = freshRoot('motivation-refused')
    const on = harness({ stateRoot: root, sessionZones: 'on' })
    const note = on.tool('gotry_session_zone_note')
    const promote = on.tool('gotry_session_zone_promote')
    const ledger = ensureLedger(root)
    // 先用同一条原话把 homeCity 写进画像:之后换城市但复用**同一条**原话 →
    // mergeProfile 判为「无新证据」拒收,且 saved:false 不带任何 reason。
    ledger.appendMotivationPatch({ homeCity: '上海', homeCityEvidence: QUOTE, evidence: [QUOTE] })
    assert.equal(ledger.readMotivation()?.homeCityPreference?.value, '上海')
    const captured = await note.execute!({ action: 'capture', tier: 'intent', kind: 'budget_stance', payload: { home: 'moved' } }, EXEC) as { note_id?: string }
    const zoneBefore = zoneEventCount(root)
    const r = await promote.execute!({ noteId: captured.note_id, kind: 'preference', ownerQuote: QUOTE, surface: 'user_reply', motivation: { homeCity: '北京' } }, EXEC) as { ok?: boolean; code?: string; summary?: string }
    assert.equal(r.ok, false, `动机闸未落地该断言时必须拒绝整笔:${JSON.stringify(r)}`)
    assert.equal(r.code, 'routed_rejected')
    assert.equal(ledger.readMotivation()?.homeCityPreference?.value, '上海', '画像未被改写')
    assert.equal(zoneEventCount(root), zoneBefore, '笔记本零新事件(同事务回滚)')
    assert.equal(Object.keys(readZoneLog(ledger).state.notebook).length, 0)
    // 带新证据的同一断言则正常落地
    const freshQuote = '我搬到北京了,以后默认从北京出发'
    const ok2 = await promote.execute!({ noteId: captured.note_id, kind: 'preference', ownerQuote: freshQuote, surface: 'user_reply', motivation: { homeCity: '北京' } }, EXEC) as { ok?: boolean; authority?: string; routed?: { applied?: boolean } }
    assert.equal(ok2.ok, true, JSON.stringify(ok2))
    assert.equal(ok2.routed?.applied, true)
    assert.equal(ledger.readMotivation()?.homeCityPreference?.value, '北京')
  })

  await pass('路由落地:preference 经动机闸 / trip_fact 经时间线闸 / 约束经同行人闸,笔记本同事务记断言+血缘', async () => {
    const root = freshRoot('routing-apply')
    const on = harness({ stateRoot: root, sessionZones: 'on' })
    const note = on.tool('gotry_session_zone_note')
    const promote = on.tool('gotry_session_zone_promote')
    const ledger = ensureLedger(root)

    const pref = await note.execute!({ action: 'capture', tier: 'intent', kind: 'budget_stance', payload: { redeye: 'never' } }, EXEC) as { note_id?: string }
    const prefOut = await promote.execute!({ noteId: pref.note_id, kind: 'preference', ownerQuote: QUOTE, surface: 'user_reply', motivation: { hard: { wake_not_before: '07:00' } } }, EXEC) as { ok?: boolean; authority?: string; routed?: { applied?: boolean } }
    assert.equal(prefOut.ok, true, JSON.stringify(prefOut))
    assert.equal(prefOut.authority, 'motivation')
    assert.equal(prefOut.routed?.applied, true, '动机闸真的落地(单一写权威)')
    const profile = ledger.readMotivation()
    assert.deepEqual(profile?.hard, { wake_not_before: '07:00' }, '硬约束进动机画像')
    assert.ok(profile?.evidence?.includes(QUOTE), '动机证据 = owner 原话')

    const trip = await note.execute!({ action: 'capture', tier: 'intent', kind: 'destination', payload: { city: '大理', visited: true } }, EXEC) as { note_id?: string }
    const tripOut = await promote.execute!({ noteId: trip.note_id, kind: 'trip_fact', ownerQuote: QUOTE, surface: 'user_reply', trip: { destination: '大理', start: '2026-10-01', end: '2026-10-05' } }, EXEC) as { ok?: boolean; authority?: string; routed?: { applied?: boolean; ref?: string } }
    assert.equal(tripOut.ok, true, JSON.stringify(tripOut))
    assert.equal(tripOut.authority, 'timeline')
    assert.equal(ledger.readTrips().length, 1, '行程进时间线')
    assert.equal(ledger.readTrips()[0]!.evidence, QUOTE)

    const comp = await note.execute!({ action: 'capture', tier: 'intent', kind: 'party_size', payload: { companion_label: '爸爸', adults: 2 } }, EXEC) as { note_id?: string }
    const compOut = await promote.execute!({ noteId: comp.note_id, kind: 'constraint', ownerQuote: QUOTE, surface: 'approval_card', companion: { label: '爸爸', constraints: { health: ['晕车'] } } }, EXEC) as { ok?: boolean; authority?: string }
    assert.equal(compOut.ok, true, JSON.stringify(compOut))
    assert.equal(compOut.authority, 'companion')
    assert.deepEqual(ledger.readCompanions().map(c => c.label), ['爸爸'], '约束进同行人档案')

    const notebook = Object.values(readZoneLog(ledger).state.notebook)
    assert.equal(notebook.length, 3, '三条笔记本条目(断言 + 血缘)')
    for (const entry of notebook) {
      assert.equal(entry.owner_confirm.quote, QUOTE)
      assert.equal(entry.origin.session_ref, SESS, '血缘指向源会话')
      assert.ok(entry.origin.note_id, '血缘指向源笔记')
    }
    // 纯教训留在笔记本自身(源笔记 kind 无既有权威语义、载荷无权威形状键)
    const lessonNote = await note.execute!({ action: 'capture', tier: 'resource', kind: 'availability', payload: { lesson: 'too_tight' } }, EXEC) as { note_id?: string }
    const lessonOut = await promote.execute!({ noteId: lessonNote.note_id, kind: 'lesson', ownerQuote: QUOTE, surface: 'user_reply' }, EXEC) as { ok?: boolean; authority?: string; routed?: unknown }
    assert.equal(lessonOut.ok, true, JSON.stringify(lessonOut))
    assert.equal(lessonOut.authority, 'notebook')
    assert.equal(lessonOut.routed, null, 'notebook 路由无外部权威写')
  })

  await pass('路由拒绝即整笔回滚:时间线闸冲突 → 笔记本零条目、时间线零新行', async () => {
    const root = freshRoot('routing-rollback')
    const on = harness({ stateRoot: root, sessionZones: 'on' })
    const note = on.tool('gotry_session_zone_note')
    const promote = on.tool('gotry_session_zone_promote')
    const ledger = ensureLedger(root)
    ledger.appendTripEvent({ destination: '大理', start: '2026-10-01', end: '2026-10-05', source: 'user-verbatim', evidence: '去年去过大理' })
    const trips = ledger.readTrips().length
    const captured = await note.execute!({ action: 'capture', tier: 'intent', kind: 'destination', payload: { city: '大理' } }, EXEC) as { note_id?: string }
    const zoneBefore = zoneEventCount(root)
    const r = await promote.execute!({ noteId: captured.note_id, kind: 'trip_fact', ownerQuote: QUOTE, surface: 'user_reply', trip: { destination: '大理', start: '2026-10-03', end: '2026-10-08' } }, EXEC) as { ok?: boolean; code?: string; summary?: string }
    assert.equal(r.ok, false, `重叠行程应被时间线闸拒绝:${JSON.stringify(r)}`)
    assert.equal(r.code, 'routed_rejected')
    assert.equal(ledger.readTrips().length, trips, '时间线零新行')
    assert.equal(zoneEventCount(root), zoneBefore, '笔记本零新事件(同事务回滚)')
    assert.equal(Object.keys(readZoneLog(ledger).state.notebook).length, 0)
  })

  await pass('更正即弃:drop 后出读视图;过期源不得晋升(同一过期纯函数)', async () => {
    const root = freshRoot('drop')
    const on = harness({ stateRoot: root, sessionZones: 'on' })
    const note = on.tool('gotry_session_zone_note')
    const captured = await note.execute!({ action: 'capture', tier: 'intent', kind: 'destination', payload: { city: '大理' } }, EXEC) as { note_id?: string }
    const dropped = await note.execute!({ action: 'drop', noteId: captured.note_id }, EXEC) as { ok?: boolean; appended?: boolean }
    assert.equal(dropped.ok, true)
    assert.equal(dropped.appended, true)
    const ledger = openLedgerIfExists(root)!
    assert.equal(Object.keys(readZoneLog(ledger).state.hot).length, 0, 'drop 后出状态')
    // 过期源:注入未来时钟判定(晋升纯函数层的 source_expired)
    const relive = await note.execute!({ action: 'capture', tier: 'resource', kind: 'availability', payload: { tool: 'gotry_flyai_search', verdict: 'hit', option_count: 1 } }, EXEC) as { note_id?: string }
    const future = new Date(Date.now() + 61 * 60_000).toISOString()
    const expired = promoteWithRouting(ledger, { noteId: relive.note_id!, kind: 'lesson', ownerQuote: QUOTE, surface: 'user_reply', ts: future })
    assert.equal(expired.ok, false)
    assert.equal((expired as { code?: string }).code, 'source_expired', `过期源必须拒收:${JSON.stringify(expired)}`)
  })

  await pass('CAS 修订经工具面:stale_rev 拒收;正确父 rev 推进到 rev 2', async () => {
    const root = freshRoot('cas')
    const on = harness({ stateRoot: root, sessionZones: 'on' })
    const note = on.tool('gotry_session_zone_note')
    const captured = await note.execute!({ action: 'capture', tier: 'intent', kind: 'destination', payload: { city: '大理' } }, EXEC) as { note_id?: string }
    const stale = await note.execute!({ action: 'revise', noteId: captured.note_id, expectedRev: 5, payload: { city: '丽江' } }, EXEC) as { ok?: boolean; code?: string }
    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'stale_rev')
    const good = await note.execute!({ action: 'revise', noteId: captured.note_id, expectedRev: 1, payload: { city: '丽江' } }, EXEC) as { ok?: boolean; appended?: boolean }
    assert.equal(good.ok, true)
    assert.equal(good.appended, true)
    const ledger = openLedgerIfExists(root)!
    assert.equal(readZoneLog(ledger).state.hot[captured.note_id!]!.rev, 2)
  })

  await pass('无会话身份:分区工具 fail-closed 拒绝(不记忆无主体片段),零落账', async () => {
    const root = freshRoot('no-session')
    const on = harness({ stateRoot: root, sessionZones: 'on' })
    const note = on.tool('gotry_session_zone_note')
    const r = await note.execute!({ action: 'capture', tier: 'intent', kind: 'destination', payload: { city: '大理' } }, { agent: {} }) as { ok?: boolean; code?: string }
    assert.equal(r.ok, false)
    assert.equal(r.code, 'bad_session')
    assert.equal(zoneEventCount(root), 0)
  })

  assert.equal(runtimeSnapshot(), runtimeBefore, '本套件必须对 ts/dsh-runtime/gotry-state 零写入(产品真实状态)')
  console.log(`\nSESSION ZONE WIRING TESTS: ${n}/21 OK(P4-3 会话接线:默认关惰性/捕获缝形状投影/负面清单端到端/读回有界/propose 零落账/owner 引用闸/§3 路由 fail-closed 与同事务回滚;隔离 stateRoot,全离线)`)
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => {
    resetZoneSessionBindingForTests()
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })
