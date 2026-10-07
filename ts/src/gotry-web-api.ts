/** Native Connection routes. Secrets never enter model tools or conversation events. */
import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { verifyFlyaiCandidate } from '../../bin/gotry-flyai-verification.js'
import { listArtifacts } from '../capabilities/artifacts.ts'
import {
  atomicWriteJson, clearFlyaiKey, displayEndpoint, endpointFingerprint, flyaiConfigPath,
  isPlaceholderFlyaiKey, maskFlyaiKey, readFlyaiConfig, readFlyaiVerification,
  removeFlyaiVerification, resolveFlyaiEndpoint, resolveFlyaiKey, saveFlyaiKey,
  sha256Hex, writeFlyaiVerification,
} from '../capabilities/flyai-config.ts'
import {
  hbcliCredentialPath, hbcliSetupStatus, readHbcliCredentials, removeHbcliVerification,
  verifyHbcliCandidate, withHbcliCredentials, withoutHbcliCredentials, writeHbcliCredentials, writeHbcliVerification,
} from '../capabilities/hbcli-config.ts'

interface WebOptions {
  stateRoot: string
  homeDir?: string
  env?: NodeJS.ProcessEnv
  hbcliBin?: string
  workspaceForSession: (sessionId: string) => Promise<string | undefined>
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const rejection = (error: string, status = 400) => json({ ok: false, error }, status)
const BODY_LIMIT = 8192

async function readInput(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return rejection('需要 JSON 请求。', 415)
  const reader = request.body?.getReader()
  if (!reader) return rejection('请求为空。')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > BODY_LIMIT) { await reader.cancel(); return rejection('请求过大。', 413) }
      chunks.push(chunk.value)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : rejection('请求无效。')
  } catch { return rejection('请求无效。') }
  finally { reader.releaseLock() }
}

