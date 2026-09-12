/**
 * 行程 HTML 产物生成入口的注册工具 E2E(issue #442,父 #438)。
 *
 * 真实执行面:在隔离临时 stateRoot 下 `apply(ctx, config)` 装载 gotry-tools 插件,
 * 取**注册定义** `gotry_itinerary_render` 的 execute 直调(与本仓库既有
 * registered-e2e 同构),exec 上下文给出真实会话 cwd。事实经 `appendFacts` 写入
 * 隔离注册表(<stateRoot>/gotry-state/bookable-facts.jsonl),生成入口只能从那里取。
 *
 * 覆盖(镜像 issue #442 产品生成入口验收面):
 *   1. 空 fact_ids = 明确未核验计划:落盘成功、无整体「已验证」徽章、无写入 stateRoot;
 *   2. 选中 3 条事实:落盘字节 == 同输入渲染器输出(事实顺序/内容均由注册表决定);
 *   3. 未知 id / 重复 id / 超量 id 一律拒绝且零写入;
 *   4. 登记行畸形 → 渲染器显式拒绝,零写入;
 *   5. 调用方自带 facts 对象不被接受(空列表不投影、伪造 id 走未知 id 拒绝);
 *   6. 显式 basename 撞车不覆盖(字节不变);
 *   7. 符号链接目标不被改写(排除链接逃逸);
 *   8. basename 路径分隔符 / 越级 / 错误前缀 / 超长 / 绝对路径全部拒绝,仓外零文件;
 *   9. 会话 cwd 位于 .git/node_modules 段或不存在 → 拒绝;
 *  10. 随机默认名符合契约且两次不同;同一输入两次生成字节一致(确定性);
 *  11. 畸形 title/itinerary/fact_ids 类型 → 拒绝且零写入;
 *  12. 缺失/空对象/空串/纯空白/非字符串/相对的会话 cwd → 工具层与能力层都 fail closed,
 *      进程 cwd 零新增文件(绝不回落 process.cwd());
 *  13. 真实产出链路(注册工具):生成 → gotry_artifacts_list 在册同一路径 → gotry_artifacts_read
 *      以 html 源码文本读回,内容与落盘字节逐字一致、version 与磁盘 sha256 一致。
 * 全部合成事实,无用户真实行程;不启动 dsh 宿主、无网络、无供应商调用。
 *
 * 运行(在 ts/ 下):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/itinerary-artifact-tests.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, lstatSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import {
  BOOKABLE_FACT_SCHEMA,
  type BookableFact,
  type FlightFact,
  type HotelFact,
  type PolicyFact,
} from '../src/bookable-facts.ts'
import { appendFacts, loadFactRegistry } from '../capabilities/fact-log.ts'
import { generateItineraryArtifact } from '../capabilities/itinerary-artifact.ts'
import { renderItineraryHtml } from '../src/itinerary-html.ts'
import { ITINERARY_ARTIFACT_BASENAME_RE } from '../capabilities/itinerary-artifact.ts'

let pass = 0
let fail = 0
const failures: string[] = []

function ok(cond: boolean, msg: string): void {
  if (cond) {
    pass++
    return
  }
  fail++
  failures.push(msg)
}

interface ToolDef {
  name: string
  description: string
  /** 注册后被投影成 JSON Schema(与模型可见契约同一份) */
  parameters: { required?: string[]; properties?: Record<string, { type?: string; items?: { type?: string } }> }
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

interface ArtifactResult {
  ok?: boolean
  path?: string
  basename?: string
  bytes?: number
  fact_ids?: string[]
  overall_verified?: boolean
  error?: string
  hint?: string
  errors?: string[]
  summary?: string
}

const TITLE = '合成行程:深圳 → 普吉(内部切片夹具)'
const ITINERARY = {
  trip_start: '2027-07-16',
  trip_end: '2027-07-24',
  stays: [{ place: '普吉岛', check_in: '2027-07-17', check_out: '2027-07-21' }],
  od_segments: [{ from: 'SZX', to: 'HKT', date: '2027-07-17', mode: 'flight', legs: 1 }],
}
const FLIGHT_ID = 'i442flight0001'
const HOTEL_ID = 'i442hotel0001'
const POLICY_ID = 'i442policy0001'

