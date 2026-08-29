/**
 * 会话登录 bootstrap(scripts/session-login.ts;founder 指令 2026-08-29——登录态不是「等」出来的,
 * 是把登录页开到用户面前):
 *
 *   1. attach 用户日常 Chrome(cdp;与检索同一传输层,登录态=用户本人);
 *   2. 在用户 Chrome 里打开站点登录入口标签页,登录由人完成(永不碰密码/OTP/验证码);
 *   3. 只读轮询登录票据 cookie 名(不读取任何值),到齐即止;
 *   4. attach 只 disconnect,从不关用户浏览器。
 *
 * 用法:npx tsx scripts/session-login.ts [--site ctrip-flight] [--timeout 180]
 * 前置:日常 Chrome 已开调试端口(chrome://inspect/#remote-debugging 开关,Chrome 144+)。
 */

import { openSession } from '../capabilities/session/transport.ts'

export interface LoginTarget {
  domain: string
  names: string[]
  label: string
  entryUrl: string
}

/** 站点白名单=适配器注册表;新站点适配器实用化时在此登记 */
export const LOGIN_TARGETS: Record<string, LoginTarget> = {
  'ctrip-flight': { domain: 'ctrip.com', names: ['cticket', 'uid', 'uname', 'passport'], label: '携程机票', entryUrl: 'https://flights.ctrip.com/' },
  'meituan-hotel': { domain: 'meituan.com', names: ['lt', 'u', 'token', 'n'], label: '美团酒店', entryUrl: 'https://hotel.meituan.com/' },
}

interface CookieLike {
  domain?: string
  name?: string
}

type CookieBrowser = { cookies(): Promise<CookieLike[]> }

/** 只读轮询:返回目标域上已存在的登录票据 cookie 名单(只要名字,绝不读值) */
export async function pollTicketNames(browser: { cookies(): Promise<CookieLike[]> }, domain: string, names: string[]): Promise<string[]> {
  const cookies = await browser.cookies().catch(() => [] as CookieLike[])
  if (!Array.isArray(cookies)) return []
  return cookies.filter((c) => (c.domain ?? '').includes(domain) && names.includes(c.name ?? '')).map((c) => c.name as string)
}

function ticketNamesOf(site: string): string[] {
  return LOGIN_TARGETS[site]?.names ?? []
}

async function main(): Promise<void> {
  const site = process.argv.find((a) => a === 'ctrip-flight' || a === 'meituan-hotel') ?? 'ctrip-flight'
  const target = LOGIN_TARGETS[site]
  if (!target) { console.error(`未知站点 ${site}(可选 ${Object.keys(LOGIN_TARGETS).join('/')})`); process.exit(1) }
  const timeoutArg = process.argv.find((a) => a.startsWith('--timeout'))
  const timeoutSec = Number(timeoutArg?.split('=')[1] ?? 180)

  const t = await openSession({ mode: 'cdp' })
  if (!t.ok) {
    console.error(`[login] ATTACH 失败:${t.summary}`)
    console.error('[login] 开启方法:日常 Chrome 打开 chrome://inspect/#remote-debugging → 打开开关(Chrome 144+),重跑本脚本')
    process.exit(1)
  }
  const cookieCount = (await t.browser.cookies().catch(() => [] as CookieLike[])).length
  console.log(`[login] attach ok(cookie ${cookieCount} 条);目标域 ${target.domain}`)
  try {
    await t.page.goto(target.entryUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  } catch {
    console.warn('[login] 导航超时(站点慢)——登录入口标签已可用,直接在该标签页登录即可')
  }
  console.log(`[login] 已在你的 Chrome 打开 ${target.label} 登录入口:${target.entryUrl}`)
  console.log(`[login] 请直接在该标签页正常登录;本脚本只轮询票据名(${ticketNamesOf(site).join('/')}),不读任何值`)

  const deadline = Date.now() + timeoutSec * 1000
  let names: string[] = []
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 3000))
    names = await pollTicketNames(t.browser as unknown as { cookies(): Promise<CookieLike[]> }, target.domain, target.names)
    if (names.length > 0) break
    process.stdout.write('.')
  }
  await t.close()
  if (names.length === 0) {
    console.error(`\n[login] ${timeoutSec}s 内未检出登录票据(期望名:${ticketNamesOf(site).join('/')})。在该标签页登录成功后重跑本脚本即可`)
    process.exit(2)
  }
  console.log(`\n[login] OK——登录票据已检出 [${names.join(', ')}](只记名字不读值);gotry_session_search 从此以该登录态为存在前提,可直接使用`)
}

main().catch((e) => { console.error(e); process.exit(1) })