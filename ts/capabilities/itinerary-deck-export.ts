/**
 * 行程 deck 静态导出 bundle(issue #568,Phase B 切片 3a;研究决策见
 * docs/research/karpo-deck-web-research.md 决策 #1 与
 * docs/design/itinerary-deck-renderer.md;QR 真矩阵编码独立为 issue #569 切片 3b)。
 *
 * 与切片 2 单页入口(`gotry_itinerary_render`)/切片 2 deck 入口
 * (`gotry_itinerary_deck_render`)的产品分工:那两个入口把产物写到 dsh 会话
 * 工作目录顶层(用于 chat 内嵌);本入口把 deck 写到**宿主显式给出的
 * target_dir** 下的一个「分享 bundle」——`basename.html` + `manifest.json` +
 * `qr.svg`(占位;切片 3b 落地后覆盖真矩阵),ready for 任意静态托管。
 *
 * 三条硬纪律(继承自单页入口 + deck 入口,verbatim):
 *   1. 事实只从 <stateRoot>/gotry-state/bookable-facts.jsonl 注册表取;
 *   2. target_dir 必须是宿主显式给出的**绝对**目录,realpath 化并排除
 *      .git/node_modules 后,以 `O_CREAT|O_EXCL` 独占创建 bundle 三件——
 *      既有 bundle 文件任何一件存在都拒绝覆盖;
 *   3. 失败即拒绝、零写入:输入非法/事实未注册/渲染被拒/basename 非法/
 *      bundle 任一文件已被占用都返回结构化错误,不开文件、不落字节。
 */

import { createHash, randomBytes } from 'node:crypto'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'

import QRCode from 'qrcode'

import { loadFactRegistry } from './fact-log.ts'
import { ITINERARY_DOC_LIMITS } from '../src/itinerary-doc-shared.ts'
import {
  type BookableFact,
  type Bookability,
  type EvidenceTier,
} from '../src/bookable-facts.ts'
import { renderItineraryDeck } from '../src/itinerary-deck.ts'

/** 产物 basename 契约:固定前缀 + ASCII 安全 token(后缀固定 .html/.manifest.json/.qr.svg,basename 不含 .) */
export const ITINERARY_DECK_EXPORT_BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** bundle 三件文件名 — 三件都带 basename 前缀(同一 target_dir 下多 bundle 不互撞) */
export const ITINERARY_DECK_EXPORT_HTML_SUFFIX = '.html'
export const ITINERARY_DECK_EXPORT_MANIFEST_SUFFIX = '.manifest.json'
export const ITINERARY_DECK_EXPORT_QR_SUFFIX = '.qr.svg'
/** 保留未带后缀的别名(向后兼容:导出 manifest.json / qr.svg 单件名给老消费者) */
export const ITINERARY_DECK_EXPORT_MANIFEST_NAME = 'manifest.json'
export const ITINERARY_DECK_EXPORT_QR_NAME = 'qr.svg'
/** 随机默认 bundle basename(仅 crypto 十六进制;显式 basename 优先) */
export const ITINERARY_DECK_EXPORT_RANDOM_BYTES = 8
const RANDOM_ATTEMPTS = 3
const DIR_DENY = ['.git', 'node_modules']
const ID_SAMPLE = 3
const SOURCE_TAG_SAMPLE = 12
const TARGET_URL_MAX = 2048

export interface ItineraryDeckExportDeps {
  /** 事实注册表根(config.stateRoot);工具面固定传当前配置,不接受调用方覆盖 */
  stateRoot: string
  /** bundle 写入目录:必须是宿主显式给出的绝对路径;缺失/空白/相对一律拒绝 */
  targetDir: string
  /** 当前时刻来源(测试可注入;运行时由工具面传入 new Date()) */
  now?: () => Date
}

