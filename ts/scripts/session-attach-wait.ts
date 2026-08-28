/**
 * CDP attach 等待器(RFC §2.2 路线 A;Chrome 144+ 按 app 授权模型):
 * 长超时保持连接尝试(默认 60s/轮 × 3 轮),给浏览器侧授权弹窗足够时间被点击。
 * 用法:npx tsx scripts/session-attach-wait.ts —— 弹出授权框时请在 Chrome 里点「允许」。
 * 只读:attach 成功后仅列 cookie 名单(票据校准),不导航不交互。
 */
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const udd = process.env.CHROME_USER_DATA_DIR ?? `${homedir()}/Library/Application Support/Google/Chrome`
const [port, wsPath] = readFileSync(`${udd}/DevToolsActivePort`, 'utf8').trim().split('\n')
const wsUrl = `ws://127.0.0.1:${port!.trim()}${wsPath!.trim()}`

for (let round = 1; round <= 3; round++) {
  console.log(`第 ${round}/3 轮连接(60s 长等待——若 Chrome 弹出调试授权框,请点「允许」)...`)
  try {
    const browser = await chromium.connectOverCDP(wsUrl, { timeout: 60_000 })
    console.log('ATTACH 成功!')
    const context = browser.contexts()[0]!
    const all = await context.cookies()
    const byDom: Record<string, string[]> = {}
    for (const c of all) {
      const d = c.domain.replace(/^\./, '')
      if (/ctrip\.com$|meituan\.com$/.test(d)) (byDom[d] ??= []).push(c.name)
    }
    console.log(`共 ${all.length} 条 cookie;相关域:`)
    for (const [d, names] of Object.entries(byDom)) console.log(' ', d, '=>', names.sort().join(','))
    const ctrip = new Set(Object.entries(byDom).filter(([d]) => d.includes('ctrip')).flatMap(([, n]) => n))
    const hit = ['cticket', 'uid', 'uname', 'passport'].filter((k) => ctrip.has(k))
    console.log(hit.length ? `携程登录态:在(${hit.join(',')})` : '携程登录态:未检出(用上面名单校准 LOGIN_COOKIE_NAMES)')
    await browser.close().catch(() => { /* ignore */ })
    process.exit(0)
  } catch (e) {
    console.log(`  失败:${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  }
}
console.log('三轮均未连上——回 chrome://inspect/#remote-debugging 确认开关仍开,再重跑本脚本。')
process.exit(1)