const FLIGHT: FlightFact = {
  schema: BOOKABLE_FACT_SCHEMA,
  fact_id: FLIGHT_ID,
  kind: 'flight',
  route: { origin: 'SZX', destination: 'HKT', origin_airport: 'SZX', dest_airport: 'HKT' },
  date: '2027-07-17',
  flight_no: 'CZ6061',
  marketing_carrier: '南方航空',
  dep_local: '09:20',
  arr_local: '12:05',
  nonstop: true,
  price: 1680,
  currency: 'CNY',
  tier: 'live_inventory',
  bookability: 'bookable_exact_date',
  source: 'session:ctrip-flight',
  query_id: 'session:ctrip-flight:flight:SZX-HKT:2027-07-17',
  fetched_at: '2026-09-12T02:10:03.000Z',
  as_of: '2026-09-12',
}

const HOTEL: HotelFact = {
  schema: BOOKABLE_FACT_SCHEMA,
  fact_id: HOTEL_ID,
  kind: 'hotel',
  destination: '普吉岛',
  check_in: '2027-07-17',
  check_out: '2027-07-21',
  verdict: 'hit',
  bookability: 'bookable_exact_date',
  options_masked: 37,
  source: 'flyai-hotel',
  query_id: 'hotel:flyai-hotel:普吉岛:2027-07-17_2027-07-21',
  fetched_at: '2026-09-12T02:20:00.000Z',
  as_of: '2026-09-12',
  tier: 'live_inventory',
}

const POLICY: PolicyFact = {
  schema: BOOKABLE_FACT_SCHEMA,
  fact_id: POLICY_ID,
  kind: 'policy',
  subject: '泰国免签',
  statement: '中国护照可免签入境停留不超过 30 天(以落地执行口径为准)',
  source: 'flyai',
  query_id: 'flyai:policy:泰国免签',
  fetched_at: '2026-09-12T02:30:00.000Z',
  as_of: '2026-09-12',
  review_by: '2027-06-17',
}

function loadTools(stateRoot: string): Map<string, ToolDef> {
  assert.ok(stateRoot.startsWith(tmpdir()), 'stateRoot 必须是隔离临时根(绝不触真实 stateRoot)')
  const registered: ToolDef[] = []
  const ctx = {
    tools: { register: (t: unknown) => { registered.push(t as ToolDef) } },
    systemPrompt: { variable: () => { /* 本测试不消费 persona 变量 */ } },
    on: () => () => { /* 授权闸/守卫注册即忽略:execute 直调不走 pre-execute */ },
  } as unknown as Context
  apply(ctx, { stateRoot, timeoutMs: 30_000, hbcliBin: 'hbcli-not-on-path', sessionAccess: 'ask' } as never)
  return new Map(registered.map(t => [t.name, t]))
}

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).filter(n => n.endsWith('.html')).sort()
}

