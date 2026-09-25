/**
 * 行程 deck 静态导出 bundle 注册工具 E2E(issue #568,Phase B 切片 3a;
 * QR 真矩阵编码独立为 issue #569 切片 3b)。
 *
 * 真实执行面:在隔离临时 stateRoot 下 `apply(ctx, config)` 装载 gotry-tools 插件,
 * 取**注册定义** `gotry_deck_export` 的 execute 直调,exec 上下文给出真实 target_dir。
 * 事实经 `appendFacts` 写入隔离注册表,导出入口只能从那里取。
 *
 * 覆盖(对照切片 2 验收面 + bundle 三件齐落盘断言):
 *   1. 空 fact_ids = 明确未核验 bundle:三件齐落盘,manifest 计数 0,无整体「已验证」徽章;
 *   2. 选中 3 条事实:三件齐落盘;manifest.sha256 = 磁盘 deck sha256;bytes 与磁盘一致;
 *      source_tags/by_kind/evidence_chain 全部如实统计;
 *   3. 未知 id / 重复 id / 超量 id 一律拒绝且零字节(target_dir 零新增文件);
 *   4. 登记行畸形 → 渲染器拒绝,零字节;
 *   5. 调用方自带 facts 不被接受;
 *   6. bundle 已有任一文件(manifest.json / html / qr.svg)→ 拒绝覆盖,零字节;
 *   7. 符号链接目标不被改写(target_dir 指向别处的链接即拒);
 *   8. basename 路径分隔符/越级/超长全部拒绝,target_dir 外零文件;
 *   9. target_dir 位于 .git/node_modules 段或不存在 → 拒绝;
 *  10. 随机默认 bundle basename 符合契约且两次不同;确定性:同输入两次 bundle html 字节一致;
 *  11. 畸形 title/itinerary/fact_ids → 拒绝且零字节;
 *  12. target_dir 非法一律 fail closed(零字节,绝不回落 process cwd);
 *  13. QR 真矩阵(issue #569 切片 3b 落地):`qr.svg` 是合法 SVG、含真实 QR 路径(path 元素 + viewBox + width/height);有 target_url 时编码它,无 target_url 时编码 local bundle 占位串;manifest.share_intent.qr = 'generated';
 *  14. target_url 记录在 manifest;超长 URL 拒绝;
 *  15. 真实链路:三件文件都被 `gotry_artifacts_list` 发现、`gotry_artifacts_read` 以 html
 *      源码读回 deck html 与磁盘一致、sha256 与 manifest.deck.sha256 一致。
 *  16. QR 独立解码验收(#569 T2):**实际落盘的 qr.svg** 经 sharp(libvips)光栅化 +
 *      jsqr(独立解码器,Apache-2.0,与编码侧 qrcode 库零共享代码)解码,逐字节还原
 *      payload——ASCII URL / UTF-8 URL / 字面本地占位串 × 128/240/480px 全矩阵;不同
 *      payload 经解码器还原后互不相等(负控制)。期望占位串在测试侧独立钉死为审批
 *      字面量,§22r 把生产常量与之互锁(漂移即红)。
 *  17. manifest.local_only 显式指示(#569 的 local_only 期望,以 v1 兼容附加字段落地):
 *      无 target_url → true(绝不暗示线上目的地),有 target_url → false;与
 *      target_url 缺省、QR 本地占位串三态互锁。
 * 全部合成事实,无用户真实行程;不启动 dsh 宿主、无网络、无供应商调用。
 *
 * 运行(在 ts/ 下):
 *   PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsx scripts/itinerary-deck-export-tests.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, lstatSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import jsQRDefault from 'jsqr'
import sharp from 'sharp'

import { apply } from '../src/index.ts'
import {
  BOOKABLE_FACT_SCHEMA,
  type BookableFact,
  type FlightFact,
  type HotelFact,
  type PolicyFact,
} from '../src/bookable-facts.ts'
import { appendFacts, loadFactRegistry } from '../capabilities/fact-log.ts'
import { generateItineraryDeckExport } from '../capabilities/itinerary-deck-export.ts'
import {
  ITINERARY_DECK_EXPORT_BASENAME_RE,
  ITINERARY_DECK_EXPORT_HTML_SUFFIX,
  ITINERARY_DECK_EXPORT_LOCAL_MARKER,
  ITINERARY_DECK_EXPORT_MANIFEST_SUFFIX,
  ITINERARY_DECK_EXPORT_QR_SUFFIX,
} from '../capabilities/itinerary-deck-export.ts'

let pass = 0
let fail = 0
const failures: string[] = []

// jsqr@1.4.0 的 d.ts 在本项目 skipLibCheck 下 default export 解析退化(default 被当成
// 模块命名空间);运行时(tsx/CJS interop)default 就是函数。这里显式钉住运行时契约。
const jsQR = jsQRDefault as unknown as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string; binaryData: number[] } | null

function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; return }
  fail++
  failures.push(msg)
  throw new Error(`断言失败: ${msg}`)
}

interface ToolDef {
  name: string
  description: string
  parameters: { required?: string[]; properties?: Record<string, { type?: string; items?: { type?: string } }> }
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

interface ExportResult {
  ok?: boolean
  target_dir?: string
  basename?: string
  files?: { html?: string; manifest?: string; qr?: string }
  bytes?: number
  fact_ids?: string[]
  overall_verified?: boolean
  error?: string
  hint?: string
  errors?: string[]
  summary?: string
}

const TITLE = '合成行程:深圳 → 普吉(切片 3a 夹具)'
const ITINERARY = {
  trip_start: '2027-07-16',
  trip_end: '2027-07-24',
  stays: [
    { place: '普吉岛', check_in: '2027-07-17', check_out: '2027-07-21' },
    { place: '甲米', check_in: '2027-07-21', check_out: '2027-07-23' },
  ],
  od_segments: [
    { from: '广州南', to: '深圳北', date: '2027-07-16', mode: 'rail', legs: 1 },
    { from: 'SZX', to: 'HKT', date: '2027-07-17', mode: 'flight', legs: 1 },
    { from: 'HKT', to: 'BKK', date: '2027-07-21', mode: 'flight', legs: 2 },
  ],
}
const FLIGHT_ID = 'i568flight0001'
const HOTEL_ID = 'i568hotel0001'
const POLICY_ID = 'i568policy0001'

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

function bundleFiles(dir: string): string[] {
  return readdirSync(dir).sort()
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** 独立解码链(#569 T2):qr.svg 字节 → sharp(libvips)光栅化到 size×size → jsqr 解码。
 * 解码器(jsqr)与编码器(qrcode 库)零共享代码;识别不出返回 null。
 * 返回 data 为解码字符串,bytes 为原始 UTF-8 字节(QR byte 模式原样还原)。 */