export function createGotryWebHandlers(options: WebOptions) {
  const homeDir = options.homeDir ?? homedir(), env = options.env ?? process.env
  const paths = { homeDir, env }, configPath = flyaiConfigPath(homeDir)
  const hbPaths = { homeDir, env, hbcliBin: options.hbcliBin }
  let mutations: Promise<unknown> = Promise.resolve()
  const status = () => {
    const current = resolveFlyaiKey(paths), endpoint = resolveFlyaiEndpoint(paths), receipt = readFlyaiVerification(homeDir)
    const matches = current.key && receipt?.keySha256 === sha256Hex(current.key) && receipt.source === current.source
      && receipt.endpointFingerprint === endpointFingerprint(endpoint.url) && receipt.endpointDebug === endpoint.debug
    return { ok: true, configured: Boolean(current.key), verified: Boolean(matches && receipt?.verdict === 'verified'),
      writable: current.source !== 'env' && current.source !== 'env-debug' && process.platform !== 'win32', source: current.source,
      endpoint: displayEndpoint(endpoint.url), endpointDebug: endpoint.debug,
      ...(matches && receipt ? { checkedAt: receipt.at, verdict: receipt.verdict } : {}) }
  }
  const bytesAt = () => existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined
  async function mutate(input: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    if (signal.aborted) return rejection('操作已取消。', 409)
    if (!status().writable) return rejection('当前 Key 由环境变量提供或此平台不支持安全写入。', 409)
    if (input.action === 'clear') {
      const result = clearFlyaiKey(paths)
      if (!result.ok) return rejection('无法清除配置，请检查本机配置文件及权限。', 409)
      removeFlyaiVerification(homeDir)
      return json(status())
    }
    const key = typeof input.key === 'string' ? input.key.trim() : ''
    if (!key || key.length > 2048 || /[\r\n\0]/.test(key) || isPlaceholderFlyaiKey(key)) return rejection('请粘贴控制台中的真实 API Key。')
    const before = readFlyaiConfig(configPath)
    if (!before.ok) return rejection('原配置损坏，已保留原文件，请先修复。', 409)
    const previousBytes = bytesAt(), endpoint = resolveFlyaiEndpoint(paths), fingerprint = endpointFingerprint(endpoint.url)
    if (!fingerprint) return rejection('当前服务地址无效。', 409)
    const verify = await verifyFlyaiCandidate(key, { env: { ...env, HOME: homeDir }, signal })
    if (signal.aborted || verify.verdict !== 'hit') return json({ ok: false, verdict: signal.aborted ? 'cancelled' : verify.verdict,
      error: signal.aborted ? '验证已取消，旧配置保留。' : verify.error ?? '验证失败，旧配置保留。' }, 422)
    if (!status().writable || bytesAt() !== previousBytes || fingerprint !== endpointFingerprint(resolveFlyaiEndpoint(paths).url)) {
      return rejection('配置在验证期间发生变化，请重新读取后再试。', 409)
    }
    const saved = saveFlyaiKey(key, paths)
    if (!saved.ok) return rejection('安全保存失败，旧配置保留，请检查本机权限。', 409)
    const receiptSaved = writeFlyaiVerification({ schema: 'gotry.flyai-verification.v1', source: 'config',
      keySha256: sha256Hex(key), maskedKey: maskFlyaiKey(key), verdict: 'verified', endpointFingerprint: fingerprint,
      endpointDebug: endpoint.debug, at: new Date().toISOString() }, homeDir)
    if (!receiptSaved) {
      const restored = previousBytes === undefined
        ? (() => { try { rmSync(configPath, { force: true }); return true } catch { return false } })()
        : atomicWriteJson(configPath, before.data).ok
      return rejection(restored ? '验证回执保存失败，旧配置已恢复。' : '验证回执保存失败，恢复旧配置失败，请检查本机文件。', 409)
    }
    return json(status())
  }
  async function mutateHbcli(input: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    if (signal.aborted) return rejection('操作已取消。', 409)
    if (!hbcliSetupStatus(hbPaths).writable) return rejection('当前凭证来自环境变量，或本机配置不可安全写入。', 409)
    const before = readHbcliCredentials(hbPaths)
    if (!before.ok) return rejection('原配置损坏，已保留原文件，请先修复。', 409)
    if (input.action === 'clear') {
      if (!writeHbcliCredentials(withoutHbcliCredentials(before.data), hbPaths)) return rejection('无法清除配置，请检查本机文件及权限。', 409)
      removeHbcliVerification(homeDir)
      return json(hbcliSetupStatus(hbPaths))
    }
    const appKey = typeof input.appKey === 'string' ? input.appKey.trim() : ''
    const appSecret = typeof input.appSecret === 'string' ? input.appSecret.trim() : ''
    if ([appKey, appSecret].some(value => !value || value.length > 2048 || /[\r\n\0]/.test(value))) return rejection('请填写 HotelByte 提供的 App Key 和 App Secret。')
    const verified = await verifyHbcliCandidate(appKey, appSecret, hbPaths, signal)
    if (signal.aborted || verified.verdict === 'error' || verified.verdict === 'cancelled') {
      return json({ ok: false, error: verified.error ?? '验证已取消，旧配置保留。' }, 422)
    }
    const current = readHbcliCredentials(hbPaths)
    if (!hbcliSetupStatus(hbPaths).writable || !current.ok || current.bytes !== before.bytes) return rejection('配置在验证期间发生变化，请重新读取后再试。', 409)
    const next = withHbcliCredentials(before.data, appKey, appSecret)
    if (!writeHbcliCredentials(next, hbPaths)) return rejection('安全保存失败，旧配置保留，请检查本机权限。', 409)
    if (!writeHbcliVerification(next, verified.verdict, hbPaths)) {
      const restored = before.bytes === undefined
        ? (() => { try { rmSync(hbcliCredentialPath(hbPaths)); return true } catch { return false } })()
        : writeHbcliCredentials(before.data, hbPaths)
      return rejection(restored ? '验证回执保存失败，旧配置已恢复。' : '验证回执保存失败，请检查本机文件。', 409)
    }
    return json(hbcliSetupStatus(hbPaths))
  }
  return {
    async hbcli(request: Request): Promise<Response> {
      if (request.method === 'GET') return json(hbcliSetupStatus(hbPaths))
      if (request.method !== 'POST') return rejection('不支持此操作。', 405)
      const input = await readInput(request)
      if (input instanceof Response) return input
      if (!['save', 'clear'].includes(String(input.action))
        || Object.keys(input).some(key => !['action', 'appKey', 'appSecret'].includes(key))
        || (input.action === 'clear' && ('appKey' in input || 'appSecret' in input))) return rejection('请求无效。')
      const operation = mutations.then(() => mutateHbcli(input, request.signal)).catch(() => rejection('操作失败，未能确认保存，请重新读取状态。', 500))
      mutations = operation.then(() => undefined)
      return operation
    },
    async flyai(request: Request): Promise<Response> {
      if (request.method === 'GET') return json(status())
      if (request.method !== 'POST') return rejection('不支持此操作。', 405)
      const input = await readInput(request)
      if (input instanceof Response) return input
      if (!['save', 'clear'].includes(String(input.action)) || Object.keys(input).some(key => key !== 'action' && key !== 'key')
        || (input.action === 'clear' && 'key' in input)) return rejection('请求无效。')
      const operation = mutations.then(() => mutate(input, request.signal)).catch(() => rejection('操作失败，未能确认保存，请重新读取状态。', 500))
      mutations = operation.then(() => undefined)
      return operation
    },
    async artifacts(request: Request): Promise<Response> {
      const query = new URL(request.url).searchParams
      if ([...query.keys()].some(key => !['sessionId', 'search', 'offset', 'limit'].includes(key))) return rejection('查询字段无效。')
      const sessionId = query.get('sessionId') ?? ''
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(sessionId)) return rejection('需要有效会话。')
      const cwd = await options.workspaceForSession(sessionId)
      if (!cwd || !isAbsolute(cwd)) return rejection('会话工作目录不可用。', 404)
      try {
        return json({ ok: true, ...await listArtifacts({ stateRoot: options.stateRoot, cwd,
          handoffRoot: env.GOTRY_TURN_HANDOFF_ROOT ?? (options.stateRoot !== '.' ? options.stateRoot : cwd),
          search: query.get('search') ?? undefined, offset: query.has('offset') ? Number(query.get('offset')) : undefined,
          limit: query.has('limit') ? Number(query.get('limit')) : 20 }) })
      } catch { return rejection('查询参数无效或产物暂时不可读取。') }
    },
  }
}