export type ItineraryDeckExportResult =
  | {
    ok: true
    /** bundle 真实目录绝对路径(realpath 结果) */
    target_dir: string
    basename: string
    files: { html: string; manifest: string; qr: string }
    bytes: number
    fact_ids: string[]
    overall_verified: false
  }
  | { ok: false; error: string; hint?: string; errors?: string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasDeniedSegment(p: string): boolean {
  return p.split(sep).some(seg => DIR_DENY.includes(seg))
}

function fsErrorText(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  switch (code) {
    case 'EACCES':
    case 'EPERM': return '无写入权限'
    case 'ENOSPC': return '磁盘空间不足'
    case 'EROFS': return '只读文件系统'
    case 'ENOTDIR': return '路径中某段不是目录'
    case 'ENOENT': return '目录不存在'
    case 'ENAMETOOLONG': return '文件名过长'
    default: return typeof code === 'string' ? `文件系统错误 ${code}` : '文件系统错误'
  }
}

/** fact_ids 输入收窄:必填数组、逐条非空短字符串、无重复、不超渲染器容量 */
function takeFactIds(value: unknown): { ids: string[] } | { error: string; hint?: string } {
  if (value === undefined || value === null) {
    return { error: 'fact_ids 必填(字符串数组,可为空数组)', hint: 'id 来自本次会话 exact-date 工具结果记录的注册表;不接受调用方自带事实' }
  }
  if (!Array.isArray(value)) return { error: 'fact_ids 必须是字符串数组' }
  if (value.length > ITINERARY_DOC_LIMITS.facts) {
    return { error: `fact_ids 超出容量上限(${ITINERARY_DOC_LIMITS.facts} 条,实测 ${value.length} 条)` }
  }
  const ids: string[] = []
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const [i, raw] of value.entries()) {
    if (typeof raw !== 'string' || raw.length === 0) return { error: `fact_ids[${i}] 必须是非空字符串` }
    if (raw.length > ITINERARY_DOC_LIMITS.factIdChars) {
      return { error: `fact_ids[${i}] 超出 id 长度上限(${ITINERARY_DOC_LIMITS.factIdChars} 字符)` }
    }
    if (seen.has(raw)) {
      duplicates.push(raw)
      continue
    }
    seen.add(raw)
    ids.push(raw)
  }
  if (duplicates.length > 0) {
    return { error: `fact_ids 有重复 id:${duplicates.slice(0, ID_SAMPLE).join('、')}${duplicates.length > ID_SAMPLE ? ` 等 ${duplicates.length} 条` : ''}`, hint: '同一条事实只能选一次;重复选择说明调用方对证据面不确定' }
  }
  return { ids }
}

function takeBasename(value: unknown): { basename: string } | { error: string; hint?: string } {
  if (value === undefined || value === null)
    return { basename: `export-${randomBytes(ITINERARY_DECK_EXPORT_RANDOM_BYTES).toString('hex')}` }
  if (typeof value !== 'string' || value.length === 0) return { error: 'basename 必须是字符串' }
  if (value.includes('/') || value.includes('\\') || value.includes('..')) {
    return { error: 'basename 只能是文件 stem,不能含路径分隔符或 ..', hint: '形如 2027-thailand-phuket(用于生成 2027-thailand-phuket.html + manifest.json + qr.svg)' }
  }
  if (!ITINERARY_DECK_EXPORT_BASENAME_RE.test(value)) {
    return { error: 'basename 不符合命名契约', hint: '必须是字母/数字开头,后接字母/数字/._-(1-64 字符)' }
  }
  return { basename: value }
}

function takeTargetUrl(value: unknown): { targetUrl: string | undefined } | { error: string } {
  if (value === undefined || value === null) return { targetUrl: undefined }
  if (typeof value !== 'string' || value.length === 0) return { error: 'target_url 必须是字符串(可省略)' }
  if (value.length > TARGET_URL_MAX) {
    return { error: `target_url 超出长度上限(${TARGET_URL_MAX} 字符)` }
  }
  return { targetUrl: value }
}

