/** Official hbcli credential-file contract; no credentials enter tool results. */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { atomicWriteJson, sha256Hex } from './flyai-config.ts'
import { hbcliBinCandidates } from './hbcli.ts'
import { spawnBounded } from './spawn-bounded.ts'

export const HBCLI_REGISTRATION_URL = 'https://hotelbyte.com/zh/guides/sandbox-verification'
const ENVIRONMENT = 'uat'
const ENTRY = `openapi:${ENVIRONMENT}`
export interface HbcliConfigOptions { homeDir?: string; env?: NodeJS.ProcessEnv; hbcliBin?: string }
export type HbcliSetupVerdict = 'hit' | 'miss' | 'no-suppliers'
interface Verification { schema: 'gotry.hbcli-verification.v1'; fingerprint: string; verdict: HbcliSetupVerdict; at: string }

export function hbcliCredentialRoot(options: HbcliConfigOptions): string {
  return options.env?.STAICLI_HOME?.trim() || join(options.homeDir ?? homedir(), '.staicli')
}
export function hbcliCredentialPath(options: HbcliConfigOptions): string { return join(hbcliCredentialRoot(options), 'credentials.json') }
export function hbcliVerificationPath(homeDir: string): string { return join(homeDir, '.gotry', 'hbcli-verification.json') }

function safeEntry(path: string, directory: boolean): boolean {
  try {
    const entry = lstatSync(path)
    return !entry.isSymbolicLink() && (directory ? entry.isDirectory() : entry.isFile())
      && (typeof process.getuid !== 'function' || entry.uid === process.getuid())
  } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' }
}
export function readHbcliCredentials(options: HbcliConfigOptions): { ok: true; data: Record<string, unknown>; bytes?: string } | { ok: false } {
  const root = hbcliCredentialRoot(options), file = hbcliCredentialPath(options)
  try {
    if (!isAbsolute(root) || !safeEntry(root, true) || !safeEntry(file, false)) return { ok: false }
    if (!existsSync(file)) return { ok: true, data: {} }
    const bytes = readFileSync(file, 'utf8'), data: unknown = JSON.parse(bytes)
    return data && typeof data === 'object' && !Array.isArray(data) ? { ok: true, data: data as Record<string, unknown>, bytes } : { ok: false }
  } catch { return { ok: false } }
}
function fingerprint(data: Record<string, unknown>): string | undefined {
  const entry = data[ENTRY] as { appKey?: unknown; appSecret?: unknown } | undefined
  return typeof entry?.appKey === 'string' && entry.appKey.trim() && typeof entry.appSecret === 'string' && entry.appSecret.trim()
    ? sha256Hex(JSON.stringify([ENVIRONMENT, entry.appKey, entry.appSecret])) : undefined
}
function readReceipt(home: string): Verification | undefined {
  try {
    const path = hbcliVerificationPath(home)
    if (!safeEntry(join(home, '.gotry'), true) || !safeEntry(path, false)) return undefined
    const v = JSON.parse(readFileSync(path, 'utf8')) as Verification
    return v.schema === 'gotry.hbcli-verification.v1' && typeof v.fingerprint === 'string'
      && ['hit', 'miss', 'no-suppliers'].includes(v.verdict) && Number.isFinite(Date.parse(v.at)) ? v : undefined
  } catch { return undefined }
}
export function hbcliSetupStatus(options: HbcliConfigOptions) {
  const read = readHbcliCredentials(options), hash = read.ok ? fingerprint(read.data) : undefined
  const receipt = readReceipt(options.homeDir ?? homedir())
  const envToken = Boolean(options.env?.HOTELBYTE_TOKEN?.trim())
  const matches = !envToken && hash && receipt?.fingerprint === hash
  return { ok: true, configured: envToken || Boolean(hash), writable: read.ok && !envToken && process.platform !== 'win32',
    source: envToken ? 'env' : hash ? 'config' : 'none', environment: ENVIRONMENT,
    verified: Boolean(matches && receipt?.verdict !== 'no-suppliers'),
    ...(matches && receipt ? { verdict: receipt.verdict, checkedAt: receipt.at } : {}), registrationUrl: HBCLI_REGISTRATION_URL }
}

