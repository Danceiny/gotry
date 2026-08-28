/**
 * CDP attach 诊断(RFC §2.2 路线 A 转 primary,founder 2026-08-28 定案「不能匿名实例」):
 * 前置=日常 Chrome 打开 chrome://inspect/#remote-debugging 开关并确认。
 * 输出:attach 状态 + ctrip/meituan cookie 名单(登录票据校准)+ 登录态判定。只读,不导航。
 */
import { openSession } from '../capabilities/session/transport.ts'

const t = await openSession({ mode: 'cdp' })
if (!t.ok) {
  console.log('ATTACH 失败:', t.summary)
  process.exit(1)
}
try {
  const all = await t.context.cookies()
  const byDom: Record<string, string[]> = {}
  for (const c of all) {
    const d = c.domain.replace(/^\./, '')
    if (/ctrip\.com$|meituan\.com$/.test(d)) (byDom[d] ??= []).push(c.name)
  }
  console.log('ATTACH ok,共', all.length, '条 cookie')
  for (const [d, names] of Object.entries(byDom)) console.log(d, '=>', names.sort().join(','))
  const ctripNames = new Set(Object.entries(byDom).filter(([d]) => d.includes('ctrip')).flatMap(([, n]) => n))
  const known = ['cticket', 'uid', 'uname', 'passport'].filter((k) => ctripNames.has(k))
  console.log(known.length > 0 ? `携程登录态:在(${known.join(',')})` : '携程登录态:未检出(名单待以上输出校准)')
} finally {
  await t.close()
}
