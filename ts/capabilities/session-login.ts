/**
 * 账号会话登录引导(产品化工具面:gotry_session_login 的能力层,founder 2026-08-29「请产品化」)。
 *
 * **语义边界(防误解,founder 红线「我们是不会要求用户上传密钥给 gotry 的」)**:
 *   - 登录发生在外部网站(携程官网),用用户自己的浏览器会话完成;
 *   - gotry 不提供、不代填、不接触任何密码/短信验证码/cookie 值;
 *   - 本模块唯一事实:**只读 cookie 的名字**,判断「是否已登录」这个布尔——
 *     名称级存在性检查 = 数据最小化的极端形态(0 个值过手);
 *   - 登录入口页不挂 ReadGuard(见 transport.ts guard:false 注释):那是用户自己的
 *     凭证流,我们的拦截绝不能站在用户与网站中间(检索面守卫不变量不受影响)。
 *
 * flow:attach 用户日常 Chrome → 打开登录入口标签 → 用户在携程官网自行登录 →
 * 本模块只读轮询票据 cookie **名字**(cticket/uid/uname/passport)→ 到齐即报「已登录」。
 */

import { openSession } from './session/transport.ts'

export interface LoginTarget {
  domain: string
  /** 登录票据 cookie 名(经 founder 登录实测后校准;D-13 同源) */
  names: string[]
  label: string
  entryUrl: string
}

/** 站点白名单 = 适配器注册表;新站点适配器落地时在此登记 */
export const LOGIN_TARGETS: Record<string, LoginTarget> = {
  'ctrip-flight': { domain: 'ctrip.com', names: ['cticket', 'uid', 'uname', 'passport'], label: '携程机票', entryUrl: 'https://flights.ctrip.com/' },
  'meituan-hotel': { domain: 'meituan.com', names: ['lt', 'u', 'token', 'n'], label: '美团酒店', entryUrl: 'https://hotel.meituan.com/' },
}

interface CookieLike {
  domain?: string
  name?: string
}

export interface SessionLoginQuery {
  /** 站点(默认 ctrip-flight) */
  site?: string
  /** 等待用户完成登录的上限(ms,默认 90_000;到点返 pending,不阻塞会话) */
  waitMs?: number
  /** 轮询间隔(ms,默认 3000;票据 cookie 名只读) */
  pollMs?: number
}

export interface SessionLoginResult {
  ok: boolean
  via: 'session-login' | 'session-login-error'
  evidence: string
  latencyMs: number
  verdict: 'logged-in' | 'pending' | 'needs-attach' | 'error'
  site: string
  /** 已检出的登录票据 cookie 名(名字,非值——本模块永不读取/存储/回传任何 cookie 值) */
  tickets?: string[]
  error?: string
}

function err(site: string, verdict: SessionLoginResult['verdict'], error: string, started: number, ts: string): SessionLoginResult {
  return {
    ok: false, via: 'session-login-error', evidence: `[会话:login-error@${ts}] ${error.slice(0, 200)}`,
    latencyMs: Date.now() - started, verdict, site, error: error.slice(0, 200),
  }
}

/** 只读轮询:目标域上已存在的登录票据 cookie 名单(只要名字,永不读值) */
export async function pollTicketNames(browser: { cookies(): Promise<CookieLike[]> }, target: LoginTarget): Promise<string[]> {
  const cookies = await browser.cookies().catch(() => [] as CookieLike[])
  if (!Array.isArray(cookies)) return []
  return cookies
    .filter((c) => (c.domain ?? '').includes(target.domain) && c.name != null && target.names.includes(c.name))
    .map((c) => c.name as string)
}

/**
 * 产品化登录引导(永不抛错;登录由用户在携程官网完成,gotry 只做名称级存在性检查)。
 * verdict:logged-in=已检出票据;pending=登录入口已打开、用户尚未完成(不阻塞,可稍后再查);
 * needs-attach=用户 Chrome 未开调试端口(一次性开关指引);error=其余降级。
 */
