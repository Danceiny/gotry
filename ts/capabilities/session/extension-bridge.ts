/**
 * 会话扩展桥(extension-bridge,RFC user-session-data-rfc.md §2.2 通道 C——2026-08-29 founder 定案为 PRIMARY 传输)。
 *
 * 形态:Node http 服务,懒启动单例,只绑 127.0.0.1,端口池 8791-8795(与 extension/manifest.json
 * host_permissions 一一对应,防漂移测试守住);**零新依赖**(node:http 手写,对齐已退役 shell 薄壳
 * 的回环纪律;不引 ws——MV3 Service Worker 靠 ≤20s 的长轮询节奏维持 30s 存活窗口,HTTP 够用)。
 *
 * 授权模型:扩展经「一次性安装」获得信任,每请求校验 Origin ∈ 双通道扩展源白名单
 * (网页发起的跨域请求必带邪恶 Origin,直接 403;POST 端点强制;GET /health /status 是本机
 * 诊断面放行)。不做 CORS——有 host_permissions 的扩展 fetch 天然免预检,网页过不来。
 * 双通道 ID 实录(2026-09-02):unpacked 通道(bundled/GitHub Releases)由 manifest 固定 key
 * 派生 EXTENSION_ID;Chrome Web Store 用商店自己的签名 key 重签(不认 manifest key),
 * 商店版 ID = EXTENSION_ID_STORE。两个 ID 都是 founder 控制的同一扩展,白名单双收。
 *
 * 协议(长轮询):
 *   GET  /health           → lastSeen 刷新(扩展每 ≤30s 一次 + 每次断线重连)
 *   GET  /status           → 诊断面 {port, extensionConnected, lastSeenMsAgo, queued, inFlight, parked}
 *   POST /jobs             → 长轮询取活(hold ≤20s 返 {job:null});扩展单客户端
 *   POST /results/:jobId   → 善果/失败回传(≤8MB;batchSearch ~550KB)
 * 语义:桥不存在即整个扩展车道不存在——fail-closed 不变量在调用方(session-search 的 needs-extension)。
 * 审计:job 提交/回传写 GuardAuditEntry 同款 JSONL(kind:'extension-session-job',channel 层负责)。
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/** 桥端口池(extension/manifest.json host_permissions 必须同面;§38 断言) */
export const BRIDGE_PORTS = [8791, 8792, 8793, 8794, 8795] as const
export const BRIDGE_PROTOCOL = 'session-bridge.v1'
/** 扩展固定 ID(unpacked 通道:manifest key 派生;bundled/GitHub Releases 均此 ID。变更即失配,Node 侧拒绝) */
export const EXTENSION_ID = 'olpgkofjhhiiiahdkkbcninhjmegghfe'
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`
/**
 * Chrome Web Store 版扩展 ID(2026-09-02 上架):商店用自己生成的签名 key 重签,
 * **不认 manifest 里的固定 key**——商店版 ID 与 unpacked 版不同(上架材料文档的
 * 「若商店不认 key」预案坐实)。item ID 即商店详情页 URL 末段。
 */
export const EXTENSION_ID_STORE = 'oeajpiccmonococjcegddlooeeohlbgd'
export const EXTENSION_ORIGIN_STORE = `chrome-extension://${EXTENSION_ID_STORE}`
/** 商店详情页(一键安装 + 自动更新通道;推荐安装方式) */
export const EXTENSION_STORE_URL = `https://chromewebstore.google.com/detail/gotry-session-bridge/${EXTENSION_ID_STORE}`
/** 桥信任的扩展 Origin 白名单:unpacked(固定 key)+ 商店版,双通道同一扩展同源信任 */
export const EXTENSION_ORIGINS: readonly string[] = [EXTENSION_ORIGIN, EXTENSION_ORIGIN_STORE]
/** 扩展在线判定:/health 心跳 ≤30s 一次 + 轮询重连,1.5 倍容差 */
export const EXTENSION_CONNECTED_WINDOW_MS = 45_000
/** /jobs 长轮询 hold 上限(必须 < MV3 SW 30s 存活窗口) */
export const JOBS_LONG_POLL_MS = 20_000
/** 提交 job 时扩展尚未上线,等它连上桥的宽限(首次调用后桥才拉起,扩展 5s 内即回连) */
export const DEFAULT_EXTENSION_WAIT_MS = 6_000
/** /results 回包上限(batchSearch ~550KB,余量给未来酒店/多航段) */
export const MAX_RESULT_BODY_BYTES = 8 * 1024 * 1024

export type ExtensionJobKind = 'search' | 'open-login' | 'cookie-names'

