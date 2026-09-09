/**
 * Dida 会话 cookie 形态探针(只打印 name/domain,永不打印值——红线)。
 * 复用 live E2E 的启动与登录流程,登录后枚举 dida 相关 cookie 的名字与域。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const EXT_DIR = new URL('../../extension/', import.meta.url).pathname
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const user = process.env.DIDA_USERNAME ?? ''
  const pass = process.env.DIDA_PASSWORD ?? ''
  if (!user || !pass) { console.error('DIDA_USERNAME/DIDA_PASSWORD 必填'); process.exit(1) }

  const profileDir = mkdtempSync(join(tmpdir(), 'gotry-dida-probe-'))
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--remote-debugging-port=9234', `--user-data-dir=${profileDir}`, '--no-first-run',
    `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, 'about:blank',
  ], { stdio: 'ignore' })
  const cleanup = (): void => { try { chrome.kill() } catch {} try { rmSync(profileDir, { recursive: true, force: true }) } catch {} }
  process.on('exit', cleanup)

  await sleep(10_000)
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9234')
  const context = browser.contexts()[0]!
  const page = await context.newPage()
  await page.goto('https://portal.dida.com/login', { waitUntil: 'networkidle', timeout: 45_000 })
  await page.evaluate(`(() => {
    document.querySelectorAll('#onetrust-consent-sdk, .nd-cookie-consent, .cdk-overlay-backdrop, .cdk-overlay-container').forEach(el => el.remove())
  })()`).catch(() => {})
  await page.waitForSelector('input[name="username"]', { timeout: 20_000 })
  await page.evaluate(`(() => {
    const u = document.querySelector('input[name="username"]')
    const p = document.querySelector('input[name="password"]')
    const setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setVal.call(u, ${JSON.stringify(user)}); u.dispatchEvent(new Event('input', { bubbles: true }))
    setVal.call(p, ${JSON.stringify(pass)}); p.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelectorAll('.ant-checkbox-wrapper, label[class*="checkbox"]').forEach(w => w.click())
  })()`)
  await sleep(500)
  await page.evaluate(`(() => {
    Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().toLowerCase() === 'login')?.click()
  })()`)
  try { await page.waitForURL('**/hotel/**', { timeout: 60_000 }) } catch {
    console.log('⚠️ 未跳转——等待人工完成验证码 60s')
    try { await page.waitForURL('**/hotel/**', { timeout: 60_000 }) } catch {}
  }
  await sleep(4_000)
  console.log('final url:', page.url())

  // 全上下文 cookie(只 name+domain+httpOnly/partitioned 元数据;值不落任何输出)
  const cookies = await context.cookies()
  const dida = cookies.filter((c) => c.domain.includes('dida'))
  console.log(`全上下文 cookie ${cookies.length} 条;dida 相关 ${dida.length} 条:`)
  for (const c of dida) {
    console.log(`  - ${c.name}  domain=${c.domain}  httpOnly=${c.httpOnly} partitioned=${(c as { partitioned?: boolean }).partitioned ?? false} expires=${c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session'}`)
  }
  // 页面内非 HttpOnly 视角
  const jsNames = await page.evaluate(`(() => document.cookie.split(';').map(s => s.trim().split('=')[0]).filter(Boolean))()`)
  console.log('document.cookie 可见名(非 HttpOnly):', JSON.stringify(jsNames))
  // 认证态校验
  const authed = await page.evaluate(`(async () => {
    try {
      const r = await fetch('https://portal-webapi.dida.com/ApplicationContextApi/GetContext?init=true', { credentials: 'include' })
      const j = await r.json()
      return { success: j?.Success, code: j?.MessageCode, authed: j?.Data?.userIdentityInfo?.isAuthenticated }
    } catch (e) { return { err: String(e) } }
  })()`)
  console.log('GetContext:', JSON.stringify(authed))
  await browser.close()
  process.exit(0)
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
