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
  /** 专用 profile 目录(默认 ~/.gotry/session-profile——持久保存用户登录态;/tmp 会被系统清理;测试用 mktemp 隔离匿名态) */
  profileDir?: string
  /** 默认 headless(CI/巡检不弹窗);交互首登场景才 headful */
  headless?: boolean
  /** ReadGuard 审计落盘路径(缺省仅内存计数) */
  auditPath?: string
}

export async function openSession(opts: TransportOptions = {}): Promise<SessionTransport | TransportFailure> {
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