export interface ExtensionJob {
  jobId: string
  kind: ExtensionJobKind
  site: string
  /** search / open-login:置顶导航地址(白名单域在扩展侧再校验一道) */
  url?: string
  /** search:等嗅探回包上限 */
  timeoutMs?: number
}

export interface ExtensionJobResult {
  ok: boolean
  kind?: ExtensionJobKind
  /** cookie-names:命中票据名(名字级——协议面不存在 cookie 值字段) */
  names?: string[]
  /** search:NETWORK_HINTS 命中的响应原文 */
  body?: string
  title?: string
  opened?: boolean
  timeout?: boolean
  error?: string
}

export type SubmitOutcome =
  | { ok: true; result: ExtensionJobResult }
  | { ok: false; reason: 'bridge-unavailable' | 'extension-not-connected' | 'timeout'; summary: string }

export interface SessionJobHandle {
  submit(job: Omit<ExtensionJob, 'jobId'>, opts?: { timeoutMs?: number; extensionWaitMs?: number }): Promise<SubmitOutcome>
  extensionConnected(): boolean
  port: number
  close(): Promise<void>
}

export interface SessionBridgeOptions {
  /** 测试用 [0] 让 OS 分配;缺省 8791..8795 端口池 */
  ports?: number[]
  /** 测试覆盖信任的扩展 Origin 白名单;缺省 EXTENSION_ORIGINS(unpacked + 商店版双通道) */
  extensionOrigins?: readonly string[]
  now?: () => number
  /**
   * **保持桥进程钉住事件循环**(不 unref)。wizard 期间需要:扩展 SW 周期心跳
   * ≤30s,unref 后 wizard main 一退桥就退,扩展再发心跳连不上 → 误判扩展未就绪。
   * 真实 session 检索走单 job 流程,默认 unref=true(任何跑完主流程的宿主进程能退出)。
   * run-all §40 onboarding-tests 用 keepBridge=true 验证 wizard 探活;
   * §38 session 套件走默认 unref,语义不变。
   */
  keepBridge?: boolean
}

interface QueuedJob {
  job: ExtensionJob
  resolve: (outcome: SubmitOutcome) => void
  timer: ReturnType<typeof setTimeout> | null
}

function readBody(req: IncomingMessage, cap: number): Promise<string | { err: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (c: Buffer) => {
      if (done) return
      size += c.length
      if (size > cap) {
        done = true
        req.removeAllListeners('data')
        resolve({ err: `body 超 ${cap} 字节上限(防失控回包)` })
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')) } })
    req.on('error', () => { if (!done) { done = true; resolve({ err: 'body 读取失败' }) } })
  })
}

