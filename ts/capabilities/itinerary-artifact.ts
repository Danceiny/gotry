/**
 * 行程 HTML 产物生成入口(issue #442,父 #438)。
 *
 * 与纯渲染器(ts/src/itinerary-html.ts)的分工:渲染器只把「显式行程 + 已选事实」
 * 投影成单文件 HTML;本模块是**唯一的产品生成路径**——从当前配置状态根的
 * 事实注册表按 id 选事实、跑渲染器、把产物独占落盘到会话工作目录。
 *
 * 三条硬纪律:
 *   1. 事实只从 <stateRoot>/gotry-state/bookable-facts.jsonl 注册表取:入参只收
 *      fact_ids,调用方自带的事实对象一律不接收;未知/重复/超量 id 显式拒绝,
 *      登记行畸形则由渲染器的运行时校验拒绝(不静默丢弃后仍宣称成功);
 *   2. 只新建文件:basename 限定 gotry-itinerary-<ASCII 安全 token>.html,父目录先
 *      realpath 化并排除 .git/node_modules,再以 O_CREAT|O_EXCL('wx')独占创建,
 *      绝不覆盖既有文件、绝不跟随符号链接改写其目标;
 *   3. 失败即拒绝、零写入:输入非法/事实未注册/渲染被拒/文件名被占用都返回结构化
 *      错误,不落任何字节(校验全部发生在打开文件之前)。
 */

import { randomBytes } from 'node:crypto'
import { open, realpath, stat, unlink } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { loadFactRegistry } from './fact-log.ts'
import { ITINERARY_HTML_LIMITS, renderItineraryHtml } from '../src/itinerary-html.ts'

/** 产物文件名契约:固定前缀 + ASCII 安全 token + .html(无路径分隔符、无前导点) */
export const ITINERARY_ARTIFACT_BASENAME_RE = /^gotry-itinerary-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.html$/
/** 随机默认名(仅 crypto 十六进制;显式 basename 优先) */
export const ITINERARY_ARTIFACT_RANDOM_BYTES = 8
const RANDOM_ATTEMPTS = 3
const DIR_DENY = ['.git', 'node_modules']
const ID_SAMPLE = 3

export interface ItineraryArtifactDeps {
  /** 事实注册表根(config.stateRoot);工具面固定传当前配置,不接受调用方覆盖 */
  stateRoot: string
  /** 会话工作目录(exec 上下文的真实 cwd) */
  cwd: string
}