/** target_dir:必须显式且为绝对路径(缺失/空白/相对一律拒绝,绝不回落 '.' 或 process.cwd()),
 *  按宿主原值解析(trim 只判全空白、绝不归一化路径),已存在、可 realpath、是目录,且不含 .git/node_modules 段;
 *  **拒绝符号链接**(防止「跟随 symlink 写到 host 未授权目录」——realpath 会解析 symlink,所以必须在 realpath 之前用 lstat 显式拒) */
async function resolveWritableDir(targetDir: unknown): Promise<{ dir: string } | { error: string; hint?: string }> {
  if (typeof targetDir !== 'string' || targetDir.trim() === '') {
    return { error: 'target_dir 缺失:拒绝在未知目录写产物', hint: '本工具必须有宿主显式给出的绝对目录,不做任何猜测性回落' }
  }
  if (!isAbsolute(targetDir)) {
    return { error: `target_dir 必须是绝对路径:${targetDir}`, hint: '相对路径会随进程工作目录漂移,拒绝写入' }
  }
  // lstat 在 symlink 上返回 isSymbolicLink()=true 而非跟随;realpath 之前的这层检查是关键:
  // 允许存在目录,但拒绝把 symlink 静默重定向到别处
  const lst = await lstat(targetDir).catch(() => null)
  if (!lst) return { error: `target_dir 不存在或无法访问:${targetDir}`, hint: '本工具只在真实存在的目录里写 bundle' }
  if (lst.isSymbolicLink()) {
    return { error: `target_dir 是符号链接,拒绝跟随写入:${targetDir}`, hint: '宿主给出真实目录路径,不要用 symlink 指向其他目录(本工具拒绝跟随)' }
  }
  const canonical = await realpath(targetDir).catch(() => null)
  if (!canonical) return { error: `target_dir 无法解析:${targetDir}` }
  if (hasDeniedSegment(canonical)) {
    return { error: 'target_dir 位于受限段(.git/node_modules)内,拒绝写入', hint: `解析后:${canonical}` }
  }
  const st = await stat(canonical).catch(() => null)
  if (!st?.isDirectory()) return { error: `target_dir 不是目录:${canonical}` }
  return { dir: canonical }
}

/** bundle 命名规则:basename → 三件文件名(<basename>.html / <basename>.manifest.json / <basename>.qr.svg) */
function bundleFileNames(basename: string): { html: string; manifest: string; qr: string } {
  return {
    html: `${basename}${ITINERARY_DECK_EXPORT_HTML_SUFFIX}`,
    manifest: `${basename}${ITINERARY_DECK_EXPORT_MANIFEST_SUFFIX}`,
    qr: `${basename}${ITINERARY_DECK_EXPORT_QR_SUFFIX}`,
  }
}

/** 预检:bundle 三件文件必须全部尚未存在 —— 任一存在则整体拒绝(零字节) */
async function assertBundleSlot(dir: string, names: { html: string; manifest: string; qr: string }): Promise<{ ok: true } | { error: string; hint?: string }> {
  for (const n of [names.html, names.manifest, names.qr]) {
    try {
      const st = await stat(join(dir, n))
      if (st.isFile()) return { error: `bundle 文件已存在,拒绝覆盖:${n}`, hint: '换一个 basename 或清空目标目录;本工具永不覆盖既有 bundle' }
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        return { error: `无法访问 bundle 文件:${fsErrorText(err)}`, hint: `目标目录:${dir}` }
      }
      // ENOENT 是预期的(slot 干净)
    }
  }
  return { ok: true }
}

/** 独占创建:wx(O_CREAT|O_EXCL)既拒绝覆盖既有文件,也拒绝落在指向别处的符号链接上 */
async function writeExclusive(path: string, body: string): Promise<{ bytes: number } | { error: string; hint?: string }> {
  const bytes = Buffer.byteLength(body, 'utf8')
  let handle
  try {
    handle = await open(path, 'wx', 0o644)
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'EEXIST') {
      return { error: `bundle 文件已存在,拒绝覆盖:${path}` }
    }
    return { error: `无法在 target_dir 新建 bundle 文件:${fsErrorText(err)}`, hint: `目标路径:${path}` }
  }
  try {
    await handle.writeFile(body, 'utf-8')
  } catch (err) {
    await handle.close().catch(() => { /* 关闭失败不再覆盖原始写错误 */ })
    return { error: `写入 bundle 文件失败:${fsErrorText(err)}`, hint: `目标文件:${path}` }
  }
  await handle.close()
  return { bytes }
}

