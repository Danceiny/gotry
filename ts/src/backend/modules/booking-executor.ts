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
 */

import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { BackendModule } from '../kernel.ts'
import { openSession } from '../../../capabilities/session/transport.ts'

export interface BookingObserveRequest {
  supplier: string
  entryUrl?: string
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
  /** 观察器注入点(测试/未来扩展);缺省 = CDP 只读观察 */
  observe?: (req: BookingObserveRequest) => Promise<BookingObserveResult>
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
  const authorized = (req: IncomingMessage, res: ServerResponse): boolean => {
    const key = options.apiKey()
    const auth = String(req.headers.authorization ?? '')
    if (!key) { sendJson(res, 503, { ok: false, error: 'GOTRY_BACKEND_BOOKING_API_KEY 未配置(fail-closed)' }); return false }
    if (auth !== `Bearer ${key}`) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return false }
    return true
  }

  const observe = options.observe ?? (async (req: BookingObserveRequest) => defaultObserve(req, '/tmp/booking-evidence'))

  async function handleObserve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let parsed: BookingObserveRequest
    try {
      parsed = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 400, { ok: false, error: 'body 不是 JSON' }); return
    }
    const supplier = (parsed.supplier ?? '').trim()
    if (supplier !== 'dida-portal') {
      sendJson(res, 400, { ok: false, error: `未知供应商通道 ${supplier || '(空)'}` }); return
    }
    const entryUrl = (parsed.entryUrl ?? '').trim() || 'https://portal.dida.com/hotel/find'
    if (!/^https:\/\/portal\.dida\.com\//.test(entryUrl)) {
      sendJson(res, 400, { ok: false, error: 'entry URL 必须落在 https://portal.dida.com/ 域内' }); return
    }
    try {
      const result = await observe({ supplier, entryUrl })
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
          void handleObserve(req, res)
        },
      },
    ],
  }
}
