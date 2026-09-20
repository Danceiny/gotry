/**
 * FlyAI API key 配置面(issue #521;供应商 skill setup 体验核心)。
 *
 * 与官方 @fly-ai/flyai-cli 1.0.16 的配置机制严格对齐(解包核实,非猜测):
 *   key = env FLYAI_API_KEY(trim 非空)→ env DEBUG_FLYAI_API_KEY(trim 非空)
 *       → ~/.flyai/config.json 的 FLYAI_API_KEY 字段 → 内置共享 key(匿名试用);
 *   endpoint = env DEBUG_FLYAI_MCP_URL(trim 非空)→ 官方默认;
 *   空串/纯空白 env 一律视为未设置(官方 helper 用 c&&c.trim()!=='' 判定,
 *   不是 nullish 判定)。
 *
 * 文件路径/格式 = 官方 `flyai config set` 的 ~/.flyai/config.json 扁平 JSON;
 * 写时读入整对象只动 FLYAI_API_KEY,其他字段原样保留。
 *
 * 安全契约:
 *   - 原配置损坏(坏 JSON/非对象)→ save/clear/write 全部拒绝并保留原字节,
 *     由调用方向用户显式报错;绝不静默覆盖丢字段;
 *   - 原子写 = tmp 文件 + rename;finally 中删除本操作拥有的 tmp,
 *     rename 失败也不留含明文的残留文件;
 *   - 权限是硬要求:目录 0700、文件 0600 必须实测;chmod 失败即整体失败,
 *     best-effort 不算安全存储;
 *   - 对外面只回显 maskFlyaiKey 脱敏值。
 *
 * @module capabilities/flyai-config
 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type FlyaiKeySource = 'env' | 'env-debug' | 'config' | 'none'

export interface FlyaiConfigPaths {
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

export interface ResolvedFlyaiKey {
  key?: string
  source: FlyaiKeySource
  /** ~/.flyai/config.json 绝对路径(无论是否存在) */
  configPath: string
  /** 脱敏值(source!=='none' 时) */
  maskedKey?: string
}

export interface ResolvedFlyaiEndpoint {
  url: string
  /** true = 被 DEBUG_FLYAI_MCP_URL 覆盖(展示必须标注) */
  debug: boolean
}

export interface SaveFlyaiKeyResult {
  ok: boolean
  savedTo?: string
  /** 写入后当前实际生效来源(env 优先时文件写入不改生效来源) */
  source?: FlyaiKeySource
  maskedKey?: string
  error?: string
  envActive?: boolean
}

export interface ClearFlyaiKeyResult {
  ok: boolean
  removedFrom?: string
  source: FlyaiKeySource
  maskedKey?: string
  error?: string
}

export function flyaiConfigPath(homeDir: string): string {
  return join(homeDir, '.flyai', 'config.json')
}

/** ~/.gotry/flyai-verification.json(与 calendar.json 同 ~/.gotry) */
export function flyaiVerificationPath(homeDir: string): string {
  return join(homeDir, '.gotry', 'flyai-verification.json')
}

/** 与官方 1.0.16 同款:存在且 trim 非空才算值;空串/空白/非字符串 = undefined */
function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text || undefined
}

export type FlyaiConfigRead =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * 严格读取 config.json:
 *   不存在/空文件 → ok+空对象;
 *   JSON 损坏/顶层非对象 → ok:false(调用方必须拒绝写入并保留字节)。
 */
export function readFlyaiConfig(configPath: string): FlyaiConfigRead {
  try {
    if (!existsSync(configPath)) return { ok: true, data: {} }
    const text = readFileSync(configPath, 'utf8')
    if (!text.trim()) return { ok: true, data: {} }
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'config 顶层不是 JSON 对象' }
    }
    return { ok: true, data: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, error: 'config JSON 解析失败（为保护凭据，不显示原文）' }
  }
}

/**
 * 解析当前生效 FlyAI key(官方 1.0.16 同优先级):
 *   FLYAI_API_KEY → DEBUG_FLYAI_API_KEY → config 文件 → none(官方内置共享)。
 */
export function resolveFlyaiKey(opts: FlyaiConfigPaths = {}): ResolvedFlyaiKey {
  const homeDir = opts.homeDir ?? homedir()
  const env = opts.env ?? process.env
  const configPath = flyaiConfigPath(homeDir)
  const envKey = nonEmpty(env.FLYAI_API_KEY)
  if (envKey) return { key: envKey, source: 'env', configPath, maskedKey: maskFlyaiKey(envKey) }
  const debugKey = nonEmpty(env.DEBUG_FLYAI_API_KEY)
  if (debugKey) return { key: debugKey, source: 'env-debug', configPath, maskedKey: maskFlyaiKey(debugKey) }
  const read = readFlyaiConfig(configPath)
  const fileKey = read.ok ? nonEmpty(read.data.FLYAI_API_KEY) : undefined
  if (fileKey) return { key: fileKey, source: 'config', configPath, maskedKey: maskFlyaiKey(fileKey) }
  return { source: 'none', configPath }
}