export type ItineraryArtifactResult =
  | {
    ok: true
    /** 落盘后的真实绝对路径(realpath 结果,供展示「最终落点」) */
    path: string
    basename: string
    bytes: number
    fact_ids: string[]
    /** 本产物永不给整体「已验证」结论,只有逐条事实自带的可下单标注 */
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
  if (value.length > ITINERARY_HTML_LIMITS.facts) {
    return { error: `fact_ids 超出容量上限(${ITINERARY_HTML_LIMITS.facts} 条,实测 ${value.length} 条)` }
  }
  const ids: string[] = []
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const [i, raw] of value.entries()) {
    if (typeof raw !== 'string' || raw.length === 0) return { error: `fact_ids[${i}] 必须是非空字符串` }
    if (raw.length > ITINERARY_HTML_LIMITS.factIdChars) {
      return { error: `fact_ids[${i}] 超出 id 长度上限(${ITINERARY_HTML_LIMITS.factIdChars} 字符)` }
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
    return { basename: `gotry-itinerary-${randomBytes(ITINERARY_ARTIFACT_RANDOM_BYTES).toString('hex')}.html` }
  if (typeof value !== 'string' || value.length === 0) return { error: 'basename 必须是字符串' }
  if (value.includes('/') || value.includes('\\') || value.includes('..')) {
    return { error: 'basename 只能是文件名,不能含路径分隔符或 ..', hint: '形如 gotry-itinerary-2027-thailand.html' }
  }
  if (!ITINERARY_ARTIFACT_BASENAME_RE.test(value)) {
    return { error: 'basename 不符合命名契约', hint: '必须是 gotry-itinerary-<ASCII 字母/数字/._->.html(前缀后 1-64 字符)' }
  }
  return { basename: value }
}

/** 会话工作目录:必须已存在、可 realpath、是目录,且不含 .git/node_modules 段 */
async function resolveWritableDir(cwd: string): Promise<{ dir: string } | { error: string; hint?: string }> {
  const requested = resolve(cwd && cwd.length > 0 ? cwd : '.')
  const canonical = await realpath(requested).catch(() => null)
  if (!canonical) return { error: `会话工作目录不存在或无法解析:${requested}`, hint: '本工具只在真实存在的会话工作目录顶层新建文件' }
  if (hasDeniedSegment(canonical)) {
    return { error: '会话工作目录位于受限段(.git/node_modules)内,拒绝写入', hint: `解析后:${canonical}` }
  }
  const st = await stat(canonical).catch(() => null)
  if (!st?.isDirectory()) return { error: `会话工作目录不是目录:${canonical}` }
  return { dir: canonical }
}

/** 独占创建:wx(O_CREAT|O_EXCL)既拒绝覆盖既有文件,也拒绝落在指向别处的符号链接上 */
async function writeExclusive(dir: string, basename: string, html: string): Promise<{ path: string; bytes: number } | { error: string; hint?: string }> {
  const target = join(dir, basename)
  const bytes = Buffer.byteLength(html, 'utf8')
  let handle
  try {
    handle = await open(target, 'wx', 0o644)
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'EEXIST') {
      return { error: `目标文件已存在,拒绝覆盖:${basename}`, hint: '换一个 basename(不传则自动生成随机名);本工具永不覆盖既有产物' }
    }
    return { error: `无法在会话工作目录新建文件:${fsErrorText(err)}`, hint: `目标目录:${dir}` }
  }
  try {
    await handle.writeFile(html, 'utf-8')
  } catch (err) {
    await handle.close().catch(() => { /* 关闭失败不再覆盖原始写错误 */ })
    await unlink(target).catch(() => { /* 清理半成品失败不改变「本次生成失败」的结论 */ })
    return { error: `写入产物失败:${fsErrorText(err)}`, hint: `目标文件已清理:${target}` }
  }
  await handle.close()
  const finalPath = await realpath(target).catch(() => target)
  return { path: finalPath, bytes }
}

/**
 * 生成一份行程 HTML 产物。写入唯一目标 = 会话工作目录顶层的新文件;
 * 事实唯一来源 = deps.stateRoot 的事实注册表。
 */
export async function generateItineraryArtifact(input: unknown, deps: ItineraryArtifactDeps): Promise<ItineraryArtifactResult> {
  if (!isRecord(input)) return { ok: false, error: 'input 必须是对象 {title, itinerary, fact_ids, basename?}' }

  const ids = takeFactIds(input.fact_ids)
  if ('error' in ids) return { ok: false, error: ids.error, hint: ids.hint }
  const named = takeBasename(input.basename)
  if ('error' in named) return { ok: false, error: named.error, hint: named.hint }

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
  // 顺序保留调用方选择;登记行畸形不在选择阶段放宽——交给渲染器运行时校验显式拒绝
  const selected = ids.ids.map(id => byId.get(id)!)

  const rendered = renderItineraryHtml({ title: input.title, itinerary: input.itinerary, facts: selected })
  if (!rendered.ok) {
    return {
      ok: false,
      error: '渲染被拒:行程或事实不满足渲染契约,未写入任何文件',
      errors: rendered.errors,
      hint: '按 errors 修正显式行程结构或换用合法登记的事实;本工具不会静默截断核心行程',
    }
  }

  const dir = await resolveWritableDir(deps.cwd)
  if ('error' in dir) return { ok: false, error: dir.error, hint: dir.hint }

  for (let attempt = 0; attempt < (input.basename === undefined || input.basename === null ? RANDOM_ATTEMPTS : 1); attempt++) {
    const basename = attempt === 0 ? named.basename : `gotry-itinerary-${randomBytes(ITINERARY_ARTIFACT_RANDOM_BYTES).toString('hex')}.html`
    const written = await writeExclusive(dir.dir, basename, rendered.html)
    if ('error' in written) {
      if (attempt + 1 < RANDOM_ATTEMPTS && input.basename === undefined) continue // 随机名撞车:换名重试
      return { ok: false, error: written.error, hint: written.hint }
    }
    return { ok: true, path: written.path, basename, bytes: written.bytes, fact_ids: ids.ids, overall_verified: false }
  }
  return { ok: false, error: '随机文件名多次撞车,未写入文件' }
}