export function registerGotryWebApi(ctx: Context, stateRoot: string, hbcliBin?: string): void {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['connection', 'sessions'], scope => {
    const connection = scope.get('connection') as HostConnectionHandle
    const handlers = createGotryWebHandlers({ stateRoot, hbcliBin, workspaceForSession: async sessionId => {
      const id = sessionId as Parameters<typeof scope.sessions.get>[0]
      const live = scope.sessions.get(id)?.header
      const stored = live ? undefined : await scope.get('sessionPersistence')?.stat(sessionId)
      return (live ?? stored?.header)?.cwd
    } })
    // DSH's streaming adapter always attaches a request body; GET cannot use
    // it. Exact routes have one body mode, so reads and bounded writes differ.
    scope.effect(() => connection.fetch.register({ path: '/api/gotry/flyai', methods: ['GET'], requestBody: 'buffered', fetch: handlers.flyai }))
    scope.effect(() => connection.fetch.register({ path: '/api/gotry/flyai/write', methods: ['POST'], requestBody: 'streaming', fetch: handlers.flyai }))
    scope.effect(() => connection.fetch.register({ path: '/api/gotry/hbcli', methods: ['GET'], requestBody: 'buffered', fetch: handlers.hbcli }))
    scope.effect(() => connection.fetch.register({ path: '/api/gotry/hbcli/write', methods: ['POST'], requestBody: 'streaming', fetch: handlers.hbcli }))
    scope.effect(() => connection.fetch.register({ path: '/api/gotry/artifacts', methods: ['GET'], requestBody: 'buffered', fetch: handlers.artifacts }))
  })
}