/** 解析 endpoint;DEBUG_FLYAI_MCP_URL trim 非空覆盖,显式标注调试态 */
export function resolveFlyaiEndpoint(opts: FlyaiConfigPaths = {}): ResolvedFlyaiEndpoint {
  const env = opts.env ?? process.env
  const debugUrl = nonEmpty(env.DEBUG_FLYAI_MCP_URL)
  if (debugUrl) return { url: debugUrl, debug: true }
  return { url: 'https://flyai.open.fliggy.com/mcp', debug: false }
}

/** 脱敏:仅尾 4 位;短串(≤4)全掩 */
export function maskFlyaiKey(key: string): string {
  const text = typeof key === 'string' ? key.trim() : ''
  if (!text) return ''
  if (text.length <= 4) return '****'
  return `****${text.slice(-4)}`
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** 明显占位/模板串——拒绝把文档示例当 key */
export function isPlaceholderFlyaiKey(key: string): boolean {
  const text = key.trim().toLowerCase()
  if (!text) return true
  return /^(your?-?(key|api[._-]?key)|xxxx+|<[^>]+>|sk-[a-z]*$|test|placeholder|changeme|foo|bar)$/.test(text)
}

/**
 * 权限硬校验:dir 必须 0700,file(存在时)必须 0600。
 * Windows 无 POSIX 位:返回 unsupported(调用方按平台说明,不冒充通过)。
 */
export function verifySecureMode(dir: string, file: string): { ok: boolean; error?: string; unsupported?: boolean } {
  if (process.platform === 'win32') return { ok: false, unsupported: true }
  try {
    const dirMode = statSync(dir).mode & 0o777
    if (dirMode !== 0o700) return { ok: false, error: `目录权限 ${dirMode.toString(8)} ≠ 700` }
    if (existsSync(file)) {
      const fileMode = statSync(file).mode & 0o777
      if (fileMode !== 0o600) return { ok: false, error: `文件权限 ${fileMode.toString(8)} ≠ 600` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * 原子写 JSON 文件(本模块 save/clear/verification 共用的唯一写面):
 *   1. dir 不存在则建,chmod 0700;已存在则先按 0700 校验;
 *   2. tmp(同目录,mode 0600)写内容 → 校验 tmp 0600 → rename;
 *   3. rename 后校验目标 0600;任一步失败:删除本 tmp 并返回 error;
 *   4. tmp 清理放在 finally——rename 失败也不留含明文残留。
 * 永不抛错。
 */
export function atomicWriteJson(path: string, value: unknown): { ok: boolean; error?: string } {
  const dir = dirname(path)
  let tmp: string | undefined
  try {
    const dirExisted = existsSync(dir)
    mkdirSync(dir, { recursive: true })
    if (!dirExisted) chmodSync(dir, 0o700)
    const dirCheck = verifySecureMode(dir, path)
    if (dirCheck.unsupported) return { ok: false, error: 'Windows 无 0700/0600 权限位,安全写不支持' }
    if (!dirCheck.ok) return { ok: false, error: dirCheck.error }

    tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    let modeCheck = verifySecureMode(dir, tmp)
    if (!modeCheck.ok) return { ok: false, error: modeCheck.error }

    renameSync(tmp, path)
    tmp = undefined
    modeCheck = verifySecureMode(dir, path)
    if (!modeCheck.ok) return { ok: false, error: modeCheck.error }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    if (tmp) { try { rmSync(tmp, { force: true }) } catch { /* tmp 清理 best effort */ } }
  }
}

/**
 * 保存 key 到 ~/.flyai/config.json:
 *   非空/非占位;原配置损坏 → 拒绝保留字节;只改 FLYAI_API_KEY 字段;
 *   原子写 + 权限硬校验。失败不动旧文件。
 */
export function saveFlyaiKey(key: string, opts: FlyaiConfigPaths = {}): SaveFlyaiKeyResult {
  const text = typeof key === 'string' ? key.trim() : ''
  const homeDir = opts.homeDir ?? homedir()
  const env = opts.env ?? process.env
  const configPath = flyaiConfigPath(homeDir)
  if (!text) return { ok: false, error: 'API key 不能为空' }
  if (isPlaceholderFlyaiKey(text)) return { ok: false, error: '拒绝保存:这是文档占位串,不是真实 API key' }

  const read = readFlyaiConfig(configPath)
  if (!read.ok) return { ok: false, error: `原配置损坏,已拒绝覆盖(${read.error});请先人工修复 ${configPath}` }

  const write = atomicWriteJson(configPath, { ...read.data, FLYAI_API_KEY: text })
  if (!write.ok) return { ok: false, error: write.error }

  const envKey = nonEmpty(env.FLYAI_API_KEY)
  const debugKey = nonEmpty(env.DEBUG_FLYAI_API_KEY)
  const source: FlyaiKeySource = envKey ? 'env' : debugKey ? 'env-debug' : 'config'
  return {
    ok: true,
    savedTo: configPath,
    source,
    maskedKey: maskFlyaiKey(text),
    ...(envKey || debugKey ? { envActive: true } : {}),
  }
}

/**
 * 清除 config.json 的 FLYAI_API_KEY 字段:
 *   原配置损坏 → 拒绝保留字节;含字段则删(对象空=移除文件,否则原子写保留其他键);
 *   不含字段=幂等成功;env/debug 来源文件操作清不掉,source 如实标注。
 */
export function clearFlyaiKey(opts: FlyaiConfigPaths = {}): ClearFlyaiKeyResult {
  const homeDir = opts.homeDir ?? homedir()
  const env = opts.env ?? process.env
  const configPath = flyaiConfigPath(homeDir)
  const read = readFlyaiConfig(configPath)
  if (!read.ok) return { ok: false, source: 'none', error: `原配置损坏,已拒绝操作(${read.error});请先人工修复 ${configPath}` }

  let removedFrom: string | undefined
  if (Object.prototype.hasOwnProperty.call(read.data, 'FLYAI_API_KEY')) {
    const next = { ...read.data }
    delete next.FLYAI_API_KEY
    if (Object.keys(next).length === 0) {
      try { rmSync(configPath, { force: true }) } catch (e) {
        return { ok: false, source: 'none', error: `移除文件失败:${(e as Error).message}` }
      }
    } else {
      const write = atomicWriteJson(configPath, next)
      if (!write.ok) return { ok: false, source: 'none', error: write.error }
    }
    removedFrom = configPath
  }

  const envKey = nonEmpty(env.FLYAI_API_KEY)
  const debugKey = nonEmpty(env.DEBUG_FLYAI_API_KEY)
  if (envKey) return { ok: true, ...(removedFrom ? { removedFrom } : {}), source: 'env', maskedKey: maskFlyaiKey(envKey) }
  if (debugKey) return { ok: true, ...(removedFrom ? { removedFrom } : {}), source: 'env-debug', maskedKey: maskFlyaiKey(debugKey) }
  return { ok: true, ...(removedFrom ? { removedFrom } : {}), source: 'none' }
}

// ── 验证记录 ~/.gotry/flyai-verification.json ────────────────────────────────

export type FlyaiVerificationVerdict =
  | 'verified'
  | 'auth-error'
  | 'forbidden'
  | 'rate-limited'
  | 'timeout'
  | 'error'
  | 'needs-setup'

export interface FlyaiVerification {
  schema: 'gotry.flyai-verification.v1'
  source: FlyaiKeySource
  /** 生效 key 的 sha256(只判断回执是否属于当前 key,不可逆) */
  keySha256: string
  maskedKey: string
  verdict: FlyaiVerificationVerdict
  /** 完整归一化 endpoint 的 sha256；不把 userinfo/query 明文落到回执。 */
  endpointFingerprint: string
  /** 旧回执兼容字段；新写入不再保存 endpoint 明文。 */
  endpoint?: string
  /** true = 成绩来自 DEBUG endpoint,不能算官方 endpoint 已验证 */
  endpointDebug: boolean
  at: string
}

export function readFlyaiVerification(homeDir: string): FlyaiVerification | undefined {
  try {
    const path = flyaiVerificationPath(homeDir)
    if (!existsSync(path)) return undefined
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    const v = parsed as FlyaiVerification
    if (v.schema !== 'gotry.flyai-verification.v1' || typeof v.keySha256 !== 'string') return undefined
    return v
  } catch {
    return undefined
  }
}

/** 原子写验证记录(权限硬校验);成功=true;失败不抛错 */
export function writeFlyaiVerification(entry: FlyaiVerification, homeDir: string): boolean {
  return atomicWriteJson(flyaiVerificationPath(homeDir), entry).ok
}

export function removeFlyaiVerification(homeDir: string): void {
  try { rmSync(flyaiVerificationPath(homeDir), { force: true }) } catch { /* best effort */ }
}

/** 完整归一化 endpoint，保留 path/query 以使其变化使回执失效。 */
export function normalizeEndpoint(url: string): string | undefined {
  try {
    return new URL(url).href
  } catch {
    return undefined
  }
}

/** endpoint 指纹不可逆，避免调试 URL 的 userinfo/query 落盘。 */
export function endpointFingerprint(url: string): string | undefined {
  const normalized = normalizeEndpoint(url)
  return normalized ? sha256Hex(normalized) : undefined
}

/** 对外展示 endpoint：移除 userinfo、query、fragment；比较仍使用完整指纹。 */
export function displayEndpoint(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname || '/'}${u.search || u.hash ? '?(已隐藏敏感参数)' : ''}`
  } catch {
    return '<非法 endpoint>'
  }
}
