/**
 * CDP attach 诊断(RFC §2.2 路线 A=primary,founder「不能匿名实例」定案):
 * 前置=日常 Chrome 开 chrome://inspect/#remote-debugging 开关(Chrome 144+)。
 * 输出:attach 状态 + ctrip/meituan cookie 名单(登录票据校准)+ 登录态判定。只读,不导航。
 * 注:Chrome 147 调试服务与 playwright 不兼容(握手后悬挂,实测),传输层一律 puppeteer-core(实测 2256 cookies)。
 */
import { openSession } from '../capabilities/session/transport.ts'
import { LOGIN_COOKIE_NAMES } from '../capabilities/session/adapters/ctrip-flight.ts'

const t = await openSession({ mode: 'cdp' })
if (!t.ok) {
  console.log('ATTACH 失败:', t.summary)
  process.exit(1)
}
try {
  const all = await t.browser.cookies()
  const byDom: Record<string, string[]> = {}
  for (const c of all) {
    const d = c.domain.replace(/^\./, '')
    if (/ctrip\.com$|meituan\.com$/.test(d)) (byDom[d] ??= []).push(c.name)
  }
  console.log('ATTACH ok,共', all.length, '条 cookie;相关域:')
  for (const [d, names] of Object.entries(byDom)) console.log(' ', d, '=>', names.sort().join(','))
  const ctripNames = new Set(Object.entries(byDom).filter(([d]) => d.includes('ctrip')).flatMap(([, n]) => n))
  const known = LOGIN_COOKIE_NAMES.filter((k) => ctripNames.has(k))
  console.log(known.length > 0 ? `携程登录态:在(${known.join(',')})` : '携程登录态:未检出——在你日常 Chrome 里正常登录携程即可(无需专门窗口)')
} finally {
  await t.close()
}
