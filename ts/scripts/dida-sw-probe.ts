/**
 * Extension SW 内部探针 v2:/json 列 targets + 原生 WebSocket 附着 SW,
 * Runtime.evaluate 现场验证 manifest 与 chrome.cookies 行为(只输出 cookie 名)。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const EXT_DIR = new URL('../../extension/', import.meta.url).pathname
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function cdpEval(wsUrl: string, expression: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => { ws.close(); reject(new Error('ws timeout')) }, 15_000)
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    }
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id === 1) {
        clearTimeout(timer)
        ws.close()
        resolve(msg.result?.result?.value ?? msg.result)
      }
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')) }
  })
}

async function main(): Promise<void> {
  const user = process.env.DIDA_USERNAME ?? ''
  const pass = process.env.DIDA_PASSWORD ?? ''
  if (!user || !pass) { console.error('env 必填'); process.exit(1) }

  const profileDir = mkdtempSync(join(tmpdir(), 'gotry-dida-swprobe-'))
  const chromeBin = process.env.CHROME_BIN
    ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
  const chrome = spawn(chromeBin, [
    '--remote-debugging-port=9235', `--user-data-dir=${profileDir}`, '--no-first-run',
    `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, 'about:blank',
  ], { stdio: 'ignore' })
  const cleanup = (): void => { try { chrome.kill() } catch {} try { rmSync(profileDir, { recursive: true, force: true }) } catch {} }
  process.on('exit', cleanup)

  await sleep(10_000)
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9235')
  const context = browser.contexts()[0]!

  // 登录 dida
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
    console.log('等待人工验证码 60s…')
    try { await page.waitForURL('**/hotel/**', { timeout: 60_000 }) } catch {}
  }
  await sleep(4_000)
  console.log('final url:', page.url())

  // 列 targets,找扩展 SW
  const list = await (await fetch('http://127.0.0.1:9235/json')).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string; title: string }>
  console.log('targets:', list.map((t) => `${t.type}:${t.url.slice(0, 70)}`).join('\n  '))
  const sw = list.find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'))
  if (!sw) { console.log('未找到扩展 SW target'); process.exit(2) }

  const diag = await cdpEval(sw.webSocketDebuggerUrl, `(async () => {
    const names = (cs) => cs.map(c => c.name + '@' + c.domain)
    const m = chrome.runtime.getManifest()
    const out = { id: chrome.runtime.id, version: m.version, hostPerms: m.host_permissions || [] }
    try { const all = await chrome.cookies.getAll({}); out.allCount = all.length; out.allSample = names(all.slice(0, 15)) } catch (e) { out.allErr = String(e) }
    for (const d of ['dida.com', '.dida.com']) {
      try { out['q_' + d] = names(await chrome.cookies.getAll({ domain: d })) } catch (e) { out['qErr_' + d] = String(e) }
    }
    try { out.q_url = names(await chrome.cookies.getAll({ url: 'https://portal.dida.com/' })) } catch (e) { out.qErr_url = String(e) }
    try { out.q_url_webapi = names(await chrome.cookies.getAll({ url: 'https://portal-webapi.dida.com/' })) } catch (e) { out.qErr_webapi = String(e) }
    try {
      const pk = await chrome.cookies.getAll({ domain: 'dida.com', partitionKey: {} })
      out.q_pk_empty = names(pk)
    } catch (e) { out.qErr_pk = String(e) }
    return out
  })()`)
  console.log(JSON.stringify(diag, null, 2))

  await browser.close()
  process.exit(0)
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