function renderHtml(facts: BookableFact[]): string {
  const r = renderItineraryHtml({ title: TITLE, itinerary: ITINERARY, facts })
  assert.ok(r.ok, `对照渲染必须成功:${r.ok ? '' : JSON.stringify(r.errors)}`)
  return r.ok ? r.html : ''
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gotry-442-artifact-'))
  const stateRoot = join(home, 'state')
  const cwd = join(home, 'workspace')
  const outside = join(home, 'outside')
  for (const d of [stateRoot, cwd, outside]) mkdirSync(d, { recursive: true })
  const outsideFile = join(outside, 'target.html')
  writeFileSync(outsideFile, 'DO NOT TOUCH', 'utf-8')

  const tools = loadTools(stateRoot)
  const tool = tools.get('gotry_itinerary_render')
  assert.ok(tool, 'gotry_itinerary_render 必须已注册')
  if (!tool) {
    console.log('\nITINERARY ARTIFACT TESTS: 0 pass, 1 fail')
    console.log('  - 工具未注册')
    process.exit(1)
  }
  const exec = { agent: { session: { header: { cwd } } } }
  const run = async (args: Record<string, unknown>, execCtx: unknown = exec): Promise<ArtifactResult> =>
    await tool!.execute(args, execCtx) as ArtifactResult

  // ---- §1 模型可见契约(fact_ids 必填、空数组合法) ----
  const params = tool.parameters
  ok(params.required?.includes('fact_ids') === true, '§1a fact_ids 是必填参数')
  ok(params.properties?.fact_ids?.type === 'array' && params.properties?.fact_ids?.items?.type === 'string',
    '§1b fact_ids 是字符串数组参数')
  ok(params.required?.includes('title') === true, '§1c title 必填')
  ok(params.required?.includes('itinerary') === true, '§1d itinerary 必填')
  ok(params.required?.includes('basename') !== true, '§1e basename 可选')
  ok(/registry/i.test(tool.description), '§1f 描述声明事实只从注册表取')
  ok(/never overwrites/i.test(tool.description), '§1g 描述声明绝不覆盖')

  // ---- §2 事实登记进隔离注册表 ----
  ok(await appendFacts(stateRoot, [FLIGHT, HOTEL, POLICY]), '§2a 合成事实写入隔离注册表')
  const registry = await loadFactRegistry(stateRoot)
  ok(registry.length === 3, `§2b 注册表读回 3 条(实测 ${registry.length})`)
  ok(htmlFiles(cwd).length === 0, '§2c 生成前工作目录无 html')

  // ---- §3 空 fact_ids = 明确未核验计划 ----
  const empty = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [] })
  ok(empty.ok === true, `§3a 空 fact_ids 合法(实际:${JSON.stringify(empty.error ?? '')})`)
  ok(empty.overall_verified === false, '§3b 结果显式声明无整体「已验证」结论')
  ok(htmlFiles(cwd).length === 1, `§3c 落盘 1 个 html(实测 ${htmlFiles(cwd).length})`)
  const emptyPath = String(empty.path ?? '')
  ok(emptyPath.endsWith(String(empty.basename)), '§3d 返回最终真实路径')
  const emptyDisk = readFileSync(emptyPath, 'utf-8')
  ok(emptyDisk === renderHtml([]), '§3e 落盘字节 == 同输入渲染器输出')
  ok(empty.bytes === Buffer.byteLength(emptyDisk, 'utf8'), '§3f bytes 与磁盘字节一致')
  ok(emptyDisk.split('class="badge ok"').length - 1 === 0, '§3g 空事实文档没有任何 ok 徽章')
  ok(emptyDisk.includes('共 0 条事实'), '§3h 文档显式陈述 0 条事实')
  ok(emptyDisk.includes('该段没有匹配的已注册事实'), '§3i 计划段显式标注未核验')
  ok(!emptyDisk.includes('<script'), '§3j 产物无 script')
  ok(!emptyDisk.includes('http://') && !emptyDisk.includes('https://'), '§3k 产物无远端资源')
  ok(htmlFiles(stateRoot).length === 0, '§3l stateRoot 下不写 html(只写会话工作目录)')

  // ---- §4 选中注册表事实:字节与渲染器一致,按调用方顺序选中 ----
  const selected = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [FLIGHT_ID, HOTEL_ID, POLICY_ID] })
  ok(selected.ok === true, `§4a 已注册 id 选中成功(实际:${JSON.stringify(selected.error ?? '')})`)
  const selectedDisk = readFileSync(String(selected.path), 'utf-8')
  ok(selectedDisk === renderHtml([FLIGHT, HOTEL, POLICY]), '§4b 落盘字节 == 注册表选出的 3 条事实的渲染输出')
  ok(selectedDisk.split('class="badge ok"').length - 1 > 0, '§4c 逐条事实带可下单徽章(非整体徽章)')
  for (const id of [FLIGHT_ID, HOTEL_ID, POLICY_ID]) ok(selectedDisk.includes(id), `§4d 事实 ${id} 在产物中可见`)
  ok(selectedDisk.includes('独立记录:目的地级酒店事实'), '§4e 酒店证据独立成区(不冒充某家酒店可订)')
  ok(Array.isArray(selected.fact_ids) && selected.fact_ids.join(',') === [FLIGHT_ID, HOTEL_ID, POLICY_ID].join(','),
    '§4f 结果回显选中顺序')
  const reversed = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [POLICY_ID, FLIGHT_ID, HOTEL_ID] })
  ok(reversed.ok === true && reversed.bytes === selected.bytes, '§4g 顺序变化不改变文档字节(确定性投影)')

  // ---- §5 未知 id 拒绝,零写入 ----
  const before5 = htmlFiles(cwd).length
  const unknown = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: ['i442notthere'] })
  ok(unknown.ok === false && String(unknown.error).includes('i442notthere'), '§5a 未知 id 显式拒绝并回显 id')
  ok(htmlFiles(cwd).length === before5, '§5b 未知 id 零写入')

  // ---- §6 重复 id 拒绝,零写入 ----
  const dup = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [FLIGHT_ID, FLIGHT_ID] })
  ok(dup.ok === false && /重复/.test(String(dup.error)), '§6a 重复 id 拒绝')
  ok(htmlFiles(cwd).length === before5, '§6b 重复 id 零写入')

  // ---- §7 超量 id 拒绝,零写入 ----
  const many = Array.from({ length: 201 }, (_, i) => `i442bulk${i}`)
  const over = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: many })
  ok(over.ok === false && /容量上限/.test(String(over.error)), '§7a 超量 id 拒绝')
  ok(htmlFiles(cwd).length === before5, '§7b 超量 id 零写入')

  // ---- §8 登记行畸形 → 渲染器拒绝,零写入 ----
  const malformed = { ...HOTEL, fact_id: 'i442malformed01', verdict: 'hit', options_masked: 'many' }
  ok(await appendFacts(stateRoot, [malformed as unknown as BookableFact]), '§8a 畸形登记行写入注册表')
  const malformedRun = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: ['i442malformed01'] })
  ok(malformedRun.ok === false, '§8b 畸形登记行不渲染成功')
  ok(Array.isArray(malformedRun.errors) && malformedRun.errors.length > 0, '§8c 畸形行给出结构化 errors(渲染器校验)')
  ok(htmlFiles(cwd).length === before5, '§8d 畸形行零写入')

  // ---- §9 调用方自带 facts 不被接受 ----
  const forgedId = 'i442forged0001'
  const callerFacts = await run({
    title: TITLE,
    itinerary: ITINERARY,
    fact_ids: [],
    facts: [{ schema: BOOKABLE_FACT_SCHEMA, fact_id: forgedId, kind: 'flight' }],
  })
  ok(callerFacts.ok === true, '§9a 额外的 facts 字段不影响空列表生成')
  ok(!readFileSync(String(callerFacts.path), 'utf-8').includes(forgedId), '§9b 调用方自带事实对象不被投影')
  const forged = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [forgedId] })
  ok(forged.ok === false, '§9c 伪造 id(只存在于调用方入参)按未知 id 拒绝')
  ok(htmlFiles(cwd).length === before5 + 1, '§9d 仅 §9a 新增一个文件')

  // ---- §10 显式 basename 撞车不覆盖 ----
  const named = 'gotry-itinerary-2027-phuket.html'
  const first = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [FLIGHT_ID], basename: named })
  ok(first.ok === true && first.basename === named, '§10a 合法 basename 生成成功')
  const namedPath = join(cwd, named)
  const namedBytes = readFileSync(namedPath, 'utf-8')
  const second = await run({ title: '合成行程:第二次(不应覆盖)', itinerary: ITINERARY, fact_ids: [FLIGHT_ID], basename: named })
  ok(second.ok === false && /拒绝覆盖/.test(String(second.error)), '§10b 同名第二次拒绝覆盖')
  ok(readFileSync(namedPath, 'utf-8') === namedBytes, '§10c 既有产物字节未被改写')

  // ---- §11 符号链接目标不被改写 ----
  const linkName = 'gotry-itinerary-link.html'
  symlinkSync(outsideFile, join(cwd, linkName))
  const linked = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [FLIGHT_ID], basename: linkName })
  ok(linked.ok === false, '§11a 指向别处的符号链接不被跟随写入')
  ok(readFileSync(outsideFile, 'utf-8') === 'DO NOT TOUCH', '§11b 链接目标字节未被改写')
  ok(lstatSync(join(cwd, linkName)).isSymbolicLink(), '§11c 链接本身未被替换')

  // ---- §12 basename 路径与命名契约 ----
  const before12 = htmlFiles(cwd).length
  const rejectNames = [
    '../../evil.html',
    'sub/evil.html',
    'sub\\evil.html',
    join(outside, 'evil.html'),
    'evil.html',
    'gotry-itinerary-.html',
    'gotry-itinerary-2027-phuket.HTML',
    `gotry-itinerary-${'a'.repeat(70)}.html`,
    'gotry-itinerary-2027 phuket.html',
  ]
  for (const name of rejectNames) {
    const r = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [], basename: name })
    ok(r.ok === false, `§12a basename 拒绝:${name}`)
  }
  ok(htmlFiles(cwd).length === before12, `§12b 拒绝的 basename 未产生文件(实测 ${htmlFiles(cwd).length})`)
  ok(!readdirSync(outside).includes('evil.html'), '§12c 仓外无越级文件')

  // ---- §13 会话 cwd 边界 ----
  for (const bad of [join(stateRoot, 'node_modules'), join(home, '.git'), join(home, 'nope')]) {
    mkdirSync(join(stateRoot, 'node_modules'), { recursive: true })
    mkdirSync(join(home, '.git'), { recursive: true })
    const r = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [] }, { agent: { session: { header: { cwd: bad } } } })
    ok(r.ok === false, `§13a 受限/不存在的 cwd 拒绝:${bad}`)
  }
  ok(readdirSync(join(home, '.git')).length === 0, '§13b .git 段零写入')
  ok(readdirSync(join(stateRoot, 'node_modules')).length === 0, '§13c node_modules 段零写入')

  // ---- §14 随机默认名 + 真实路径 ----
  const r1 = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [] })
  const r2 = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [] })
  ok(r1.ok === true && r2.ok === true, '§14a 默认随机名连续生成成功')
  ok(ITINERARY_ARTIFACT_BASENAME_RE.test(String(r1.basename)), '§14b 随机名符合命名契约')
  ok(r1.basename !== r2.basename, '§14c 连续两次随机名不同')
  ok(String(r1.path) === join(realpathSync(cwd), String(r1.basename)), '§14d 返回路径 = 会话工作目录(realpath)+ basename')

  // ---- §15 畸形输入拒绝,零写入 ----
  const before15 = htmlFiles(cwd).length
  const invalid: Array<Record<string, unknown>> = [
    { title: TITLE, itinerary: ITINERARY },
    { title: TITLE, itinerary: ITINERARY, fact_ids: 'not-an-array' },
    { title: TITLE, itinerary: ITINERARY, fact_ids: [42] },
    { title: TITLE, itinerary: ITINERARY, fact_ids: [''] },
    { itinerary: ITINERARY, fact_ids: [] },
    { title: TITLE, fact_ids: [] },
    { title: TITLE, itinerary: { ...ITINERARY, trip_start: '2027-02-30' }, fact_ids: [] },
    { title: TITLE, itinerary: { ...ITINERARY, od_segments: [{ from: 'SZX', to: 'HKT', date: '2027-07-17', mode: 'teleport', legs: 1 }] }, fact_ids: [] },
  ]
  for (const [i, args] of invalid.entries()) {
    const r = await run(args)
    ok(r.ok === false, `§15a 畸形输入 ${i} 拒绝`)
  }
  ok(htmlFiles(cwd).length === before15, `§15b 畸形输入零写入(实测 ${htmlFiles(cwd).length})`)

  // ---- §16 会话 cwd 非法一律 fail closed(零写入,绝不回落进程 cwd) ----
  const procCwdBefore = readdirSync(process.cwd()).sort().join(',')
  const badExecs: Array<[string, unknown]> = [
    ['缺 exec', undefined],
    ['空对象 exec', {}],
    ['无 session', { agent: {} }],
    ['无 header', { agent: { session: {} } }],
    ['header 无 cwd', { agent: { session: { header: {} } } }],
    ['cwd 空串', { agent: { session: { header: { cwd: '' } } } }],
    ['cwd 纯空白', { agent: { session: { header: { cwd: '   ' } } } }],
    ['cwd 非字符串', { agent: { session: { header: { cwd: 42 } } } }],
    ['cwd 相对路径', { agent: { session: { header: { cwd: 'relative/workspace' } } } }],
  ]
  for (const [label, badExec] of badExecs) {
    const r = await tool!.execute({ title: TITLE, itinerary: ITINERARY, fact_ids: [] }, badExec) as ArtifactResult
    ok(r.ok === false, `§16a 非法会话 cwd 拒绝:${label}`)
    ok(/会话工作目录/.test(String(r.error)), `§16b 拒绝原因是会话工作目录缺失/非法:${label}`)
  }
  ok(readdirSync(process.cwd()).sort().join(',') === procCwdBefore, '§16c 进程 cwd 零新增文件')

  // ---- §16d 直接调用能力层同样 fail closed(不依赖工具层守卫) ----
  for (const bad of ['', '   ', undefined as unknown as string]) {
    const r = await generateItineraryArtifact({ title: TITLE, itinerary: ITINERARY, fact_ids: [] }, { stateRoot, cwd: bad })
    ok(r.ok === false && /会话工作目录/.test(String(r.error)), `§16e 能力层拒绝 cwd=${JSON.stringify(bad)}`)
  }
  ok(readdirSync(process.cwd()).sort().join(',') === procCwdBefore, '§16f 能力层非法 cwd 零写入进程 cwd')

  // ---- §17 真实产出链路:注册工具生成 → gotry_artifacts_list → gotry_artifacts_read(#441 已在 main) ----
  const listTool = tools.get('gotry_artifacts_list')
  const readTool = tools.get('gotry_artifacts_read')
  ok(Boolean(listTool && readTool), '§17a 产物 list/read 注册工具可用')
  const chainName = 'gotry-itinerary-e2e-chain.html'
  const chain = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [FLIGHT_ID, HOTEL_ID], basename: chainName })
  ok(chain.ok === true, `§17b 生成成功(实际:${JSON.stringify(chain.error ?? '')})`)
  const chainDisk = readFileSync(String(chain.path), 'utf-8')

  const listed = await listTool!.execute({ limit: 50 }, exec) as { artifacts?: Array<{ id?: string; path?: string; source?: string; bytes?: number }> }
  const entry = (listed.artifacts ?? []).find(a => a.id === chainName)
  ok(Boolean(entry), '§17c list 在册发现生成的 HTML(同一文件)')
  ok(entry?.source === 'cwd-file', '§17d 来源为会话工作目录文件')
  ok(realpathSync(String(entry?.path)) === String(chain.path), '§17e list 路径解析到生成返回的同一真实路径')
  ok(entry?.bytes === Buffer.byteLength(chainDisk, 'utf8'), '§17f list 字节数与磁盘一致')

  const read = await readTool!.execute({ path: String(entry?.path) }, exec) as { ok?: boolean; lang?: string; content?: string; version?: string; totalLines?: number }
  ok(read.ok === true, `§17g read 成功(实际:${JSON.stringify((read as { error?: string }).error ?? '')})`)
  ok(read.lang === 'html', '§17h read 以 html 源码文本读出')
  ok(read.content === chainDisk, '§17i read 内容与落盘字节逐字一致')
  ok(read.version === createHash('sha256').update(chainDisk).digest('hex').slice(0, 12), '§17j content version 与磁盘 sha256 指纹一致')
  ok(read.content === renderHtml([FLIGHT, HOTEL]), '§17k 读回内容 == 注册表选中事实的渲染输出')

  rmSync(home, { recursive: true, force: true })

  console.log(`\nITINERARY ARTIFACT TESTS: ${pass} pass, ${fail} fail`)
  if (fail > 0) {
    console.log('\nFAILURES:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

await main()