export async function sessionLogin(q: SessionLoginQuery = {}): Promise<SessionLoginResult> {
  const started = Date.now()
  const ts = new Date().toISOString()
  const site = q.site ?? 'ctrip-flight'
  const target = LOGIN_TARGETS[site]
  if (!target) {
    return err(site, 'error', `未知站点 ${site}(可选 ${Object.keys(LOGIN_TARGETS).join('/')})`, started, ts)
  }
  // 人机共治纪律:开自己的新标签页并置前台——用户必须看见登录页(2026-08-29 founder:
  // 「我根本就看不到登录页面」,此前误劫持用户既有标签页);closeOwnPage=false 把登录页留给用户
  const t = await openSession({ mode: 'cdp', guard: false })
  if (!t.ok) {
    const needsAttach = /chrome:\/\/inspect|DevToolsActivePort|cdp attach 失败/.test(t.summary)
    return err(
      site,
      needsAttach ? 'needs-attach' : 'error',
      needsAttach
        ? `${t.summary};开启方法:你的 Chrome 打开 chrome://inspect/#remote-debugging → 打开开关(Chrome 144+,一次性),开启后直接再说一声即可`
        : t.summary,
      started, ts,
    )
  }
  const evidenceTag = `[会话:${site}-login@${ts}]`
  try {
    // 自动检测优先(2026-08-29 founder「UI 里有自动检测吗」):先只读票据名——
    // 已登录则**零弹窗**直接确认,不打开任何页面;登录状态由用户在携程官网自然留存
    const pre = await pollTicketNames(t.browser as unknown as { cookies(): Promise<CookieLike[]> }, target)
    if (pre.length > 0) {
      await t.close()
      return {
        ok: true, via: 'session-login', latencyMs: Date.now() - started, verdict: 'logged-in', site, tickets: pre,
        evidence: `${evidenceTag} 自动检测:票据 cookie 已在(先前登录已生效)——[${pre.join(', ')}](只读名字,0 网页交互)`,
      }
    }
    // 未检出 → 开自己的新标签页并置前台(绝不劫持用户既有页面),等待用户在官网完成登录
    const page = await t.browser.newPage()
    await (page as unknown as { bringToFront(): Promise<void> }).bringToFront().catch(() => { /* 某些环境不可置前 */ })
    try {
      await page.goto(target.entryUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } catch {
      // 站点慢不致命:入口标签已打开,用户手动登录即可
    }
    console.log(`[session-login] ${target.label} 登录入口已在新标签页置前打开`)
    const waitMs = Math.min(Math.max(q.waitMs ?? 90_000, 0), 300_000)
    const pollMs = Math.min(Math.max(q.pollMs ?? 3_000, 500), 10_000)
    const deadline = Date.now() + waitMs
    let tickets: string[] = []
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollMs))
      tickets = await pollTicketNames(t.browser as unknown as { cookies(): Promise<CookieLike[]> }, target)
      if (tickets.length > 0) break
    }
    await t.close()
    if (tickets.length > 0) {
      return {
        ok: true, via: 'session-login', latencyMs: Date.now() - started, verdict: 'logged-in', site, tickets,
        evidence: `${evidenceTag} 票据 cookie 已检出 [${tickets.join(', ')}](只读名字;登录在你自己的浏览器里完成,gotry 全程未接触任何密码/验证码/cookie 值)`,
      }
    }
    return {
      ok: true, via: 'session-login', latencyMs: Date.now() - started, verdict: 'pending', site, tickets: [],
      evidence: `${evidenceTag} 登录入口已在你的 Chrome 打开(${target.label});在标签页里正常登录完成后再说一声「继续查」即可——gotry 只检查"是否已登录",永不收集你的账号信息`,
    }
  } catch (e) {
    await t.close().catch(() => { /* ignore */ })
    return err(site, 'error', e instanceof Error ? e.message : String(e), started, ts)
  }
}