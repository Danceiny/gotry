/**
 * booking-executor 模块(gotry-backend 能力单元;M1 预订链执行面骨架)。
 *
 * 红线(设计文档 §7 / WriteGate):
 *   - 本模块只提供「只读观察 + 截图存证」;填单/提交原语**不存在**——写动作由
 *     后续确认门放行后的受控执行器实现,当前骨架刻意不建。
 *   - 观察对象 = dida 页面自己的预订入口(按钮文本与数量),不读取任何凭据/Cookie 值。
 *
 * 路由(鉴权:Bearer GOTRY_BACKEND_BOOKING_API_KEY;缺 key = fail-closed 503):
 *   POST /v1/booking/observe → 打开供应商页面,观察预订入口并截图存证
 *
 * 观察器可注入(测试/未来多供应商扩展);缺省实现 = CDP 只读观察
 * (openSession,ReadGuard 照常生效)。
 *
 * AaaS(docs/rfc/aaas-rfc.md §4.8,威胁 S-19)——缺省观察器读的是宿主机上**同一个** Chrome 和它里面**同一份**供应商登录,
 * 所以它天生是单组织的:只有持有该登录的组织(hostBrowserOrganization,缺省 local)的调用方能用它。
 *   - callerOrganization(req):宿主在 bearer 之后解出调用方组织(null/非法/抛错 → 403 organization-unresolved);
 *     组织从不取自请求体或请求头;缺省 = 单组织形态,所有调用方都是 local;
 *   - 缺省(宿主 Chrome)观察器遇到别的组织 → 403,不碰浏览器;声明了 callerOrganization 却没说宿主浏览器属于谁 →
 *     构造即失败(多组织部署必须点名);
 *   - 注入的 observe 是组织感知的:收到解出的组织,自己负责把浏览器绑到该组织(云端多租户浏览器需要新 ADR,
 *     见 RFC §4.8 的入场条件——供应商登录只在员工浏览器里,云端无法替租户持有)。
 */

import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { BackendModule } from '../kernel.ts'
import { openSession } from '../../../capabilities/session/transport.ts'
import { BRIDGE_DEFAULT_ORGANIZATION, isBridgeOrganization } from '../../../capabilities/session/extension-bridge.ts'

export interface BookingObserveRequest {
  supplier: string
  entryUrl?: string
  /** The caller's organization, resolved by the host and never read from the request. `local` in the single-organization form. */
  organization?: string
}

export interface BookingEntryPoint {
  text: string
  tag: string
}

export interface BookingObserveResult {
  ok: boolean
  supplier: string
  entryUrl: string
  entryPoints: BookingEntryPoint[]
  screenshotPath: string
  observedAt: string
}

