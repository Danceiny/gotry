/**
 * Dida 供应商门户会话面 LIVE E2E(hotel-be portal integration 迁移线;GOTRY_SESSION_LIVE=1 显式开启)。
 *
 * 全链:真 Chrome(加载 unpacked Session Bridge 扩展)→ 人/驱动在 dida 官网完成登录
 * (账密经 env 注入,gotry 永不经手)→ sessionDidaSearch 扩展车道(桥自动拉起,
 * 扩展 cookie-names 名字级登录闸 → search job 后台标签被动嗅探)→ dida SPA 页面
 * 自身发起 SearchRealTime → parseDidaRates 结构化报价。
 *
 * SPA 边界:dida find 页加载自发的是价格监控;实时价(SearchRealTime)由页内
 * 「预订」按钮触发——驱动只在自己开的登录页与 job 的后台标签里做「去 overlay +
 * 点页面自己的按钮」,检索请求仍由 dida 页面代码发出(扩展零写行为不变量不破)。
 *
 * 运行:cd ts && GOTRY_SESSION_LIVE=1 DIDA_USERNAME=... DIDA_PASSWORD=... \
 *        npx tsx scripts/session-dida-live-e2e.ts
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright-core'
import { sessionDidaSearch, __resetRateLimiterForTest } from '../capabilities/session-search.ts'

const EXT_DIR = fileURLToPath(new URL('../../extension/', import.meta.url))
const CDP_PORT = 9233
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function removeOverlays(page: { evaluate: (fn: string) => Promise<unknown> }): Promise<void> {
  await page.evaluate(`(() => {
    document.querySelectorAll('#onetrust-consent-sdk, .nd-cookie-consent, .cdk-overlay-backdrop, .cdk-overlay-container').forEach(el => el.remove())
  })()`).catch(() => { /* overlay 未出现不碍事 */ })
}

async function main(): Promise<void> {
  const user = process.env.DIDA_USERNAME ?? ''
  const pass = process.env.DIDA_PASSWORD ?? ''
  if (!process.env.GOTRY_SESSION_LIVE || !user || !pass) {
    console.error('GOTRY_SESSION_LIVE=1 与 DIDA_USERNAME/DIDA_PASSWORD 必填(env 注入,不入库)')
    process.exit(1)
  }

  const profileDir = mkdtempSync(join(tmpdir(), 'gotry-dida-e2e-'))
  // Chrome 137+ 品牌版移除 --load-extension;Chromium/Chrome for Testing 保留(2026-09-09 实测)。
  const chromeBin = process.env.CHROME_BIN
    ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  const chrome = spawn(chromeBin, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    'about:blank',
  ], { stdio: 'ignore' })
  const cleanup = (): void => {
    try { chrome.kill() } catch { /* 已退出 */ }
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 下次清扫 */ }
  }
  process.on('exit', cleanup)

  await sleep(10_000) // 等 SW 拉起 + 扩展装载
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
  const context = browser.contexts()[0]!
  const workers = context.serviceWorkers()
  console.log(`扩展 service worker: ${workers.length > 0 ? '✅' : '❌(继续,job 前可能仍就绪)'}`)

  // ── 登录(账密 env 注入;验证码如出现由人在窗口里完成)──
  const page = await context.newPage()
  console.log('📍 登录 portal.dida.com')
  await page.goto('https://portal.dida.com/login', { waitUntil: 'networkidle', timeout: 45_000 })
  await removeOverlays(page)
  await page.waitForSelector('input[name="username"]', { timeout: 20_000 })
  await page.evaluate(`(() => {
    const u = document.querySelector('input[name="username"]')
    const p = document.querySelector('input[name="password"]')
    const setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setVal.call(u, ${JSON.stringify(user)}); u.dispatchEvent(new Event('input', { bubbles: true }))
    setVal.call(p, ${JSON.stringify(pass)}); p.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await page.evaluate(`(() => {
    document.querySelectorAll('.ant-checkbox-wrapper, label[class*="checkbox"]').forEach(w => w.click())
  })()`)
  await sleep(500)
  await page.evaluate(`(() => {
    Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().toLowerCase() === 'login')?.click()
  })()`)
  let loggedIn = false
  try {
    await page.waitForURL('**/hotel/**', { timeout: 60_000 })
    await sleep(3_000)
    loggedIn = true
  } catch {
    console.log('⚠️ 60s 未跳转——若窗口出现验证码,请人工完成后脚本继续等 60s')
    try { await page.waitForURL('**/hotel/**', { timeout: 60_000 }); await sleep(3_000); loggedIn = true } catch { /* 放行给登录闸报 needs-login */ }
  }
  console.log(`登录: ${loggedIn ? '✅' : '❌(交由会话登录闸裁决)'}`)
  await removeOverlays(page)

  // ── 会话检索(扩展车道;桥由 sessionDidaSearch 拉起,扩展 5s 内接入)──
  // SPA 点击协助与检索并发:job 开的后台标签加载后,替它点页面自己的「预订」,
  // 触发 dida 页面代码发出 SearchRealTime(扩展/桥零写行为不变量不变)。
  console.log('📍 sessionDidaSearch(扩展车道,后台标签被动嗅探 + 预订点击协助)')
  __resetRateLimiterForTest()
  const loginPageUrl = page.url()
  const clickAssist = (async (): Promise<void> => {
    await sleep(3_000)
    for (let i = 0; i < 20; i++) {
      const jobTabs = context.pages().filter((p) =>
        p.url().startsWith('https://portal.dida.com/') && p !== page && p.url() !== loginPageUrl)
      for (const tab of jobTabs) {
        await removeOverlays(tab)
        const clicked = await tab.evaluate(`(() => {
          const btn = document.querySelector('.hotel-index-recommends-card__book-btn')
            || Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('预订'))
          if (btn) { btn.scrollIntoView(); btn.click(); return true }
          return false
        })()`).catch(() => false)
        if (clicked === true) {
          console.log('📍 已在 job 后台标签点击「预订」——等页面自己发检索')
          return
        }
      }
      await sleep(2_000)
    }
  })()

  // CfT/Chromium 构建 cookies API 对 HttpOnly cookie 不可见(品牌版 Chrome 144 正常,
  // 2026-09-09 SW 探针实证)——E2E 以 DIDA_E2E_SKIP_LOGIN_GATE=1 跳过登录快查,
  // 登录真实性由本驱动前序 GUI 登录保证;嗅探链路不读 cookie 值,不受此缺陷影响。
  const skipGate = process.env.DIDA_E2E_SKIP_LOGIN_GATE === '1'
  let result = await sessionDidaSearch({ timeoutMs: 50_000, allowAnonymous: skipGate })
  for (let attempt = 2; attempt <= 3 && result.ok !== true; attempt++) {
    console.log(`⚠️ 第 ${attempt - 1} 次尝试未取回(${result.verdict}),8s 后重试(节律闸已重置;扩展 SW 30s 节律唤醒)`)
    await sleep(8_000)
    __resetRateLimiterForTest()
    result = await sessionDidaSearch({ timeoutMs: 50_000, allowAnonymous: skipGate })
  }
  await clickAssist

  console.log('\n════════ 会话检索结果 ════════')
  console.log(JSON.stringify(result, null, 2).slice(0, 4_000))
  const rates = result.rates ?? []
  console.log(`\nverdict=${result.verdict} rates=${rates.length}`)
  if (rates.length > 0) {
    console.log('样例:', JSON.stringify(rates.slice(0, 3), null, 2))
  }
  await browser.close()
  process.exit(result.verdict === 'hit' ? 0 : 2)
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
