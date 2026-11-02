/**
 * 证据日期绑定回归(rc.33 行程实测 2026-11-01;run-all §39 第二行):
 *
 * 根反例(两例都是午夜前后的红眼):
 *   - 去程:✅ 小节「出境(迪拜 → 上海,12/1)」下写 `QR1019` 22:50 ¥5747——这条行情来自
 *     11/30 的查询(11/30 22:50 → 12/1 14:40);12/1 从未查过,12/2 那班是 ¥4515。
 *   - 回程:✅ 小节「回程(深圳 → 迪拜,12/17 00:45)」下写 `EK329` ¥2568——查到的是
 *     12/16 00:45 出发(同日 05:20 到);12/17 从未查过。
 * 那一轮过了 TURN_DEADLINE_SOFT,模型没调 gotry_fact_gate 就 write + present 了产物,
 * 也没有任何别的面把证据日期绑到行程日期(内核闸的 claim 抽取读不出 12/1,同号事实
 * 不论哪天都算可回溯)。
 *
 *  §1 出发日解析:12/1、12月1日、ISO 都能读;到达日(→ 12/2 14:40)、元数据日
 *     (2026-11-01 查询 / 实证)、区间标题(2026-12-01 → 12-16)不冒充出发日;
 *     日期只从祖先标题继承,不从兄弟标题串过来
 *  §2 纯规则 checkEvidenceDateBinding:两例逐条点名(行日期 + 证据日),含相邻日期票价指纹、
 *     无日期的 ✅ 行、被改日期的事实锚点行
 *  §3 产品缝:真实 apply() 的 tools/pre-execute 链拒绝 write/present(md 与 html 两种产物);
 *     注册的 gotry_fact_gate 报告里并入同一规则
 *  §4 截止模式:越过硬截止后普通工具已被拒,present 仍可调用——闸照样拒坏产物、放行好产物
 *  §5 不误伤:R2 修正版(含 ❌ 勘误表)、未标记的备选行、非文档扩展名、结构化渲染 HTML
 *
 * 运行(在 ts/ 下):npx tsx scripts/evidence-date-binding-tests.ts
 * 隔离:mkdtemp stateRoot/cwd;不碰 ts/dsh-runtime/gotry-state。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { appendFacts } from '../capabilities/fact-log.ts'
import { renderFlightFact, type FlightFact } from '../src/bookable-facts.ts'
import { checkEvidenceDateBinding, flightEvidenceRows, type EvidenceDateViolation } from '../src/evidence-date-binding.ts'
import { apply } from '../src/index.ts'
import { renderItineraryHtml } from '../src/itinerary-html.ts'
import { EK329_1216, EK329_1217, map, R1_FACTS, R1_HTML, R1_MD, R2_MD, TODAY } from './fixtures/rc33-evidence-date-fixtures.ts'

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

function lineOf(text: string, needle: string): number {
  return text.split('\n').findIndex(l => l.includes(needle)) + 1
}
function bind(markdown: string, facts: FlightFact[] = R1_FACTS): EvidenceDateViolation[] {
  return checkEvidenceDateBinding(markdown, facts, map, { today: TODAY })
}

// ---------------------------------------------------------------------------
console.log('§1 出发日解析(12/1 / 12月1日 / ISO;到达日、元数据日、区间标题不冒充出发日)')
{
  const rows = flightEvidenceRows(R1_MD, map, { today: TODAY })
  const at = (no: string, needle: string) => rows.find(c => c.flight_no === no && c.line === lineOf(R1_MD, needle))
  const qr = at('QR1019', '`QR1019` 22:50 → 12/2')
  assert(qr?.date === '2026-12-01',
    `QR1019 ✅ 行的出发日 = 标题「12/1」(行内 → 12/2 14:40 是到达日,不得冒充):得到 ${qr?.date}`)
  const ek = at('EK329', '`EK329` 00:45 → 05:20')
  assert(ek?.date === '2026-12-17', `EK329 ✅ 行的出发日 = 标题「12/17 00:45」:得到 ${ek?.date}`)
  const c9 = at('9C6481', '`9C6481`')
  assert(c9?.date === '2026-12-02', `行内「12/2」优先于标题:得到 ${c9?.date}`)
  const skeleton = at('QR1019', '| 12/1 | 二 |')
  assert(skeleton?.date === '2026-12-01', `表格行首日期「12/1」:得到 ${skeleton?.date}`)
  const nextStep = rows.filter(c => c.line === lineOf(R1_MD, '1. 订 **迪拜→上海'))
  assert(nextStep.find(c => c.flight_no === 'QR1019')?.date === '2026-12-01' && nextStep.find(c => c.flight_no === 'EK329')?.date === '2026-12-17',
    `一行两段时各航班取自己前面最近的日期(QR1019→12/1、EK329→12/17):得到 ${nextStep.map(c => `${c.flight_no}=${c.date}`).join(',')}`)

  // 元数据日与区间标题:「（2026-11-01 查询）」「2026-12-01 → 12-16」都不是出发日;日期只从祖先标题继承
  const undated = flightEvidenceRows('# 行程（2026-12-01 → 12-16）\n## 实时班次（2026-11-01 查询）\n### ✅ 国内段\n- `9C6481` 06:40→12:05 ¥859', map, { today: TODAY })
  assert(undated[0]?.date === undefined,
    `查询日/区间标题不被当作出发日继承(否则 ✅ 行会被错绑到 11/1 或 12/1):得到 ${undated[0]?.date}`)
  const sibling = flightEvidenceRows('### ✅ 回程（12/17）\n- `EK329` 00:45 ¥2568\n### ✅ 国内段\n- `9C6481` 06:40 ¥859', map, { today: TODAY })
  assert(sibling.find(c => c.flight_no === '9C6481')?.date === undefined,
    `兄弟标题的日期不串到下一节:得到 ${sibling.find(c => c.flight_no === '9C6481')?.date}`)
  const nested = flightEvidenceRows('## 12/16 周三\n### ✅ 航班\n- `EK329` 00:45 ¥2568', map, { today: TODAY })
  assert(nested[0]?.date === '2026-12-16', `祖先标题的日期向下继承:得到 ${nested[0]?.date}`)
  const zh = flightEvidenceRows('### ✅ 出境（迪拜 → 上海，12月1日）\n- `QR1019` 22:50 ¥5747', map, { today: TODAY })
  assert(zh[0]?.date === '2026-12-01', `中文「12月1日」:得到 ${zh[0]?.date}`)
  const iso = flightEvidenceRows('- 2027-01-05 `EK329` 00:45 ¥2568 ✅', map, { today: TODAY })
  assert(iso[0]?.date === '2027-01-05', `ISO 日期用其自带年份:得到 ${iso[0]?.date}`)
  const nextYear = flightEvidenceRows('- 1/5 `EK329` 00:45 ¥2568 ✅', map, { today: TODAY })
  assert(nextYear[0]?.date === '2027-01-05', `无年份的月/日取今天之后最近的一次(1/5 → 2027):得到 ${nextYear[0]?.date}`)
}

// ---------------------------------------------------------------------------
console.log('§2 纯规则:两例被 checkEvidenceDateBinding 逐条点名')
{
  const dv = bind(R1_MD)
  const at = (needle: string) => dv.filter(v => v.line === lineOf(R1_MD, needle))
  const qr = at('`QR1019` 22:50 → 12/2')
  assert(qr.length === 1 && qr[0]!.kind === 'evidence_date_mismatch' && qr[0]!.detail.includes('2026-12-01')
    && qr[0]!.detail.includes('2026-11-30') && qr[0]!.detail.includes('2026-12-02') && qr[0]!.detail.includes('¥4515'),
    `去程:QR1019 标 ✅ 于 12/1,证据日只有 11/30(¥5747)与 12/2(¥4515)→ evidence_date_mismatch:${qr[0]?.detail ?? '(无)'}`)
  const ek = at('`EK329` 00:45 → 05:20')
  assert(ek.length === 1 && ek[0]!.kind === 'evidence_date_mismatch' && ek[0]!.detail.includes('2026-12-17')
    && ek[0]!.detail.includes('2026-12-16') && /SZX→DXB 2026-12-17[^;]*从未/.test(ek[0]!.detail),
    `回程:EK329 标 ✅ 于 12/17,证据是 12/16 00:45 那班,12/17 从未查询 → evidence_date_mismatch:${ek[0]?.detail ?? '(无)'}`)
  assert(at('`EK302` 03:10 → 15:05').some(v => v.kind === 'evidence_date_mismatch'),
    '同节的 EK302 也被抓(12/1 从未查询,证据在 11/30 与 12/2)')
  assert(dv.some(v => v.line === lineOf(R1_MD, '1. 订 **迪拜→上海') && v.detail.startsWith('EK329')),
    '「下一步」的订票行写明票价 ¥2568 + 12/17:没有 ✅ 也算引用证据,同样被抓')
  assert(!dv.some(v => v.line === lineOf(R1_MD, '1. 订 **迪拜→上海') && /^(?:QR1019|EK302) /.test(v.detail)),
    '票价只归属它自己航班的窗口:同一行 EK329 的 ¥2568 不算到 QR1019/EK302 头上(这两班未标 ✅、未写票价)')
  assert(at('`9C6481`').length === 0 && at('`9C8672`').length === 0,
    '同日事实且同价的 ✅ 行(9C6481 12/2 ¥859、9C8672 12/15 ¥730)不误伤')
  assert(at('若坐 `EK302`').length === 0, '未标 ✅、不写票价的备选叙述行不归本规则管')

  // 相邻日期票价指纹:同日事实存在,但行内票价来自另一天
  const sf = bind('### ✅ 回程（深圳 → 迪拜，12/17 00:45）\n- `EK329` 00:45 → 05:20 迪拜，**直飞 ¥2568**', [...R1_FACTS, ...EK329_1217])
  assert(sf.length === 1 && sf[0]!.kind === 'evidence_date_mismatch' && sf[0]!.detail.includes('¥2568') && sf[0]!.detail.includes('2026-12-16') && sf[0]!.detail.includes('¥2615'),
    `R2 补查 12/17(¥2615)后仍写 12/16 的 ¥2568 → evidence_date_mismatch:${sf[0]?.detail ?? '(无)'}`)
  assert(bind('### ✅ 回程（深圳 → 迪拜，12/17 00:45）\n- `EK329` 00:45 → 05:20 迪拜，**直飞 ¥2615**', [...R1_FACTS, ...EK329_1217]).length === 0, '改成 12/17 自己的 ¥2615 后通过')
  assert(bind('- 哈尔滨→深圳 12/15：`9C8672` 11:25→17:40 **¥840** ✅').some(v => v.detail.includes('¥840') && v.detail.includes('2026-12-14')),
    '9C8672 写 12/15 却用 12/14 的 ¥840 → 被抓')

  // 无日期的 ✅ 行:不能绑定到任何一天 → fail closed
  const ud = bind('### ✅ 回程\n- `EK329` 00:45 → 05:20 ¥2568')
  assert(ud.length === 1 && ud[0]!.kind === 'verified_flight_undated' && ud[0]!.detail.includes('2026-12-16'),
    `无出发日期的 ✅ 航班行 → verified_flight_undated(提示证据日 2026-12-16):${ud[0]?.detail ?? '(无)'}`)

  // 声称边界:降级(⚠️ 未核验)与用户自有资源(已订)不算声称;「不得改签」这类票规不是降级
  assert(bind('- 12/17 `EK329` 00:45 ¥2568 ⚠️ 未核验').length === 0, '降级为「⚠️ 未核验」的行不判')
  assert(bind('- 12/17 `EK329` 00:45 ¥2568 ✅ 已订(用户自有)').length === 0, '用户已订的航班(已订)不要求注册表事实')
  assert(bind('- 12/17 `EK329` 00:45 ¥2568 ✅(不得改签)').some(v => v.detail.startsWith('EK329')),
    '「不得改签」是票规不是降级:✅ 行照样被判')
  // 航班号按整 token 定位:EK329 不落在同一行更早的 EK3290 里(否则会借到 EK3290 前面的 12/17)
  assert(!bind('- 12/17 `EK3290` ¥100 ✅；12/16 `EK329` 00:45 ¥2568 ✅').some(v => v.detail.startsWith('EK329 ')),
    'EK329 取它自己前面的 12/16,不误判')

  // 事实锚点行:锚点引用的事实出发日必须等于该行日期(改了可见日期保留锚点 = 伪绑定)
  const anchored = renderFlightFact(EK329_1216)
  assert(bind(anchored).length === 0,
    '渲染原语生成的锚点行(日期 = 事实日期)通过')
  assert(bind(`### ✅ 回程（12/17）\n${anchored.replace('2026-12-16', '12/17')}`).some(v => v.kind === 'evidence_date_mismatch' && v.detail.includes(`fact:${EK329_1216.fact_id}`)),
    '锚点行可见日期被改成 12/17 → evidence_date_mismatch(点名锚点事实)')
}

// ---------------------------------------------------------------------------
// 产品缝:真实 apply() 装载,按 dsh 顺序跑 tools/pre-execute 瀑布 → tools/execute 瀑布

type Handler = (...args: never[]) => unknown
interface Plugin {
  dispatch: (name: string, args: Record<string, unknown>, sessionId?: string) => Promise<
    | { stage: 'pre-execute'; reason: string; info?: { code?: string } }
    | { stage: 'execute'; result: { executed?: boolean; isError?: boolean; error?: { info?: { code?: string } } } }>
  emit: (event: string, ...args: unknown[]) => void
  tool: (name: string) => { execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }
}

function loadPlugin(stateRoot: string, cwd: string): Plugin {
  const handlers = new Map<string, Handler[]>()
  const registered: Array<{ name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }> = []
  const ctx = {
    tools: { register: (tool: (typeof registered)[number]) => { registered.push(tool) } },
    systemPrompt: { section: () => undefined, variable: () => undefined },
    on: (event: string, fn: Handler, opts?: { prepend?: boolean }) => {
      const list = handlers.get(event) ?? []
      if (opts?.prepend) list.unshift(fn)
      else list.push(fn)
      handlers.set(event, list)
      return () => undefined
    },
  } as unknown as Context
  apply(ctx, { stateRoot, timeoutMs: 30_000, hbcliBin: 'hbcli-not-on-path', sessionAccess: 'off' },
    { clock: () => new Date(`${TODAY}T12:00:00Z`) })
  const waterfall = async (event: string, exec: unknown, terminal: () => Promise<unknown>): Promise<unknown> => {
    const list = (handlers.get(event) ?? []) as Array<(exec: unknown, next: () => Promise<unknown>) => Promise<unknown>>
    const run = (i: number): Promise<unknown> => (i < list.length ? Promise.resolve(list[i]!(exec, () => run(i + 1))) : terminal())
    return run(0)
  }
  return {
    async dispatch(name, args, sessionId = 'session-a') {
      const exec = {
        name,
        arguments: args,
        callId: `call-${name}`,
        token: {},
        signal: new AbortController().signal,
        agent: { id: `agent-${sessionId}`, session: { id: sessionId, header: { cwd } } },
      }
      const gate = await waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' })) as { kind: string; reason?: string; info?: { code?: string } }
      if (gate.kind === 'deny') return { stage: 'pre-execute', reason: gate.reason ?? '', info: gate.info }
      const result = await waterfall('tools/execute', exec, async () => ({ executed: true })) as { executed?: boolean }
      return { stage: 'execute', result }
    },
    emit(event, ...args) {
      for (const fn of handlers.get(event) ?? []) (fn as (...a: unknown[]) => unknown)(...args)
    },
    tool(name) {
      const found = registered.find(t => t.name === name)
      if (!found) throw new Error(`插件装载后未找到 ${name}`)
      return found
    },
  }
}

const home = mkdtempSync(join(tmpdir(), 'gotry-evidence-date-'))
const stateRoot = join(home, 'state')
const cwd = join(home, 'workspace')
mkdirSync(stateRoot, { recursive: true })
mkdirSync(cwd, { recursive: true })
const savedSoft = process.env.GOTRY_TURN_DEADLINE_SOFT_MS
const savedHard = process.env.GOTRY_TURN_DEADLINE_HARD_MS

try {
  await appendFacts(stateRoot, R1_FACTS)
  writeFileSync(join(cwd, 'plan-r1.md'), R1_MD)
  writeFileSync(join(cwd, 'plan-r1.html'), R1_HTML)
  writeFileSync(join(cwd, 'plan-r2.md'), R2_MD)
  writeFileSync(join(cwd, 'notes.md'), '# 备忘\n- 酒店待定\n- 档期待确认\n')

  // ---------------------------------------------------------------------------
  console.log('§3 产品缝:真实 apply() 的 tools/pre-execute 拒绝 write/present')
  {
    const plugin = loadPlugin(stateRoot, cwd)
    const writeR1 = await plugin.dispatch('write', { file_path: 'artifacts/plan-r1.md', content: R1_MD })
    assert(writeR1.stage === 'pre-execute' && writeR1.info?.code === 'EVIDENCE_DATE_BINDING',
      `write R1 markdown 在执行前被拒(info.code=EVIDENCE_DATE_BINDING):stage=${writeR1.stage}`)
    const reason = writeR1.stage === 'pre-execute' ? writeR1.reason : ''
    assert(/QR1019[^\n]*2026-12-01/.test(reason) && /EK329[^\n]*2026-12-17/.test(reason) && reason.includes('L'),
      `拒绝理由逐行点名两例(QR1019 → 2026-12-01、EK329 → 2026-12-17)并给行号:${reason.slice(0, 240)}`)
    const writeHtml = await plugin.dispatch('write', { file_path: 'artifacts/plan-r1.html', content: R1_HTML })
    assert(writeHtml.stage === 'pre-execute' && writeHtml.info?.code === 'EVIDENCE_DATE_BINDING'
      && /QR1019/.test(writeHtml.reason) && /EK329/.test(writeHtml.reason) && !/9C6481/.test(writeHtml.reason),
      `write R1 HTML 同样被拒(标题 h2「实证」覆盖下级表格行;9C6481 同日同价不点名):${writeHtml.stage === 'pre-execute' ? writeHtml.reason.slice(0, 200) : writeHtml.stage}`)
    const presentR1 = await plugin.dispatch('present', { files: [{ path: 'plan-r1.html' }, { path: join(cwd, 'plan-r1.md') }] })
    assert(presentR1.stage === 'pre-execute' && presentR1.info?.code === 'EVIDENCE_DATE_BINDING'
      && presentR1.reason.includes('plan-r1.html') && presentR1.reason.includes('plan-r1.md'),
      `present 磁盘上的 R1 两件产物(相对 + 绝对路径)被拒,理由点名两个文件:${presentR1.stage}`)
    const writeR2 = await plugin.dispatch('write', { file_path: 'artifacts/plan-r2.md', content: R2_MD })
    assert(writeR2.stage === 'execute', 'write R2 修正版放行(含 ❌ 勘误表引用的 R1 错行)')
    const presentR2 = await plugin.dispatch('present', { files: [{ path: 'plan-r2.md' }, { path: 'notes.md' }] })
    assert(presentR2.stage === 'execute', 'present R2 修正版 + 无航班备忘放行')

    // 模型主动调用的 gotry_fact_gate:报告并入同一规则(无 tripYear 时按宿主今天解析 12/1)
    type FactGateReport = { verdict?: string; violations?: Array<{ kind: string; line: number; detail: string }> }
    const factGate = plugin.tool('gotry_fact_gate')
    const toolExec = { agent: { session: { header: { cwd } } } }
    const gated = await factGate.execute({ path: 'plan-r1.md' }, toolExec) as FactGateReport
    const gatedDates = (gated.violations ?? []).filter(v => v.kind === 'evidence_date_mismatch')
    assert(gated.verdict === 'blocked'
      && gatedDates.some(v => v.line === lineOf(R1_MD, '`QR1019` 22:50 → 12/2') && v.detail.includes('2026-12-01'))
      && gatedDates.some(v => v.line === lineOf(R1_MD, '`EK329` 00:45 → 05:20') && v.detail.includes('2026-12-17')),
      `gotry_fact_gate(path=plan-r1.md,不传 tripYear)报告里有两例的 evidence_date_mismatch:${gatedDates.length} 条`)
    const gatedHtml = await factGate.execute({ path: 'plan-r1.html' }, toolExec) as FactGateReport
    assert(gatedHtml.verdict === 'blocked' && (gatedHtml.violations ?? []).filter(v => v.kind === 'evidence_date_mismatch').length === 2,
      'gotry_fact_gate(path=plan-r1.html)先做 HTML 文本投影,两例同样被点名')
    const gatedR2 = await factGate.execute({ path: 'plan-r2.md' }, toolExec) as FactGateReport
    assert(!(gatedR2.violations ?? []).some(v => v.kind === 'evidence_date_mismatch' || v.kind === 'verified_flight_undated'),
      'gotry_fact_gate 对 R2 修正版不报证据日期违例')
  }

  // ---------------------------------------------------------------------------
  console.log('§4 截止模式:越过硬截止后 present 仍可调用,闸照样生效')
  {
    process.env.GOTRY_TURN_DEADLINE_SOFT_MS = '1'
    process.env.GOTRY_TURN_DEADLINE_HARD_MS = '2'
    const plugin = loadPlugin(stateRoot, cwd)
    plugin.emit('session/event', { id: 'session-late' }, { type: 'turn/start', data: { turn: 1 } })
    await new Promise(resolve => setTimeout(resolve, 25))
    const research = await plugin.dispatch('gotry_flyai_search', { kind: 'flight', from: '深圳', to: '迪拜', date: '2026-12-17' }, 'session-late')
    assert(research.stage === 'execute' && research.result.isError === true && research.result.error?.info?.code === 'TURN_DEADLINE_EXHAUSTED',
      '前提:已过硬截止——研究类工具被 TURN_DEADLINE_EXHAUSTED 拒绝')
    const presentBad = await plugin.dispatch('present', { files: [{ path: 'plan-r1.md' }] }, 'session-late')
    assert(presentBad.stage === 'pre-execute' && presentBad.info?.code === 'EVIDENCE_DATE_BINDING',
      '截止后 present 坏产物:被证据日期闸拒(截止闸放行 present,但 pre-execute 闸不看时钟)')
    const presentGood = await plugin.dispatch('present', { files: [{ path: 'plan-r2.md' }] }, 'session-late')
    assert(presentGood.stage === 'execute' && presentGood.result.executed === true,
      '截止后 present 修正版:证据闸与截止闸都放行,交付不被卡死')
  }
  process.env.GOTRY_TURN_DEADLINE_SOFT_MS = savedSoft ?? ''
  process.env.GOTRY_TURN_DEADLINE_HARD_MS = savedHard ?? ''
  if (savedSoft === undefined) delete process.env.GOTRY_TURN_DEADLINE_SOFT_MS
  if (savedHard === undefined) delete process.env.GOTRY_TURN_DEADLINE_HARD_MS

  // ---------------------------------------------------------------------------
  console.log('§5 不误伤:非文档扩展名、结构化渲染 HTML、无 ✅ 无票价的叙述')
  {
    const plugin = loadPlugin(stateRoot, cwd)
    const code = await plugin.dispatch('write', { file_path: 'scratch/check.ts', content: `// ✅ QR1019 12/1 ¥5747\nexport {}\n` })
    assert(code.stage === 'execute', '非文档扩展名(.ts)不过本闸')
    const prose = await plugin.dispatch('write', { file_path: 'draft.md', content: '## 备选\n- 若坐 EK302 03:10，12/2 的一半就在飞机上\n- QR1019 晚班更顺\n' })
    assert(prose.stage === 'execute', '未标 ✅、不写票价的航班叙述放行')
    const structured = renderItineraryHtml({
      title: '结构化行程',
      itinerary: { trip_start: '2026-12-01', trip_end: '2026-12-17', stays: [], od_segments: [{ from: 'SZX', to: 'DXB', date: '2026-12-17', mode: 'flight', legs: 1 }] },
      facts: [EK329_1216],
    })
    assert(structured.ok, '结构化渲染器产出 HTML')
    if (structured.ok) {
      writeFileSync(join(cwd, 'gotry-itinerary-structured.html'), structured.html)
      const presented = await plugin.dispatch('present', { files: [{ path: 'gotry-itinerary-structured.html' }] })
      assert(presented.stage === 'execute', '结构化渲染 HTML(事实按自身日期投影,计划段 12/17 无匹配事实)放行')
    }
    const missing = await plugin.dispatch('present', { files: [{ path: 'does-not-exist.md' }] })
    assert(missing.stage === 'execute', '不存在的文件交给 present 自己报错,本闸不吞错误')
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nEVIDENCE DATE BINDING TESTS: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