/** 创 Bridge 服务(测试可直接调;生产走 getOrCreateSessionBridge 懒单例) */
export async function createSessionBridge(opts: SessionBridgeOptions = {}): Promise<{ ok: true; bridge: SessionJobHandle } | { ok: false; summary: string }> {
  const ports = opts.ports ?? [...BRIDGE_PORTS]
  const extensionOrigins = new Set(opts.extensionOrigins ?? EXTENSION_ORIGINS)
  const now = opts.now ?? Date.now
  const queue: QueuedJob[] = []
  const inFlight = new Map<string, QueuedJob>()
  const parked: Array<{ res: ServerResponse; timer: ReturnType<typeof setTimeout> }> = []
  let lastSeenAt = 0
  let closed = false
  let port = 0
  const extensionConnected = (): boolean => lastSeenAt > 0 && now() - lastSeenAt < EXTENSION_CONNECTED_WINDOW_MS

  /** 领走队首 job(移入 inFlight——回包按 jobId 路由,queued 与 inFlight 两处都可找到) */
  function takeQueued(): QueuedJob | null {
    const next = queue.shift()
    if (next) inFlight.set(next.job.jobId, next)
    return next ?? null
  }

  const server = createServer((req, res) => {
    if (closed) { res.statusCode = 503; res.end(); return }
    const urlPath = (req.url ?? '').split('?')[0]
    const origin = req.headers.origin
    const isPost = req.method === 'POST'
    const originTrusted = typeof origin === 'string' && extensionOrigins.has(origin)
    // 网页侧请求必带 Origin;桥端点只信任白名单内的 chrome-extension:// 源(诊断 GET 面放行)
    if (isPost && !originTrusted) {
      res.statusCode = 403
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: false, error: 'origin 不在桥白名单' }))
      return
    }
    // 心跳:扩展平时只走 /jobs 长轮询(健康只在启动探测时 ping 一次)——
    // 一切携带白名单扩展 Origin 的请求都刷新 lastSeen,否则 45s 后误判扩展掉线;
    // 无 Origin 的诊断 GET(/health /status)不记心跳,curl 探活不能伪造「扩展在线」
    if (originTrusted) {
      lastSeenAt = now()
    }
    const finish = (code: number, body: unknown): void => {
      res.statusCode = code
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && urlPath === '/health') {
      finish(200, { ok: true, service: 'gotry-session-bridge', protocol: BRIDGE_PROTOCOL })
      return
    }
    if (req.method === 'GET' && urlPath === '/status') {
      finish(200, {
        ok: true, port, protocol: BRIDGE_PROTOCOL,
        extensionConnected: extensionConnected(),
        lastSeenMsAgo: lastSeenAt > 0 ? now() - lastSeenAt : null,
        queued: queue.length,
        inFlight: inFlight.size,
        parked: parked.length,
      })
      return
    }
    if (isPost && urlPath === '/jobs') {
      const next = takeQueued()
      if (next) { finish(200, { job: next.job }); return }
      // 长轮询:hold ≤ JOBS_LONG_POLL_MS(必须 < MV3 SW 30s 存活窗口,每次响应都续命);
      // 新 job 提交时即时唤醒 parked 取活者(见 submit→dispatchToParked)
      const parkTimer = setTimeout(() => {
        const i = parked.findIndex((p) => p.res === res)
        if (i >= 0) parked.splice(i, 1)
        finish(200, { job: null })
      }, JOBS_LONG_POLL_MS)
      // 默认桥是惰性能力:外部扩展的 parked 轮询不得在主流程结束后钉住 CLI。
      // keepBridge wizard 反过来要靠它守住进程,因此只对默认形态 unref。
      if (!opts.keepBridge) parkTimer.unref()
      parked.push({ res, timer: parkTimer })
      res.on('close', () => {
        const i = parked.findIndex((p) => p.res === res)
        if (i >= 0) parked.splice(i, 1)
        clearTimeout(parkTimer)
      })
      return
    }
    if (isPost && urlPath.startsWith('/results/')) {
      const jobId = decodeURIComponent(urlPath.slice('/results/'.length))
      void readBody(req, MAX_RESULT_BODY_BYTES).then((body) => {
        if (typeof body !== 'string') { finish(400, { ok: false, error: body.err }); return }
        let parsed: ExtensionJobResult
        try {
          parsed = JSON.parse(body) as ExtensionJobResult
        } catch {
          finish(400, { ok: false, error: '回包不是 JSON' })
          return
        }
        finish(200, { ok: true })
        resolveJob(jobId, parsed)
      })
      return
    }
    finish(404, { ok: false, error: 'unknown endpoint' })
  })
  server.on('connection', (socket) => {
    // server.unref() 只解开监听器;已接受的扩展长轮询 socket 仍会引用事件循环。
    if (!opts.keepBridge) socket.unref()
  })

  /** 扩展回包:queued 与 inFlight 两处都可寻址(job 执行失败 = result.ok:false,桥自身不吞) */
  function resolveJob(jobId: string, parsed: ExtensionJobResult): void {
    const inFlightHit = inFlight.get(jobId)
    if (inFlightHit) {
      inFlight.delete(jobId)
      if (inFlightHit.timer) clearTimeout(inFlightHit.timer)
      inFlightHit.resolve({ ok: true, result: parsed })
      return
    }
    const idx = queue.findIndex((q) => q.job.jobId === jobId)
    if (idx < 0) return
    const [entry] = queue.splice(idx, 1)
    if (entry.timer) clearTimeout(entry.timer)
    entry.resolve({ ok: true, result: parsed })
  }

  /** 新 job 入队时即时派发给 parked 取活者(否则要白等一个 20s 长轮询周期) */
  function dispatchToParked(entry: QueuedJob): boolean {
    const p = parked.shift()
    if (!p) return false
    clearTimeout(p.timer)
    inFlight.set(entry.job.jobId, entry)
    p.res.statusCode = 200
    p.res.setHeader('content-type', 'application/json')
    p.res.end(JSON.stringify({ job: entry.job }))
    return true
  }

  const bridge: SessionJobHandle = {
    port: 0,
    extensionConnected,
    submit(job, submitOpts = {}) {
      const extensionWaitMs = submitOpts.extensionWaitMs ?? DEFAULT_EXTENSION_WAIT_MS
      const timeoutMs = submitOpts.timeoutMs ?? job.timeoutMs ?? 30_000
      const full: ExtensionJob = { jobId: randomUUID(), ...job }
      return new Promise<SubmitOutcome>((resolve) => {
        if (closed) { resolve({ ok: false, reason: 'bridge-unavailable', summary: '扩展桥已关闭' }); return }
        const entry = { job: full, resolve: null as unknown as (o: SubmitOutcome) => void, timer: null as ReturnType<typeof setTimeout> | null }
        const settle = (outcome: SubmitOutcome): void => {
          if (entry.timer) clearTimeout(entry.timer)
          const i = queue.findIndex((q) => q.job.jobId === full.jobId)
          if (i >= 0) queue.splice(i, 1)
          inFlight.delete(full.jobId)
          resolve(outcome)
        }
        entry.resolve = settle
        entry.timer = setTimeout(() => {
          settle({ ok: false, reason: 'timeout', summary: `扩展未在 ${timeoutMs}ms 内回包(标签页无嗅探命中或扩展已停用)` })
        }, timeoutMs)
        if (!dispatchToParked(entry)) queue.push(entry)
        // 扩展未上线:有界等待(桥刚拉起时扩展 ≤5s 即连上);宽限过仍无 → 立即 no-spend 失败,不空耗
        let waited = 0
        const waitTimer = setInterval(() => {
          waited += 250
          if (bridge.extensionConnected()) { clearInterval(waitTimer); return }
          if (waited >= extensionWaitMs) {
            clearInterval(waitTimer)
            settle({
              ok: false,
              reason: 'extension-not-connected',
              summary: `GoTry Session Bridge 扩展未连接(未安装或已停用)。一次性安装(装完零弹窗):推荐 Chrome 应用商店一键装(自动更新) ${EXTENSION_STORE_URL} ;或 npx gotry setup 落位后 chrome://extensions 开发者模式「加载已解压的扩展程序」指向 ~/.gotry/extension`,
            })
          }
        }, 250)
      })
    },
    close: () =>
      new Promise<void>((resolve) => {
        closed = true
        const voided: SubmitOutcome = { ok: false, reason: 'bridge-unavailable', summary: '扩展桥关闭,任务作废(零花费)' }
        for (const q of queue.splice(0)) {
          if (q.timer) clearTimeout(q.timer)
          q.resolve(voided)
        }
        for (const [, q] of inFlight) {
          if (q.timer) clearTimeout(q.timer)
          q.resolve(voided)
        }
        inFlight.clear()
        for (const p of parked.splice(0)) {
          clearTimeout(p.timer)
          p.res.destroy()
        }
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }

  const listenAt = (p: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (e: Error): void => { server.off('listening', onListening); reject(e) }
      const onListening = (): void => { server.off('error', onError); resolve() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(p, '127.0.0.1')
    })

  for (const p of ports) {
    try {
      await listenAt(p)
      if (!opts.keepBridge) {
        // 桥是后台服务:不得钉住事件循环——否则任何跑完主流程的宿主进程(如 smoke/CI)无法退出
        server.unref()
      }
      // keepBridge 模式下:wizard 期间要持续监听扩展心跳(30s 周期),
      // 不 unref 让 server 钉事件循环,wizard main 退时再显式 close 释放。
      port = (server.address() as { port: number }).port
      bridge.port = port
      return { ok: true, bridge }
    } catch {
      // 端口被占(如另一个 gotry 实例)——试端口池下一个
    }
  }
  return {
    ok: false,
    summary: `扩展桥端口池 ${ports.join('/')} 全部被占(多为并行 gotry 实例);不影响官方通道 gotry_flyai_search。关闭多余实例后重试。`,
  }
}

/* ---------- 生产懒单例(进程内随 dsh 存活;失败可重试) ---------- */

let singleton: { ok: true; bridge: SessionJobHandle } | { ok: false; summary: string } | null = null

export async function getOrCreateSessionBridge(opts: SessionBridgeOptions = {}): Promise<{ ok: true; bridge: SessionJobHandle } | { ok: false; summary: string }> {
  if (singleton) return singleton
  const created = await createSessionBridge(opts)
  const result = created.ok
    ? ({ ok: true, bridge: created.bridge } as { ok: true; bridge: SessionJobHandle })
    : ({ ok: false, summary: created.summary } as { ok: false; summary: string })
  singleton = result
  return result
}

/** 测试隔离:丢弃单例(端口是进程内资源,close 后端口池立即可复用) */
export async function __resetSessionBridgeForTest(): Promise<void> {
  if (singleton?.ok) await singleton.bridge.close().catch(() => { /* ignore */ })
  singleton = null
}

/** 测试注入:以临时端口的桥替换单例(channel 层测试不碰真实端口池) */
export function __setSessionBridgeForTest(bridge: SessionJobHandle | null): void {
  singleton = bridge ? { ok: true, bridge } : null
}
