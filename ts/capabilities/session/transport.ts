/**
 * SessionTransport(会话检索传输层,RFC §3.2):
 * playwright-core launchPersistentContext + channel:'chrome'(用本机已装 Chrome,不下载浏览器)
 * + 专用 profile(默认 /tmp,绝不碰用户日常浏览器 profile)。
 *
 * fail-closed(RFC §3.3-④):guard 装不上 = 整个会话打不开——不存在「无守卫的会话」这一形态。
 * 永不抛错:任何启动失败降级为 TransportFailure,由 session-search 编排层消费。
 */

import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { attachReadGuard, type ReadGuardHandle } from './read-guard.ts'

export interface TransportFailure {
  ok: false
  summary: string
}

export interface SessionTransport {
  ok: true
  context: BrowserContext
  page: Page
  guard: ReadGuardHandle
  close(): Promise<void>
}

export interface TransportOptions {
  /** 传输模式:cdp=attach 用户日常 Chrome(默认,登录态=用户本人,founder 2026-08-28 定案);persistent=专用 profile(测试/后备) */
  mode?: 'cdp' | 'persistent'
  /** cdp 模式调试端口(Chrome 144+ chrome://inspect/#remote-debugging 手动开启;默认 9222) */
  cdpPort?: number
  /** 专用 profile 目录(persistent 模式;测试用 mktemp 隔离匿名态) */
  profileDir?: string
  /** 默认 headless(CI/巡检不弹窗);交互首登场景才 headful */
  headless?: boolean
  /** ReadGuard 审计落盘路径(缺省仅内存计数) */
  auditPath?: string
}

export async function openSession(opts: TransportOptions = {}): Promise<SessionTransport | TransportFailure> {
  if (opts.mode === 'cdp' || (opts.mode !== 'persistent' && !opts.profileDir)) {
    // CDP attach 日常 Chrome:登录态/指纹都是用户本人(RFC §2.2 路线 A 转 primary,founder 定案)。
    // Chrome 144+ 新式调试服务把 HTTP 发现端点硬化为 404,发现走 user data directory 的
    // DevToolsActivePort 文件(端口+browser ws 路径;文件系统可达=本地用户授权,chrome-devtools-mcp autoConnect 同机制)
    try {
      const { homedir: _hd } = await import('node:os')
      const udd = process.env.CHROME_USER_DATA_DIR ?? `${_hd()}/Library/Application Support/Google/Chrome`
      let endpoint = `http://127.0.0.1:${opts.cdpPort ?? 9222}`
      try {
        const { readFileSync: _rf } = await import('node:fs')
        const portFile = `${udd}/DevToolsActivePort`
        const [port, wsPath] = _rf(portFile, 'utf8').trim().split('\n')
        if (port && wsPath?.startsWith('/devtools/browser/')) endpoint = `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`
      } catch { /* 无文件则回退旧式 HTTP 发现 */ }
      const browser = await chromium.connectOverCDP(endpoint, { timeout: 4_000 })
      const context = browser.contexts()[0]
      if (!context) {
        await browser.close().catch(() => { /* ignore */ })
        return { ok: false, summary: 'cdp attached but no default context' }
      }
      let guard: ReadGuardHandle
      try {
        guard = await attachReadGuard(context as unknown as Parameters<typeof attachReadGuard>[0], opts.auditPath)
      } catch (e) {
        await browser.close().catch(() => { /* ignore */ })
        return { ok: false, summary: `read-guard attach failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}` }
      }
      const page = context.pages()[0] ?? (await context.newPage())
      return {
        ok: true, context, page, guard,
        close: async () => { await browser.close().catch(() => { /* ignore */ }) }, // 只断开连接,不关用户浏览器
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 160) : String(e)
      return { ok: false, summary: `cdp attach 失败(日常 Chrome 未开调试端口):${msg}。开启方法:日常 Chrome 打开 chrome://inspect/#remote-debugging → 打开开关并确认弹窗(Chrome 144+)` }
    }
  }
  const { homedir } = await import('node:os')
  const profileDir = opts.profileDir ?? `${homedir()}/.gotry/session-profile`
  let context: BrowserContext
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: opts.headless ?? true,
      viewport: { width: 1366, height: 850 },
    })
  } catch (e) {
    return { ok: false, summary: `chrome launch failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}` }
  }
  // fail-closed:guard 装不上即关会话返回失败——不给无守卫的导航面
  let guard: ReadGuardHandle
  try {
    guard = await attachReadGuard(context as unknown as Parameters<typeof attachReadGuard>[0], opts.auditPath)
  } catch (e) {
    await context.close().catch(() => { /* ignore */ })
    return { ok: false, summary: `read-guard attach failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}` }
  }
  const page = context.pages()[0] ?? (await context.newPage())
  return {
    ok: true,
    context,
    page,
    guard,
    close: async () => {
      await context.close().catch(() => { /* ignore */ })
    },
  }
}