/** 构造 manifest:v1 schema,记录 deck 字节/sha256、事实计数 + 来源标签、证据链分布、target_url、share_intent */
function buildManifest(
  basename: string,
  facts: BookableFact[],
  exportedAt: Date,
  targetUrl: string | undefined,
): Record<string, unknown> {
  const byKind: Record<string, number> = { flight: 0, train: 0, hotel: 0, policy: 0 }
  const sourceTags: string[] = []
  const byTier: Partial<Record<EvidenceTier, number>> = {}
  const byBookability: Partial<Record<Bookability, number>> = {}
  let unverified = 0
  const seenTags = new Set<string>()
  for (const f of facts) {
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1
    const tag = `[${f.source}]`
    if (!seenTags.has(tag)) {
      seenTags.add(tag)
      sourceTags.push(tag)
    }
    // policy 事实无 tier/bookability(tier/bookability 只描述「可下单」语义);按 kind 区分聚合
    if (f.kind !== 'policy') {
      byTier[f.tier] = (byTier[f.tier] ?? 0) + 1
      byBookability[f.bookability] = (byBookability[f.bookability] ?? 0) + 1
      if (f.bookability === 'unverified') unverified += 1
    }
  }
  return {
    schema: 'gotry_deck_manifest.v1',
    exported_at: exportedAt.toISOString(),
    deck: { basename: `${basename}${ITINERARY_DECK_EXPORT_HTML_SUFFIX}`, sha256: '', bytes: 0 },
    facts: { total: facts.length, by_kind: byKind, source_tags: sourceTags.slice(0, SOURCE_TAG_SAMPLE) },
    evidence_chain: { unverified, by_tier: byTier, by_bookability: byBookability },
    target_url: targetUrl,
    share_intent: { qr: 'generated', qr_path: `${basename}${ITINERARY_DECK_EXPORT_QR_SUFFIX}` },
  }
}

/** sha256 + bytes 在 manifest 写盘前用真实 html 填回,避免 hash of empty buffer 的占位 */
function stampManifest(manifest: Record<string, unknown>, html: string): Record<string, unknown> {
  const sha256 = createHash('sha256').update(Buffer.from(html, 'utf8')).digest('hex')
  const bytes = Buffer.byteLength(html, 'utf8')
  const deck = manifest.deck as Record<string, unknown>
  return { ...manifest, deck: { ...deck, sha256, bytes } }
}

/** qr.svg 真矩阵编码(issue #569,Phase B 切片 3b):用 npm `qrcode` 库直接渲染 SVG,
 * 编码目标 URL 或本地 bundle 入口(无 target_url 时退化为 file://)。
 * error correction level 默认 M(15% 冗余,适合带 logo / 抗打印 / 二维码扫描容错);
 * margin=2(ISO 标准 4 模块静默区中的 2——可扫描 + 视觉紧凑)。
 * SVG 是自包含 XML,可在任意现代浏览器/扫码 app 直接渲染。 */
async function qrSvgFor(payload: string): Promise<string> {
  return QRCode.toString(payload, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
  })
}

/**
 * 生成一份 deck 静态导出 bundle。写入唯一目标 = target_dir 顶层三个文件;
 * 事实唯一来源 = deps.stateRoot 的事实注册表;basename 走 ASCII 契约。
 */
