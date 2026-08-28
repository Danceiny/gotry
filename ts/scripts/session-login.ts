/**
 * 登录态 bootstrap(RFC §3.4;founder 2026-08-28 纠偏「不能是匿名实例」):
 * 打开持久 profile(~/.gotry/session-profile)的可见窗口,用户**人工**登录携程——
 * agent 永不碰密码/OTP/验证码(红线);轮询到登录票据 cookie 即收工。
 * 运行:npx tsx scripts/session-login.ts   (Ctrl-C 可随时放弃)
 */

import { openSession } from '../capabilities/session/transport.ts'
import { LOGIN_COOKIE_NAMES, SITE_DOMAIN } from '../capabilities/session/adapters/ctrip-flight.ts'

const t = await openSession({ headless: false })
if (!t.ok) {
  console.error('打开会话失败:', t.summary)
  process.exit(1)
}
try {
  await t.page.goto('https://flights.ctrip.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
  const loggedIn = async (): Promise<boolean> => {
    const cookies = await t.context.cookies([`https://flights${SITE_DOMAIN.replace(/^\./, '')}/`]).catch(() => [])
    return cookies.some((c) => LOGIN_COOKIE_NAMES.includes(c.name))
  }
  if (await loggedIn()) {
    console.log('已是登录态(~/.gotry/session-profile 持久保存),无需操作。')
  } else {
    console.log('请在打开的窗口中登录携程(手机号+验证码/账密均可)。agent 不会读取或输入任何凭证;登录完成自动检测,最长等 5 分钟...')
    let windowClosed = false
    t.page.on('close', () => { windowClosed = true })
    const deadline = Date.now() + 300_000
    while (Date.now() < deadline && !windowClosed && !(await loggedIn())) {
      await new Promise((r) => setTimeout(r, 3_000))
    }
    if (windowClosed) {
      console.log('窗口被提前关闭——登录态未建立。重跑本脚本,等打印「登录态已建立」后再关窗。')
      process.exitCode = 1
    } else if (await loggedIn()) {
      console.log('登录态已建立并持久化(profile 落在 ~/.gotry/session-profile;后续会话检索直接复用)。')
    } else {
      console.log('超时未检测到登录票据(cookie 名单待校准,或未完成登录)——重跑本脚本即可。')
      process.exitCode = 1
    }
  }
} finally {
  await t.close()
}