function prepareDirectory(dir: string): boolean {
  try {
    if (process.platform === 'win32' || !isAbsolute(dir) || !safeEntry(dir, true)) return false
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!safeEntry(dir, true)) return false
    chmodSync(dir, 0o700)
    return true
  } catch { return false }
}
export function writeHbcliCredentials(data: Record<string, unknown>, options: HbcliConfigOptions): boolean {
  const path = hbcliCredentialPath(options)
  return readHbcliCredentials(options).ok && prepareDirectory(hbcliCredentialRoot(options)) && atomicWriteJson(path, data).ok
}
export function writeHbcliVerification(data: Record<string, unknown>, verdict: HbcliSetupVerdict, options: HbcliConfigOptions): boolean {
  const hash = fingerprint(data), home = options.homeDir ?? homedir()
  if (!hash || !prepareDirectory(join(home, '.gotry'))) return false
  const entry: Verification = { schema: 'gotry.hbcli-verification.v1', fingerprint: hash, verdict, at: new Date().toISOString() }
  return safeEntry(hbcliVerificationPath(home), false) && atomicWriteJson(hbcliVerificationPath(home), entry).ok
}
export function removeHbcliVerification(homeDir: string): void {
  if (safeEntry(join(homeDir, '.gotry'), true) && safeEntry(hbcliVerificationPath(homeDir), false)) {
    try { rmSync(hbcliVerificationPath(homeDir), { force: true }) } catch { /* best effort */ }
  }
}
export function withHbcliCredentials(data: Record<string, unknown>, appKey: string, appSecret: string): Record<string, unknown> {
  return { ...data, [ENTRY]: { appKey, appSecret } }
}
export function withoutHbcliCredentials(data: Record<string, unknown>): Record<string, unknown> {
  const next = { ...data }; delete next[ENTRY]; return next
}

/** Verify through the existing CLI bridge, with a private disposable credential root.
 * An upstream no-suppliers verdict is retained separately from a completed query.
 */
export async function verifyHbcliCandidate(appKey: string, appSecret: string, options: HbcliConfigOptions, signal: AbortSignal): Promise<{ verdict: HbcliSetupVerdict | 'error' | 'cancelled'; error?: string }> {
  const root = mkdtempSync(join(tmpdir(), 'gotry-hbcli-verify-'))
  try {
    if (!atomicWriteJson(join(root, 'credentials.json'), withHbcliCredentials({}, appKey, appSecret)).ok) {
      return { verdict: 'error', error: '无法创建隔离的验证环境。' }
    }
    const checkIn = new Date(); checkIn.setUTCDate(checkIn.getUTCDate() + 1)
    const checkOut = new Date(checkIn); checkOut.setUTCDate(checkOut.getUTCDate() + 1)
    const args = ['--json', '--env', ENVIRONMENT, 'search', 'hotel-list', '--destination-name', '上海',
      '--check-in', checkIn.toISOString().slice(0, 10), '--check-out', checkOut.toISOString().slice(0, 10),
      '--room-occupancies', '[{"adultCount":2,"childrenAges":[]}]', '--page-size', '1']
    const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), STAICLI_HOME: root, HOTELBYTE_ENV: ENVIRONMENT }
    delete env.HOTELBYTE_TOKEN
    let result: Awaited<ReturnType<typeof spawnBounded>> | undefined
    for (const bin of hbcliBinCandidates(options.hbcliBin ?? options.env?.GOTRY_HBCLI_BIN ?? 'hbcli', options.homeDir)) {
      result = await spawnBounded(bin, args, { env, signal, timeoutMs: 20_000 })
      if (!/ENOENT/.test(result.error ?? '') || signal.aborted) break
    }
    if (signal.aborted || result?.aborted) return { verdict: 'cancelled', error: '验证已取消，旧配置保留。' }
    if (!result || result.error || result.timedOut || result.drainTimedOut || result.groupReaped === false || result.code !== 0) {
      return { verdict: 'error', error: 'HotelByte 验证未完成，请检查 hbcli 安装、网络和凭证；旧配置保留。' }
    }
    let value: { code?: unknown; list?: unknown }
    try { value = JSON.parse(result.stdout) } catch { return { verdict: 'error', error: 'HotelByte 回包无法识别，旧配置保留。' } }
    if (value?.code === 300010002 || value?.code === '300010002') return { verdict: 'no-suppliers' }
    if (!value || (value.code !== undefined && value.code !== 0 && value.code !== '0') || !Array.isArray(value.list)
      || value.list.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      return { verdict: 'error', error: 'HotelByte 未接受凭证或返回了无效的查询结果；旧配置保留。' }
    }
    return { verdict: value.list.length ? 'hit' : 'miss' }
  } finally { rmSync(root, { recursive: true, force: true }) }
}