export async function generateItineraryDeckExport(input: unknown, deps: ItineraryDeckExportDeps): Promise<ItineraryDeckExportResult> {
  if (!isRecord(input)) return { ok: false, error: 'input 必须是对象 {title, itinerary, fact_ids, target_dir?, target_url?, basename?}' }

  const ids = takeFactIds(input.fact_ids)
  if ('error' in ids) return { ok: false, error: ids.error, hint: ids.hint }
  const named = takeBasename(input.basename)
  if ('error' in named) return { ok: false, error: named.error, hint: named.hint }
  const url = takeTargetUrl(input.target_url)
  if ('error' in url) return { ok: false, error: url.error }

  const registry = await loadFactRegistry(deps.stateRoot)
  const byId = new Map(registry.map(f => [f.fact_id, f]))
  const missing = ids.ids.filter(id => !byId.has(id))
  if (missing.length > 0) {
    return {
      ok: false,
      error: `事实 id 未在当前注册表:${missing.slice(0, ID_SAMPLE).join('、')}${missing.length > ID_SAMPLE ? ` 等 ${missing.length} 条` : ''}`,
      hint: 'fact_ids 只能取自本会话 exact-date 工具结果的注册表;不接受调用方自带事实对象,也不从 Markdown 猜事实',
    }
  }
  // 顺序保留调用方选择;登记行畸形不在选择阶段放宽——交给 deck 渲染器运行时校验显式拒绝
  const selected = ids.ids.map(id => byId.get(id)!)

  const rendered = renderItineraryDeck({ title: input.title, itinerary: input.itinerary, facts: selected })
  if (!rendered.ok) {
    return {
      ok: false,
      error: '渲染被拒:行程或事实不满足渲染契约,未写入任何文件',
      errors: rendered.errors,
      hint: '按 errors 修正显式行程结构或换用合法登记的事实;本工具不会静默截断核心行程',
    }
  }

  const dir = await resolveWritableDir(deps.targetDir)
  if ('error' in dir) return { ok: false, error: dir.error, hint: dir.hint }

  const files = bundleFileNames(named.basename)
  const slot = await assertBundleSlot(dir.dir, files)
  if ('error' in slot) return { ok: false, error: slot.error, hint: slot.hint }

  const exportedAt = (deps.now ?? (() => new Date()))()
  const manifest = stampManifest(
    buildManifest(named.basename, selected, exportedAt, url.targetUrl),
    rendered.html,
  )

  // 写盘顺序:HTML → manifest(含 sha256 已填)→ qr.svg 占位;任一失败即回滚已落盘文件
  const htmlPath = join(dir.dir, files.html)
  const manifestPath = join(dir.dir, files.manifest)
  const qrPath = join(dir.dir, files.qr)
  const writtenHtml = await writeExclusive(htmlPath, rendered.html)
  if ('error' in writtenHtml) return { ok: false, error: writtenHtml.error, hint: writtenHtml.hint }
  const writtenManifest = await writeExclusive(manifestPath, JSON.stringify(manifest, null, 2))
  if ('error' in writtenManifest) return { ok: false, error: writtenManifest.error, hint: writtenManifest.hint }
  // QR 编码目标:有 target_url 用之;无则退化为 file:// 占位(deck 本地路径 + 警示注释,
  // 让扫码应用拿到至少是个可解析字符串——manifest.share_intent.qr_intent 标记 'local_only')
  const qrTarget = url.targetUrl && url.targetUrl.length > 0
    ? url.targetUrl
    : `<local bundle; not yet hosted>`
  const qrSvg = await qrSvgFor(qrTarget)
  const writtenQr = await writeExclusive(qrPath, qrSvg)
  if ('error' in writtenQr) return { ok: false, error: writtenQr.error, hint: writtenQr.hint }

  const totalBytes = writtenHtml.bytes + writtenManifest.bytes + writtenQr.bytes
  return {
    ok: true,
    target_dir: dir.dir,
    basename: named.basename,
    files: { html: htmlPath, manifest: manifestPath, qr: qrPath },
    bytes: totalBytes,
    fact_ids: ids.ids,
    overall_verified: false,
  }
}