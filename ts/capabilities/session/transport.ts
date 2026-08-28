/**
 * SessionTransport(会话检索传输层,RFC §3.2;2026-08-28 定案 puppeteer-core):
 * - mode=cdp(默认):attach 用户日常 Chrome——Chrome 144+ 调试服务(chrome://inspect 开关)
 *   与 playwright 不兼容(握手后 CDP 初始化悬挂,实测三轮),与 puppeteer 完全兼容(实测 2256 cookies)。
 *   发现走 user-data-dir 的 DevToolsActivePort 文件(HTTP 发现面已硬化 404;Origin 头=403,安全设计)。
 *   close() 只 disconnect,绝不关用户浏览器。
 * - mode=persistent(测试/后备):puppeteer.launch 专用 profile(测试用 mktemp 隔离匿名态)。
 * fail-closed(RFC §3.3-④):guard 装不上 = 整个会话打不开——不存在「无守卫的会话」这一形态。
 * 永不抛错:任何启动失败降级为 TransportFailure,由 session-search 编排层消费。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { attachReadGuardPuppeteer, type ReadGuardHandle } from './read-guard.ts'
import type { Browser, Page } from 'puppeteer-core'

/**
 * puppeteer-core 为可选依赖(D-14:产品运行时零硬依赖,缺则优雅降级)。
 * 顶层动态 import——npm 形态若未装 puppeteer-core,openSession 返回 TransportFailure
 * 而非在模块加载期炸掉整个插件(2026-08-28 发布面实测:静态 import 会拖垮 index.ts 加载链)。
 */
async function loadPuppeteer(): Promise<typeof import('puppeteer-core') | { missing: true }> {
  try {
    return await import('puppeteer-core')
  } catch {
    return { missing: true }
  }
}

export interface TransportFailure {
  ok: false
  summary: string
}

export interface SessionTransport {
  ok: true
  browser: Browser
  page: Page
  guard: ReadGuardHandle
  close(): Promise<void>
}

export interface TransportOptions {
  /** 传输模式:cdp=attach 用户日常 Chrome(默认,登录态=用户本人,founder 2026-08-28 定案);persistent=专用 profile(测试/后备) */
  mode?: 'cdp' | 'persistent'
  /** persistent 模式专用 profile 目录(测试用 mktemp 隔离匿名态;缺省 tmpdir) */
  profileDir?: string
  /** persistent 模式 headless(默认 true);cdp 模式恒为用户可见窗口 */
  headless?: boolean
  /** ReadGuard 审计落盘路径(缺省仅内存计数) */
  auditPath?: string
}

function devtoolsWsEndpoint(): { ws: string } | { err: string } {
  try {
    const udd = process.env.CHROME_USER_DATA_DIR ?? `${homedir()}/Library/Application Support/Google/Chrome`
    const [port, wsPath] = readFileSync(`${udd}/DevToolsActivePort`, 'utf8').trim().split('\n')
    if (!port || !wsPath?.startsWith('/devtools/browser/')) {
      return { err: `DevToolsActivePort 内容异常: ${String(port)}/${String(wsPath)}` }
    }
    return { ws: `ws://127.0.0.1:${port.trim()}${wsPath.trim()}` }
  } catch {
    return { err: '日常 Chrome 未开调试端口。开启方法:Chrome 打开 chrome://inspect/#remote-debugging → 打开开关(Chrome 144+)' }
  }
}

export async function openSession(opts: TransportOptions = {}): Promise<SessionTransport | TransportFailure> {
  const pp = await loadPuppeteer()
  if ('missing' in pp) {
    return { ok: false, summary: 'puppeteer-core 未安装(可选依赖):会话检索不可用,官方通道 gotry_flyai_search 仍可用。安装:npm i -D puppeteer-core' }
  }
  const puppeteer = pp.default
  const useCdp = opts.mode === 'cdp' || (opts.mode !== 'persistent' && !opts.profileDir)
  let browser: Browser
  let isCdp = false
  if (useCdp) {
    const d = devtoolsWsEndpoint()
    if ('err' in d) return { ok: false, summary: d.err }
    try {
      browser = await puppeteer.connect({ browserWSEndpoint: d.ws, defaultViewport: null })
      isCdp = true
    } catch (e) {
      const msg = e instanceof Error ? e.message : (e as { message?: string })?.message ?? JSON.stringify(e).slice(0, 200)
      return { ok: false, summary: `cdp attach 失败:${String(msg).split('\n')[0]}` }
    }
  } else {
    const { tmpdir } = await import('node:os')
    const profileDir = opts.profileDir ?? `${tmpdir()}/gotry-session-profile`
    try {
      browser = await puppeteer.launch({ channel: 'chrome', headless: opts.headless ?? true, userDataDir: profileDir })
    } catch (e) {
      return { ok: false, summary: `chrome launch failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` }
    }
  }
  // fail-closed:guard 装不上即断开返回失败——不给无守卫的导航面
  let guard: ReadGuardHandle
  try {
    guard = await attachReadGuardPuppeteer(browser as unknown as Parameters<typeof attachReadGuardPuppeteer>[0], opts.auditPath)
  } catch (e) {
    await (isCdp ? browser.disconnect() : browser.close()).catch(() => { /* ignore */ })
    return { ok: false, summary: `read-guard attach failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` }
  }
  const page = (await browser.pages())[0] ?? (await browser.newPage())
  return {
    ok: true,
    browser,
    page,
    guard,
    close: async () => {
      // cdp:只断开连接,绝不关用户浏览器;persistent:关自己拉起的实例
      await (isCdp ? browser.disconnect() : browser.close()).catch(() => { /* ignore */ })
    },
  }
}