async function decodeQrSvg(svgText: string, size: number): Promise<{ data: string; bytes: Uint8Array } | null> {
  const raster = await sharp(Buffer.from(svgText, 'utf-8')).resize(size, size).raw().toBuffer({ resolveWithObject: true })
  const pixels = new Uint8ClampedArray(raster.data)
  const decoded = jsQR(pixels, raster.info.width, raster.info.height)
  if (!decoded) return null
  return { data: decoded.data, bytes: new Uint8Array(decoded.binaryData) }
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gotry-568-export-'))
  const stateRoot = join(home, 'state')
  const cwd = join(home, 'workspace')
  const outside = join(home, 'outside')
  for (const d of [stateRoot, cwd, outside]) mkdirSync(d, { recursive: true })
  const outsideFile = join(outside, 'target.html')
  writeFileSync(outsideFile, 'DO NOT TOUCH', 'utf-8')

  const tools = loadTools(stateRoot)
  const tool = tools.get('gotry_deck_export')
  ok(Boolean(tool), '§0a gotry_deck_export 必须已注册')
  if (!tool) {
    console.log('\nITINERARY DECK EXPORT TESTS: 0 pass, 1 fail')
    console.log('  - 工具未注册')
    process.exit(1)
  }
  const exec = { agent: { session: { header: { cwd } } } }
  const run = async (args: Record<string, unknown>, execCtx: unknown = exec): Promise<ExportResult> =>
    await tool.execute(args, execCtx) as ExportResult

  // ---- §1 模型可见契约 ----
  const params = tool.parameters
  ok(params.required?.includes('fact_ids') === true, '§1a fact_ids 必填')
  ok(params.required?.includes('title') === true, '§1b title 必填')
  ok(params.required?.includes('itinerary') === true, '§1c itinerary 必填')
  ok(params.required?.includes('basename') !== true, '§1d basename 可选')
  ok(params.required?.includes('target_url') !== true, '§1e target_url 可选')
  ok(/registry/i.test(tool.description), '§1f 描述声明事实只从注册表取')
  ok(/never overwrites/i.test(tool.description), '§1g 描述声明绝不覆盖')
  ok(/manifest\.json/.test(tool.description), '§1h 描述声明产出 manifest.json')
  ok(/qr\.svg/.test(tool.description), '§1i 描述声明产出 qr.svg')
  ok(/real QR matrix/i.test(tool.description), '§1j 描述声明 qr 是真矩阵(#569)')

  // ---- §2 事实登记进隔离注册表 ----
  ok(await appendFacts(stateRoot, [FLIGHT, HOTEL, POLICY]), '§2a 合成事实写入隔离注册表')
  const registry = await loadFactRegistry(stateRoot)
  ok(registry.length === 3, `§2b 注册表读回 3 条(实测 ${registry.length})`)
  ok(bundleFiles(cwd).length === 0, '§2c 导出前 target_dir 为空')

  // ---- §3 空 fact_ids = 明确未核验 bundle ----
  const empty = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [] })
  ok(empty.ok === true, `§3a 空 fact_ids 合法(实际:${JSON.stringify(empty.error ?? '')})`)
  ok(empty.overall_verified === false, '§3b 结果显式声明无整体「已验证」结论')
  const emptyDir = String(empty.target_dir ?? '')
  ok(realpathSync(emptyDir) === realpathSync(cwd), '§3c target_dir 解析到宿主给出的会话工作目录')
  const emptyFiles = bundleFiles(emptyDir)
  ok(emptyFiles.length === 3, `§3d bundle 三件齐落盘(实测 ${emptyFiles.length} 个文件: ${emptyFiles.join(',')})`)
  const emptyManName = String(empty.basename) + ITINERARY_DECK_EXPORT_MANIFEST_SUFFIX
  const emptyQrName = String(empty.basename) + ITINERARY_DECK_EXPORT_QR_SUFFIX
  const emptyHtmlName = String(empty.basename) + ITINERARY_DECK_EXPORT_HTML_SUFFIX
  ok(emptyFiles.includes(emptyManName), `§3e 含 <basename>.manifest.json(${emptyManName})`)
  ok(emptyFiles.includes(emptyHtmlName), `§3f 含 <basename>.html(${emptyHtmlName})`)
  ok(emptyFiles.includes(emptyQrName), `§3g 含 <basename>.qr.svg(${emptyQrName})`)

  // manifest schema + 字段如实
  const emptyManifest = JSON.parse(readFileSync(String(empty.files?.manifest), 'utf-8'))
  ok(emptyManifest.schema === 'gotry_deck_manifest.v1', '§3h manifest.schema = gotry_deck_manifest.v1')
  ok(typeof emptyManifest.exported_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(emptyManifest.exported_at), '§3i manifest.exported_at 是 ISO 时间戳')
  ok(emptyManifest.deck?.basename === emptyHtmlName, '§3j manifest.deck.basename 对得上落盘文件名')
  ok(emptyManifest.deck?.sha256?.length === 64, '§3k manifest.deck.sha256 是 64 字符 hex')
  const emptyHtmlDisk = readFileSync(String(empty.files?.html), 'utf-8')
  const emptyHtmlSha = createHash('sha256').update(Buffer.from(emptyHtmlDisk, 'utf8')).digest('hex')
  ok(emptyManifest.deck?.sha256 === emptyHtmlSha, '§3l manifest sha256 = 磁盘 deck sha256')
  ok(emptyManifest.deck?.bytes === Buffer.byteLength(emptyHtmlDisk, 'utf8'), '§3m manifest bytes = 磁盘字节')
  ok(emptyManifest.facts?.total === 0, '§3n facts.total = 0')
  ok(emptyManifest.facts?.by_kind?.flight === 0 && emptyManifest.facts?.by_kind?.hotel === 0 && emptyManifest.facts?.by_kind?.policy === 0, '§3o facts.by_kind 全 0')
  ok(emptyManifest.evidence_chain?.unverified === 0, '§3p evidence_chain.unverified = 0')
  ok(emptyManifest.share_intent?.qr === 'generated', '§3q share_intent.qr = generated(#569 真矩阵)')
  ok(emptyManifest.share_intent?.qr_path === emptyQrName, `§3r share_intent.qr_path = <basename>.qr.svg(${emptyQrName})`)
  ok(emptyManifest.target_url === undefined, '§3s 未提供 target_url 时 manifest.target_url 缺省')

  // ---- §4 选中 3 条事实:sha256 + 字节 + 分类计数 + source_tags ----
  const selected = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [FLIGHT_ID, HOTEL_ID, POLICY_ID], basename: 'with-facts' })
  ok(selected.ok === true, `§4a 选中 3 条成功(实际:${JSON.stringify(selected.error ?? '')})`)
  const selDir = String(selected.target_dir ?? '')
  // §3 已写入同 dir 的 bundle;§4 再写不会撞(不同 basename),dir 内文件叠加,只断言 §4 三件齐
  ok(bundleFiles(selDir).includes(`${String(selected.basename)}${ITINERARY_DECK_EXPORT_HTML_SUFFIX}`)
    && bundleFiles(selDir).includes(`${String(selected.basename)}${ITINERARY_DECK_EXPORT_MANIFEST_SUFFIX}`)
    && bundleFiles(selDir).includes(`${String(selected.basename)}${ITINERARY_DECK_EXPORT_QR_SUFFIX}`),
    '§4b §4 bundle 三件齐 + 与 §3 不互撞(不同 basename)')
  const selManifest = JSON.parse(readFileSync(String(selected.files?.manifest), 'utf-8'))
  ok(selManifest.facts?.total === 3, `§4c facts.total = 3(实测 ${selManifest.facts?.total})`)
  ok(selManifest.facts?.by_kind?.flight === 1 && selManifest.facts?.by_kind?.hotel === 1 && selManifest.facts?.by_kind?.policy === 1, '§4d facts.by_kind 各 1')
  ok(selManifest.evidence_chain?.by_tier?.live_inventory === 2, '§4e evidence_chain.by_tier.live_inventory = 2(flight + hotel)')
  ok(selManifest.evidence_chain?.by_bookability?.bookable_exact_date === 2, '§4f by_bookability.bookable_exact_date = 2')
  const selHtmlDisk = readFileSync(String(selected.files?.html), 'utf-8')
  const selHtmlSha = createHash('sha256').update(Buffer.from(selHtmlDisk, 'utf8')).digest('hex')
  ok(selManifest.deck?.sha256 === selHtmlSha, '§4g sha256 与磁盘 deck 一致')
  ok(selManifest.deck?.bytes === Buffer.byteLength(selHtmlDisk, 'utf8'), '§4h bytes 与磁盘字节一致')
  ok(Array.isArray(selManifest.facts?.source_tags) && selManifest.facts.source_tags.includes('[session:ctrip-flight]') && selManifest.facts.source_tags.includes('[flyai-hotel]') && selManifest.facts.source_tags.includes('[flyai]'),
    '§4i source_tags 含三类源标识')

  // ---- §5 target_url 记录在 manifest(可选) ----
  const withUrl = await run({
    title: TITLE,
    itinerary: ITINERARY,
    fact_ids: [],
    basename: 'with-url',
    target_url: 'https://example.com/decks/abc.html',
  })
  ok(withUrl.ok === true, '§5a 带 target_url 成功')
  const urlManifest = JSON.parse(readFileSync(String(withUrl.files?.manifest), 'utf-8'))
  ok(urlManifest.target_url === 'https://example.com/decks/abc.html', '§5b manifest.target_url 正确记录')

  // ---- §6 未知 id 拒绝,零字节 ----
  const before6 = bundleFiles(cwd).length
  const unknown = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: ['i568notthere'] })
  ok(unknown.ok === false && String(unknown.error).includes('i568notthere'), '§6a 未知 id 显式拒绝并回显 id')
  ok(bundleFiles(cwd).length === before6, '§6b 未知 id 零新增文件')

  // ---- §7 重复 id 拒绝,零字节 ----
  const dup = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [FLIGHT_ID, FLIGHT_ID] })
  ok(dup.ok === false && /重复/.test(String(dup.error)), '§7a 重复 id 拒绝')
  ok(bundleFiles(cwd).length === before6, '§7b 重复 id 零新增')

  // ---- §8 超量 id 拒绝,零字节 ----
  const many = Array.from({ length: 201 }, (_, i) => `i568bulk${i}`)
  const over = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: many })
  ok(over.ok === false && /容量上限/.test(String(over.error)), '§8a 超量 id 拒绝')
  ok(bundleFiles(cwd).length === before6, '§8b 超量 id 零新增')

  // ---- §9 登记行畸形 → 渲染器拒绝,零字节 ----
  const malformed = { ...HOTEL, fact_id: 'i568malformed01', verdict: 'hit', options_masked: 'many' }
  ok(await appendFacts(stateRoot, [malformed as unknown as BookableFact]), '§9a 畸形登记行写入注册表')
  const malformedRun = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: ['i568malformed01'], basename: 'malformed' })
  ok(malformedRun.ok === false, '§9b 畸形登记行不导出成功')
  ok(Array.isArray(malformedRun.errors) && malformedRun.errors.length > 0, '§9c 畸形行给出结构化 errors')
  ok(!bundleFiles(cwd).includes('malformed.html'), '§9d 畸形行零新增 bundle')

  // ---- §10 调用方自带 facts 不被接受 ----
  const forgedId = 'i568forged0001'
  const callerFacts = await run({
    title: TITLE,
    itinerary: ITINERARY,
    fact_ids: [],
    facts: [{ schema: BOOKABLE_FACT_SCHEMA, fact_id: forgedId, kind: 'flight' }],
  }, exec)
  ok(callerFacts.ok === true, '§10a 额外的 facts 字段不影响空列表生成')
  const cfHtml = readFileSync(String(callerFacts.files?.html), 'utf-8')
  ok(!cfHtml.includes(forgedId), '§10b 调用方自带事实对象不被投影')
  const forged = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [forgedId], basename: 'forged' })
  ok(forged.ok === false, '§10c 伪造 id 按未知 id 拒绝')
  ok(!bundleFiles(cwd).includes('forged.html'), '§10d 伪造 id 零新增 bundle')

  // ---- §11 bundle 已有任一文件 → 拒绝覆盖,零字节 ----
  const before11 = bundleFiles(cwd).length
  // 预先放一个 <basename>.manifest.json(模拟同 bundle 名残留)
  const collisionDir = join(home, 'collision')
  mkdirSync(collisionDir, { recursive: true })
  const collisionBase = 'collide'
  writeFileSync(join(collisionDir, `${collisionBase}${ITINERARY_DECK_EXPORT_MANIFEST_SUFFIX}`), 'preexisting', 'utf-8')
  const collisionExec = { agent: { session: { header: { cwd: collisionDir } } } }
  const collision = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [], basename: collisionBase }, collisionExec)
  ok(collision.ok === false && /拒绝覆盖/.test(String(collision.error)), '§11a 已有 <basename>.manifest.json 拒绝覆盖')
  ok(readFileSync(join(collisionDir, `${collisionBase}${ITINERARY_DECK_EXPORT_MANIFEST_SUFFIX}`), 'utf-8') === 'preexisting', '§11b 既有 manifest.json 字节未被改写')
  ok(!bundleFiles(collisionDir).includes(`${collisionBase}${ITINERARY_DECK_EXPORT_HTML_SUFFIX}`), '§11c 拒绝时不补写 html')

  // html 已存在
  const collision2Dir = join(home, 'collision2')
  mkdirSync(collision2Dir, { recursive: true })
  const collision2Base = 'something'
  writeFileSync(join(collision2Dir, `${collision2Base}${ITINERARY_DECK_EXPORT_HTML_SUFFIX}`), 'preexisting', 'utf-8')
  const collision2Exec = { agent: { session: { header: { cwd: collision2Dir } } } }
  const collision2 = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [], basename: collision2Base }, collision2Exec)
  ok(collision2.ok === false && /拒绝覆盖/.test(String(collision2.error)), '§11d 已有 <basename>.html 拒绝覆盖')
  ok(readFileSync(join(collision2Dir, `${collision2Base}${ITINERARY_DECK_EXPORT_HTML_SUFFIX}`), 'utf-8') === 'preexisting', '§11e 既有 html 字节未被改写')

  // qr.svg 已存在
  const collision3Dir = join(home, 'collision3')
  mkdirSync(collision3Dir, { recursive: true })
  const collision3Base = 'qr-base'
  writeFileSync(join(collision3Dir, `${collision3Base}${ITINERARY_DECK_EXPORT_QR_SUFFIX}`), 'preexisting', 'utf-8')
  const collision3Exec = { agent: { session: { header: { cwd: collision3Dir } } } }
  const collision3 = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [], basename: collision3Base }, collision3Exec)
  ok(collision3.ok === false && /拒绝覆盖/.test(String(collision3.error)), '§11f 已有 <basename>.qr.svg 拒绝覆盖')
  ok(readFileSync(join(collision3Dir, `${collision3Base}${ITINERARY_DECK_EXPORT_QR_SUFFIX}`), 'utf-8') === 'preexisting', '§11g 既有 qr.svg 字节未被改写')

  ok(bundleFiles(cwd).length === before11, '§11h 拒绝碰撞的主目录零新增')

  // ---- §12 符号链接 target_dir 拒绝(指向别处) ----
  const linkDir = join(home, 'linkdir')
  symlinkSync(outside, linkDir)
  const linkedExec = { agent: { session: { header: { cwd: linkDir } } } }
  const linked = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [], basename: 'sym' }, linkedExec)
  ok(linked.ok === false, '§12a 指向别处的符号链接 target_dir 拒绝')
  ok(readFileSync(outsideFile, 'utf-8') === 'DO NOT TOUCH', '§12b 链接目标字节未被改写')
  ok(bundleFiles(outside).length === 1, '§12c 仓外 bundle 目录零新增(只有预留的 target.html)')

  // ---- §13 basename 路径与命名契约 ----
  const before13 = bundleFiles(cwd).length
  const rejectNames = [
    '../../evil',
    'sub/evil',
    'sub\\evil',
    '../evil',
    'evil.html', // 含 . 不允许(basename 是 stem,后缀固定)
    `prefix-${'a'.repeat(70)}`,
    'has space',
    '',
  ]
  for (const name of rejectNames) {
    const r = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [], basename: name })
    ok(r.ok === false, `§13a basename 拒绝:${JSON.stringify(name)}`)
  }
  ok(bundleFiles(cwd).length === before13, `§13b 拒绝的 basename 未产生文件(实测 ${bundleFiles(cwd).length})`)
  ok(!readdirSync(outside).includes('evil'), '§13c 仓外无越级文件')
  ok(ITINERARY_DECK_EXPORT_BASENAME_RE.source.startsWith('^[A-Za-z0-9]'), '§13d 契约 regex 锁定 stem-only')

  // ---- §14 target_dir 边界 ----
  for (const bad of [join(stateRoot, 'node_modules'), join(home, '.git'), join(home, 'nope')]) {
    mkdirSync(join(stateRoot, 'node_modules'), { recursive: true })
    mkdirSync(join(home, '.git'), { recursive: true })
    const r = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [] }, { agent: { session: { header: { cwd: bad } } } })
    ok(r.ok === false, `§14a 受限/不存在的 target_dir 拒绝:${bad}`)
  }
  ok(readdirSync(join(home, '.git')).length === 0, '§14b .git 段零写入')
  ok(readdirSync(join(stateRoot, 'node_modules')).length === 0, '§14c node_modules 段零写入')

  // ---- §15 随机默认 bundle basename + 确定性 ----
  const r1 = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [], basename: 'det-basename' })
  const r2 = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [], basename: 'det-basename-2' })
  ok(r1.ok === true && r2.ok === true, '§15a 显式 basename 导出成功')
  ok(r1.basename !== r2.basename, '§15b 不同 basename 不互串')

  const r3 = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [] })
  ok(r3.ok === true, '§15c 默认随机 basename 导出成功')
  ok(ITINERARY_DECK_EXPORT_BASENAME_RE.test(String(r3.basename)), '§15d 随机 basename 符合 stem 契约')
  const r4 = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [] })
  ok(r4.basename !== r3.basename, '§15e 连续两次随机 basename 不同')

  // 确定性:同输入两次 html 字节一致
  const detA = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [FLIGHT_ID, HOTEL_ID, POLICY_ID], basename: 'det-A' })
  const detB = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [FLIGHT_ID, HOTEL_ID, POLICY_ID], basename: 'det-B' })
  ok(detA.ok === true && detB.ok === true, '§15f 同输入连续导出成功')
  ok(readFileSync(String(detA.files?.html), 'utf-8') === readFileSync(String(detB.files?.html), 'utf-8'), '§15g 同输入 deck html 字节一致')

  // ---- §16 畸形输入拒绝,零字节 ----
  const before16 = bundleFiles(cwd).length
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
    ok(r.ok === false, `§16a 畸形输入 ${i} 拒绝`)
  }
  ok(bundleFiles(cwd).length === before16, `§16b 畸形输入零新增(实测 ${bundleFiles(cwd).length})`)

  // ---- §17 target_dir 非法一律 fail closed(零字节,绝不回落 process cwd) ----
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
    const r = await tool.execute({ title: TITLE, itinerary: ITINERARY, fact_ids: [] }, badExec) as ExportResult
    ok(r.ok === false, `§17a 非法 target_dir 拒绝:${label}`)
    ok(/target_dir|会话工作目录/.test(String(r.error)), `§17b 拒绝原因是 target_dir/会话工作目录缺失/非法:${label}`)
  }
  ok(readdirSync(process.cwd()).sort().join(',') === procCwdBefore, '§17c 进程 cwd 零新增文件')

  // ---- §17d 直接调用能力层同样 fail closed ----
  for (const bad of ['', '   ', undefined as unknown as string]) {
    const r = await generateItineraryDeckExport({ title: TITLE, itinerary: ITINERARY, fact_ids: [] }, { stateRoot, targetDir: bad })
    ok(r.ok === false && /target_dir|会话工作目录/.test(String(r.error)), `§17d 能力层拒绝 target_dir=${JSON.stringify(bad)}`)
  }
  ok(readdirSync(process.cwd()).sort().join(',') === procCwdBefore, '§17e 能力层非法 target_dir 零写入进程 cwd')

  // ---- §18 QR 真矩阵(issue #569 切片 3b):结构 + 编码内容校验 ----
  const qrDisk = readFileSync(String(empty.files?.qr), 'utf-8')
  ok(qrDisk.includes('<svg') && qrDisk.includes('</svg>'), '§18a qr.svg 是合法 SVG')
  ok(qrDisk.includes('<path') || qrDisk.includes('<rect'), '§18b qr.svg 含 QR 模块元素(path 或 rect)')
  ok(/viewBox=/.test(qrDisk), '§18c qr.svg 有 viewBox(浏览器/扫码 app 可缩放)')
  ok(qrDisk.length > 600, `§18d qr.svg 是非平凡矩阵(占位 SVG 远短于此;实测 ${qrDisk.length} 字节)`)

  // ---- §18e 有 target_url 时 QR 编码它;无时编码本地占位串(语义校验) ----
  const withUrlQrDisk = readFileSync(String(withUrl.files?.qr), 'utf-8')
  ok(withUrlQrDisk.length > 600, `§18e 有 target_url 的 bundle qr.svg 也是非平凡矩阵(${withUrlQrDisk.length} 字节)`)
  // 语义校验(自检 review #3):不同 payload 必须产不同 QR——空 fact_ids→本地 marker vs
  // 有 target_url→真 URL,字节必不同
  ok(qrDisk !== withUrlQrDisk, `§18e2 不同 payload 的 QR 字节不同(${qrDisk.length} vs ${withUrlQrDisk.length};QR 必随编码内容变化)`)
  // 同一个 target_url 两次生成 qr.svg 字节级一致(确定性)
  const withUrl2 = await run({
    title: TITLE,
    itinerary: ITINERARY,
    fact_ids: [],
    basename: 'with-url-2',
    target_url: 'https://example.com/decks/abc.html',
  })
  ok(withUrl2.ok === true, '§18f 同 target_url 重复导出成功')
  const withUrl2QrDisk = readFileSync(String(withUrl2.files?.qr), 'utf-8')
  ok(withUrl2QrDisk === withUrlQrDisk, '§18g 同 target_url 字节级一致(qrcode 确定性)')

  // ---- §19 target_url 超长拒绝 ----
  const longUrl = 'https://example.com/' + 'a'.repeat(2100)
  const longUrlRun = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [], basename: 'long-url', target_url: longUrl })
  ok(longUrlRun.ok === false && /target_url/.test(String(longUrlRun.error)), '§19a 超长 target_url 拒绝')

  // 超出 QR 编码容量(但未超 target_url 长度上限)的输入:QR 先于任何写盘生成 → 零写入
  // (#569 切片 3b 零写入保护回归:qrcode 库 reject 时三件一件都不落盘,重试不撞 EEXIST)
  const overQrUrl = '普'.repeat(1000) // 1000 字符 ≤ 2048 上限;UTF-8 3000 字节 > QR v40-M 2331 上限
  const overQr = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [], basename: 'over-qr', target_url: overQrUrl })
  ok(overQr.ok === false && /QR 编码失败/.test(String(overQr.error)), '§19b 超出 QR v40-M 容量的 target_url 结构化拒绝')
  ok(!bundleFiles(cwd).includes(`over-qr${ITINERARY_DECK_EXPORT_HTML_SUFFIX}`)
    && !bundleFiles(cwd).includes(`over-qr${ITINERARY_DECK_EXPORT_MANIFEST_SUFFIX}`)
    && !bundleFiles(cwd).includes(`over-qr${ITINERARY_DECK_EXPORT_QR_SUFFIX}`),
    '§19c QR 编码失败零写入(bundle 三件都未落盘)')

  // ---- §22 QR 独立解码验收(#569 T2):光栅化后经独立解码器逐字节还原 payload ----
  // 「不同字节 + 有 <path>」不构成解码证明;这里把**实际落盘的 qr.svg**交给独立解码链
  // (sharp 光栅化 → jsqr 解码,与编码侧 qrcode 库零共享代码),断言还原结果与期望
  // payload 逐字节一致。依赖说明:jsqr 是本次新增的 dev-only 依赖;sharp 早已在运行时
  // 闭包内(@deepseek-ai/dsh-attachment-local 的传递依赖)——本次只在 ts/package.json
  // 把既有版本显式声明为 devDependency 并新增测试 import,不新增任何 runtime 调用。
  // 审批过的字面占位串在测试侧独立钉死(期望值不引用生产常量):生产常量被意外改动时
  // §22b 必红;§22r 再把生产常量与这个字面量互锁(漂移即红)。
  const marker = '<local bundle; not yet hosted>'
  const emptyDecoded = await decodeQrSvg(qrDisk, 240)
  ok(emptyDecoded !== null, '§22a 本地占位 QR 经独立解码器解码成功(非 null)')
  ok(emptyDecoded?.data === marker, `§22b 无 target_url 时解码还原字面占位串(实测:${JSON.stringify(emptyDecoded?.data)})`)
  ok(Buffer.compare(Buffer.from(marker, 'utf8'), Buffer.from(emptyDecoded?.bytes ?? [])) === 0, '§22c 占位串 UTF-8 字节逐字节一致')

  const urlDecoded = await decodeQrSvg(withUrlQrDisk, 240)
  const withUrlStr = 'https://example.com/decks/abc.html'
  ok(urlDecoded !== null, '§22d target_url QR 经独立解码器解码成功(非 null)')
  ok(urlDecoded?.data === withUrlStr, `§22e 解码还原精确 URL(实测:${JSON.stringify(urlDecoded?.data)})`)
  ok(Buffer.compare(Buffer.from(withUrlStr, 'utf8'), Buffer.from(urlDecoded?.bytes ?? [])) === 0, '§22f URL UTF-8 字节逐字节一致')

  // 负控制:两条 payload 经**解码器**还原后互不相等——证明比较非空洞(不是同码/常量误判)
  ok(urlDecoded?.data !== marker && emptyDecoded?.data !== withUrlStr, '§22g 不同 payload 解码还原互不相等(负控制)')

  // UTF-8 payload(非 ASCII 走 QR byte 模式 UTF-8 编码):解码必须逐字节还原
  const utf8Url = 'https://example.com/decks/普吉-2027.html?from=深圳'
  const utf8Run = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [], basename: 'utf8-url', target_url: utf8Url })
  ok(utf8Run.ok === true, `§22h UTF-8 target_url 导出成功(实际:${JSON.stringify(utf8Run.error ?? '')})`)
  const utf8QrDisk = readFileSync(String(utf8Run.files?.qr), 'utf-8')
  const utf8Decoded = await decodeQrSvg(utf8QrDisk, 240)
  ok(utf8Decoded !== null, '§22i UTF-8 QR 解码成功(非 null)')
  ok(utf8Decoded?.data === utf8Url, `§22j UTF-8 URL 字符串精确还原(实测:${JSON.stringify(utf8Decoded?.data)})`)
  ok(Buffer.compare(Buffer.from(utf8Url, 'utf8'), Buffer.from(utf8Decoded?.bytes ?? [])) === 0, '§22k UTF-8 URL 字节逐字节一致')

  // 实用显示尺寸:128px(小图)与 240px(典型)都能被独立解码器还原——margin=2 静默区的证据
  const smallDecoded = await decodeQrSvg(withUrlQrDisk, 128)
  ok(smallDecoded !== null && smallDecoded.data === withUrlStr, '§22l 128px 实用显示尺寸解码还原精确 URL(margin=2 静默区可扫描)')
  const largeDecoded = await decodeQrSvg(withUrlQrDisk, 480)
  ok(largeDecoded !== null && largeDecoded.data === withUrlStr, '§22m 480px 放大尺寸解码还原精确 URL')

  // 补全 payload × 尺寸矩阵:UTF-8 与本地占位串在 128/480px 同样解码还原精确 payload
  const utf8Small = await decodeQrSvg(utf8QrDisk, 128)
  ok(utf8Small !== null && utf8Small.data === utf8Url, '§22n 128px UTF-8 URL 解码还原精确')
  const utf8Large = await decodeQrSvg(utf8QrDisk, 480)
  ok(utf8Large !== null && utf8Large.data === utf8Url, '§22o 480px UTF-8 URL 解码还原精确')
  const markerSmall = await decodeQrSvg(qrDisk, 128)
  ok(markerSmall !== null && markerSmall.data === marker, '§22p 128px 本地占位串解码还原精确')
  const markerLarge = await decodeQrSvg(qrDisk, 480)
  ok(markerLarge !== null && markerLarge.data === marker, '§22q 480px 本地占位串解码还原精确')

  // 漂移锁:生产常量必须仍等于上方测试侧独立钉死的审批字面占位串(期望值没有引用它)
  ok(marker === ITINERARY_DECK_EXPORT_LOCAL_MARKER, '§22r ITINERARY_DECK_EXPORT_LOCAL_MARKER 与审批字面占位串一致(漂移即红)')

  // ---- §23 manifest.local_only 显式指示(#569 的 local_only 期望 × v1 兼容附加字段) ----
  ok(emptyManifest.local_only === true, '§23a 无 target_url 时 manifest.local_only = true')
  ok(urlManifest.local_only === false, '§23b 有 target_url 时 manifest.local_only = false')
  // 三态互锁:local_only=true ⟺ target_url 缺省 ⟺ QR 编码本地占位串(绝不暗示线上目的地)
  ok(emptyManifest.target_url === undefined && emptyManifest.local_only === true && emptyDecoded?.data === marker,
    '§23c local_only=true 与 target_url 缺省与本地占位串三态互锁')

  // ---- §20 真实链路:产物 list/read → deck html 与磁盘一致 + sha256 与 manifest 一致 ----
  const listTool = tools.get('gotry_artifacts_list')
  const readTool = tools.get('gotry_artifacts_read')
  ok(Boolean(listTool && readTool), '§20a 产物 list/read 注册工具可用')
  const chainBasename = 'e2e-chain'
  const chain = await run({
    title: TITLE,
    itinerary: ITINERARY,
    fact_ids: [FLIGHT_ID, HOTEL_ID, POLICY_ID],
    basename: chainBasename,
    target_url: 'https://example.com/decks/e2e.html',
  })
  ok(chain.ok === true, `§20b 导出成功(实际:${JSON.stringify(chain.error ?? '')})`)
  const chainDir = String(chain.target_dir ?? '')

  const listed = await listTool!.execute({ limit: 50 }, exec) as { artifacts?: Array<{ id?: string; path?: string; source?: string; bytes?: number }> }
  // artifacts list 只白名单 .md/.html/.htm——bundle 的 .manifest.json / .qr.svg 不入册是预期(它们是 bundle 元数据,不是用户产物面)
  const chainHtmlId = `${chainBasename}${ITINERARY_DECK_EXPORT_HTML_SUFFIX}`
  const htmlEntry = (listed.artifacts ?? []).find(a => a.id === chainHtmlId)
  ok(Boolean(htmlEntry), '§20c list 在册发现 bundle html(manifest/qr 是 bundle 元数据,不入 artifact 列表)')

  const chainHtmlDisk = readFileSync(String(chain.files?.html), 'utf-8')
  const chainManDisk = readFileSync(String(chain.files?.manifest), 'utf-8')
  const chainQrDisk = readFileSync(String(chain.files?.qr), 'utf-8')
  ok(htmlEntry?.bytes === Buffer.byteLength(chainHtmlDisk, 'utf8'), '§20d html list 字节与磁盘一致')

  const chainManifest = JSON.parse(chainManDisk)
  const chainSha = createHash('sha256').update(Buffer.from(chainHtmlDisk, 'utf8')).digest('hex')
  ok(chainManifest.deck?.sha256 === chainSha, '§20g manifest.deck.sha256 与磁盘 deck 一致')
  ok(chainManifest.deck?.bytes === Buffer.byteLength(chainHtmlDisk, 'utf8'), '§20h manifest.deck.bytes 与磁盘一致')

  const htmlRead = await readTool!.execute({ path: String(chain.files?.html) }, exec) as { ok?: boolean; lang?: string; content?: string; version?: string }
  ok(htmlRead.ok === true && htmlRead.lang === 'html', '§20i read html 成功并以 html 源码读出')
  ok(htmlRead.content === chainHtmlDisk, '§20j read 内容与落盘字节一致')
  ok(htmlRead.version === chainManifest.deck?.sha256?.slice(0, 12), '§20k read version = manifest.sha256 前 12 位')

  // qr.svg 直接读盘验证(不在 artifact list 白名单内)
  ok(qrDisk.startsWith('<svg'), '§20l qr.svg 是合法 SVG(真矩阵,#569)')

  // ---- §21 bundle 路径保真(尾随空格) ----
  const plainDir = join(home, 'session')
  const spacedDir = join(home, 'session ')
  mkdirSync(plainDir, { recursive: true })
  mkdirSync(spacedDir, { recursive: true })
  const spacedExec = { agent: { session: { header: { cwd: spacedDir } } } }
  const viaTool = await run({ title: TITLE, itinerary: ITINERARY, fact_ids: [], basename: 'spaced' }, spacedExec)
  ok(viaTool.ok === true, `§21a 带尾随空格 target_dir 导出成功(实际:${JSON.stringify(viaTool.error ?? '')})`)
  ok(realpathSync(String(viaTool.target_dir)) === realpathSync(spacedDir), '§21b 落点 = 宿主给出的带空格目录')
  ok(bundleFiles(spacedDir).length === 3, '§21c bundle 三件落在带空格目录内')
  ok(bundleFiles(plainDir).length === 0, '§21d 同名兄弟目录零写入(未归一化)')

  rmSync(home, { recursive: true, force: true })

  console.log(`\nITINERARY DECK EXPORT TESTS: ${pass} pass, ${fail} fail`)
  if (fail > 0) {
    console.log('\nFAILURES:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}

await main()