export interface BookingExecutorModuleOptions {
  apiKey: () => string
  evidenceDir: () => string
  /**
   * 观察器注入点(测试/未来扩展);组织感知:收到解出的组织,自己负责把浏览器绑到该组织。
   * 缺省 = 宿主 Chrome 的 CDP 只读观察,受 hostBrowserOrganization 约束(单组织)。
   */
  observe?: (req: BookingObserveRequest) => Promise<BookingObserveResult>
  /** 缺省(宿主 Chrome)观察器的实现注入点;测试用。受 hostBrowserOrganization 约束。 */
  hostBrowserObserve?: (req: BookingObserveRequest) => Promise<BookingObserveResult>
  /**
   * AaaS(S-19):宿主 Chrome 里那份供应商登录属于哪个组织。缺省 `local`。声明了 callerOrganization 时必须显式给出
   * (除非注入了自己的组织感知 observe)。
   */
  hostBrowserOrganization?: string
  /** AaaS(S-19):解出本次请求的组织(宿主在 bearer 之后解)。缺省 = 单组织形态,所有调用方都是 local。 */
  callerOrganization?: (req: IncomingMessage) => string | null
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, cap = 32 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > cap) { reject(new Error(`body 超 ${cap} 字节上限`)); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 缺省观察器:CDP 打开页面 → 读预订入口按钮 → 截图存证(只读;零提交原语) */
export async function defaultObserve(req: BookingObserveRequest, evidenceDir: string): Promise<BookingObserveResult> {
  const t = await openSession({ mode: 'cdp', guard: true, newPage: true, closeOwnPage: true })
  if (!t.ok) throw new Error(`会话主机 Chrome 不可达: ${t.summary}`)
  try {
    await t.page.goto(req.entryUrl ?? 'https://portal.dida.com/hotel/find', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    const entryPoints = (await t.page.evaluate((): Array<{ text: string; tag: string }> => {
      return Array.from(document.querySelectorAll('button'))
        .filter((b) => b.textContent != null && b.textContent.includes('预订'))
        .slice(0, 10)
        .map((b) => ({ text: (b.textContent ?? '').trim().slice(0, 40), tag: 'button' }))
    })) as Array<{ text: string; tag: string }>
    mkdirSync(evidenceDir, { recursive: true })
    const screenshotPath = `${evidenceDir}/observe-${Date.now()}.png`
    await t.page.screenshot({ path: screenshotPath })
    return {
      ok: true,
      supplier: req.supplier,
      entryUrl: req.entryUrl ?? 'https://portal.dida.com/hotel/find',
      entryPoints,
      screenshotPath,
      observedAt: new Date().toISOString(),
    }
  } finally {
    await t.close()
  }
}

export function startBookingExecutorModule(options: BookingExecutorModuleOptions): BackendModule {
  if (options.hostBrowserOrganization !== undefined && !isBridgeOrganization(options.hostBrowserOrganization)) {
    throw new Error('booking_executor_host_browser_organization_invalid')
  }
  // A deployment that tells us it serves several organizations must also say whose login the host browser holds: with the
  // default observer and no answer, every organization would ride one organization's supplier login.
  if (options.callerOrganization && !options.observe && options.hostBrowserOrganization === undefined) {
    throw new Error('booking_executor_host_browser_organization_required')
  }
  const hostBrowserOrganization = options.hostBrowserOrganization ?? BRIDGE_DEFAULT_ORGANIZATION
  const authorized = (req: IncomingMessage, res: ServerResponse): boolean => {
    const key = options.apiKey()
    const auth = String(req.headers.authorization ?? '')
    if (!key) { sendJson(res, 503, { ok: false, error: 'GOTRY_BACKEND_BOOKING_API_KEY 未配置(fail-closed)' }); return false }
    if (auth !== `Bearer ${key}`) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return false }
    return true
  }

  const hostBrowserObserve = options.hostBrowserObserve ?? (async (req: BookingObserveRequest) => defaultObserve(req, '/tmp/booking-evidence'))

  /** 解出本次请求的组织:无注入点 = local;解不出/非法 → 403 并返回 null(请求不碰任何观察器) */
  const resolveOrganization = (req: IncomingMessage, res: ServerResponse): string | null => {
    if (!options.callerOrganization) return BRIDGE_DEFAULT_ORGANIZATION
    let resolved: string | null
    try {
      resolved = options.callerOrganization(req)
    } catch {
      resolved = null
    }
    if (resolved === null || !isBridgeOrganization(resolved)) {
      sendJson(res, 403, { ok: false, error: 'organization-unresolved' })
      return null
    }
    return resolved
  }

  async function handleObserve(req: IncomingMessage, res: ServerResponse, organization: string): Promise<void> {
    let decoded: unknown
    try {
      decoded = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 400, { ok: false, error: 'body 不是 JSON' }); return
    }
    // `null`, a number, a string or an array is JSON too; reading a field from one would throw outside any handler.
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      sendJson(res, 400, { ok: false, error: 'body 不是 JSON 对象' }); return
    }
    const parsed = decoded as BookingObserveRequest
    const supplier = (parsed.supplier ?? '').trim()
    if (supplier !== 'dida-portal') {
      sendJson(res, 400, { ok: false, error: `未知供应商通道 ${supplier || '(空)'}` }); return
    }
    const entryUrl = (parsed.entryUrl ?? '').trim() || 'https://portal.dida.com/hotel/find'
    if (!/^https:\/\/portal\.dida\.com\//.test(entryUrl)) {
      sendJson(res, 400, { ok: false, error: 'entry URL 必须落在 https://portal.dida.com/ 域内' }); return
    }
    // The request handed to an observer is built from the validated fields and the host-resolved organization only:
    // whatever organization the body names (`parsed.organization`) is never read.
    // In the single-organization form the request has the shape it always had; the organization is added only where a host
    // resolves one.
    const observation: BookingObserveRequest = options.callerOrganization ? { supplier, entryUrl, organization } : { supplier, entryUrl }
    if (!options.observe && organization !== hostBrowserOrganization) {
      // The host browser holds one organization's supplier login; another organization's caller must not ride it.
      sendJson(res, 403, { ok: false, error: 'executor-organization-mismatch' }); return
    }
    try {
      const result = await (options.observe ?? hostBrowserObserve)(observation)
      sendJson(res, 200, result)
    } catch (e) {
      sendJson(res, 502, { ok: false, error: `观察失败: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}` })
    }
  }

  return {
    name: 'booking-executor',
    routes: [
      {
        method: 'POST',
        path: '/v1/booking/observe',
        handle: (req, res) => {
          if (!authorized(req, res)) return
          const organization = resolveOrganization(req, res)
          if (organization === null) return
          void handleObserve(req, res, organization)
        },
      },
    ],
  }
}
