/**
 * 携程酒店 GUI 车道(2026-10-14,#664 首片):gotry 隔离匿名窗口驱动 hotels.ctrip.com
 * PC 检索表单(目的地/入住/退房),被动收站点自己的酒店列表回包——城市解析交给站点
 * 自动补全(cityId 码表退出主链路),匿名公开价(非登录态价)。
 *
 * 与机票 GUI 车道(gui-flight.ts)同构:动作闭集 + 提交件黑名单 + readback 硬闸 +
 * 可注入 driver;复用 ctrip-hotel 适配器的三态分类器(classifyCtripHotelList:
 * parsed/recognized-empty/unrecognized——只有显式空列表才算 miss,绝不猜)。
 * 证据链 [会话:ctrip-hotel-gui@ts];anonymous 标注(登录态配对后为 false)。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { isSubmitText } from './read-guard.ts'
import { HOTEL_NETWORK_HINTS, looksLikeHotelListBody, classifyCtripHotelList, type SessionHotelOption } from './adapters/ctrip-hotel.ts'

export const HOTEL_GUI_HOME = 'https://hotels.ctrip.com/'
const YMD = /^\d{4}-\d{2}-\d{2}$/
const GUI_CHALLENGE_RE = /验证|校验|拖动滑块|请输入验证码/
/** 登录票据 cookie 名单(与 bridge 车道 LOGIN_COOKIE_NAMES 同源;只读名字) */
const TICKET_COOKIE_NAMES = ['cticket', 'uid', 'uname', 'passport']

export interface GuiHotelQuery {
  /** 目的地中文(站点自动补全解析,码表不在主链路) */
  to: string
  /** 入住 YYYY-MM-DD */
  checkIn: string
  /** 退房 YYYY-MM-DD(须晚于入住) */
  checkOut: string
  /** 登录态配对(2026-10-15,#664 余尾):匿名列表强制跳 passport 时,窗口停在官方登录页
   * 等用户本人完成登录(cookie 只读名字),随后原窗重驾拿登录态真实价。 */
  interactiveLoginMs?: number
  timeoutMs?: number
}

export type GuiHotelAction =
  | { t: 'goto'; url: string }
  | { t: 'typeCity'; text: string }
  | { t: 'pickSuggest'; text: string }
  | { t: 'setDate'; which: 'in' | 'out'; ymd: string }
  | { t: 'press'; key: string }
  | { t: 'readback'; expect: { to: string; checkIn: string; checkOut: string } }
  | { t: 'clickSearch' }
  | { t: 'awaitApi' }

/** 纯函数:查询 → 动作序列(离线测试锚点) */
export function planHotelGuiActions(q: GuiHotelQuery): GuiHotelAction[] {
  return [
    { t: 'goto', url: HOTEL_GUI_HOME },
    { t: 'typeCity', text: q.to },
    { t: 'pickSuggest', text: q.to },
    { t: 'setDate', which: 'in', ymd: q.checkIn },
    { t: 'setDate', which: 'out', ymd: q.checkOut },
    { t: 'press', key: 'Escape' },
    { t: 'readback', expect: { to: q.to, checkIn: q.checkIn, checkOut: q.checkOut } },
    { t: 'clickSearch' },
    { t: 'awaitApi' },
  ]
}

/** 安全白名单(与机票车道同款纪律) */
export function assertHotelPlanSafe(plan: GuiHotelAction[]): { ok: true } | { ok: false; error: string } {
  for (const a of plan) {
    switch (a.t) {
      case 'goto':
        if (a.url !== HOTEL_GUI_HOME) return { ok: false, error: `GUI 车道只允许固定入口 ${HOTEL_GUI_HOME}` }
        break
      case 'typeCity':
      case 'pickSuggest': {
        const text = a.text.trim()
        if (!text || text.length > 24) return { ok: false, error: `目的地文本非法:${text.slice(0, 30)}` }
        if (isSubmitText(text)) return { ok: false, error: `目的地位提交件文本,拒绝:${text}` }
        break
      }
      case 'setDate':
        if (!YMD.test(a.ymd)) return { ok: false, error: `日期需 YYYY-MM-DD,实际 ${a.ymd}` }
        break
      case 'press':
        if (a.key !== 'Escape' && a.key !== 'Enter') return { ok: false, error: `按键白名单外:${a.key}` }
        break
      case 'clickSearch':
      case 'awaitApi':
        break
      case 'readback':
        for (const v of [a.expect.to, a.expect.checkIn, a.expect.checkOut]) {
          if (!v.trim() || v.length > 24) return { ok: false, error: `readback 期望值非法:${v}` }
        }
        break
      default:
        return { ok: false, error: `动作闭集外:${JSON.stringify(a).slice(0, 60)}` }
    }
  }
  return { ok: true }
}

export interface GuiHotelPage {
  goto(url: string): Promise<void>
  typeCity(text: string): Promise<void>
  pickSuggest(text: string): Promise<void>
  setDate(which: 'in' | 'out', ymd: string): Promise<void>
  press(key: string): Promise<void>
  clickSearch(): Promise<void>
  visibleFormText(): Promise<string>
  destFieldValue(): Promise<string>
  pageText(): Promise<string>
  /** 当前页 URL(list 页真实形状回传) */
  currentUrl(): Promise<string>
  /** 登录态配对:窗口停在 passport 登录页等人完成登录(cookie 只读名字);超时 false */
  waitForHumanLogin(timeoutMs: number): Promise<boolean>
  waitForApiBody(timeoutMs: number): Promise<{ url: string; body: string } | null>
  recentApiUrls?(): Promise<string[]>
}

export interface GuiHotelDriver {
  open(): Promise<GuiHotelPage>
  close(): Promise<void>
}

export type GuiHotelVerdict = 'hit' | 'miss' | 'error' | 'challenged' | 'needs-login'

export interface GuiHotelResult {
  ok: boolean
  via: 'session-ctrip-hotel-gui' | 'session-ctrip-hotel-gui-error'
  evidence: string
  latencyMs: number
  verdict: GuiHotelVerdict
  hotels?: SessionHotelOption[]
  error?: string
  anonymous: boolean
  /** 检索后站点落到的 list 页 URL(真实形状回传) */
  listUrl?: string
}

let hotelDriverFactory: (() => GuiHotelDriver) | null = null
export function __setHotelDriverForTest(factory: (() => GuiHotelDriver) | null): void {
  hotelDriverFactory = factory
}

export async function runHotelGuiSearch(q: GuiHotelQuery): Promise<GuiHotelResult> {
  const started = Date.now()
  const ts = new Date().toISOString()
  let humanLoggedIn = false
  const fail = (error: string, verdict: GuiHotelVerdict = 'error'): GuiHotelResult => ({
    ok: false, via: 'session-ctrip-hotel-gui-error', latencyMs: Date.now() - started, verdict, error,
    evidence: `[会话:ctrip-hotel-gui@error@${ts}] ${error.slice(0, 120)}`, anonymous: !humanLoggedIn,
  })
  const needsLoginMessage = (): string =>
    '酒店列表需登录态:匿名窗口被重定向到携程登录页(红线:不自动登录)——interactiveLogin=true 可在窗口内本人登录后自动重查,或 gotry_session_login 后走 bridge 车道' 

  if (!(q.checkIn < q.checkOut)) return fail(`退房日期(${q.checkOut})须晚于入住(${q.checkIn})`)

  const plan = planHotelGuiActions(q)
  const safe = assertHotelPlanSafe(plan)
  if (!safe.ok) return fail(`GUI 计划被安全闸拒绝:${safe.error}`)

  const budget = q.timeoutMs ?? 90_000
  const driver = hotelDriverFactory ? hotelDriverFactory() : await createHotelPlaywrightDriver()
  let page: GuiHotelPage
  try {
    page = await withDeadline(driver.open(), Math.min(budget, 30_000), 'GUI 浏览器窗口启动失败/超时(本机需已装 Chrome)')
  } catch (e) {
    await driver.close().catch(() => {})
    return fail((e as Error).message.slice(0, 400))
  }

  let api: { url: string; body: string } | null = null
  let listUrl = ''
  class HotelFlowAbort { constructor(public result: GuiHotelResult) {} }
  const driveOnce = async (): Promise<void> => {
    for (const a of plan) {
      const remain = budget - (Date.now() - started)
      if (remain <= 0) throw new HotelFlowAbort(fail(`GUI 预算耗尽(${budget}ms)`))
      const step = <T,>(p: Promise<T>, what: string): Promise<T> =>
        withDeadline(p, Math.min(remain, 20_000), `GUI 步骤失败(${what})`)
      switch (a.t) {
        case 'goto': await step(page.goto(a.url), '打开携程酒店首页'); break
        case 'typeCity': await step(page.typeCity(a.text), '填写目的地'); break
        case 'pickSuggest': await step(page.pickSuggest(a.text), '选择目的地补全'); break
        case 'setDate': await step(page.setDate(a.which, a.ymd), `设置${a.which === 'in' ? '入住' : '退房'}日期`); break
        case 'press': await step(page.press(a.key), `按键 ${a.key}`); break
        case 'clickSearch':
          await step(page.clickSearch(), '点击搜索')
          // live 校准(2026-10-14):hotels list 对匿名窗口强制跳 passport 登录——
          // 诚实判 needs-login(不绕过、不重试),登录态走 bridge 车道。
          {
            const after = await page.currentUrl().catch(() => '')
            if (/passport\.ctrip\.com\/.*login/i.test(after)) {
              throw new HotelFlowAbort(fail('__NEEDS_LOGIN__', 'needs-login'))
            }
          }
          break
        case 'readback': {
          const dest = await step(page.destFieldValue(), '读回目的地框')
          const form = await step(page.visibleFormText(), '读回表单')
          if (!dest.includes(a.expect.to)) {
            throw new HotelFlowAbort(fail(`readback 硬闸:目的地框未确认「${a.expect.to}」(实际「${dest.slice(0, 30)}」)——已终止,未发起搜索`))
          }
          // live 校准:酒店表单日期显示为本地化格式(如 11月13日(周五))而非 YMD——双格式核对
          const dateShown = (ymd: string): boolean => {
            const cn = `${Number(ymd.slice(5, 7))}月${Number(ymd.slice(8, 10))}日`
            return form.includes(ymd) || form.includes(cn)
          }
          for (const [label, value] of [['入住日期', a.expect.checkIn], ['退房日期', a.expect.checkOut]] as const) {
            if (!dateShown(value)) {
              throw new HotelFlowAbort(fail(`readback 硬闸:${label}「${value}」未在表单确认(表单摘要:${form.slice(0, 200)})——已终止,未发起搜索`))
            }
          }
          break
        }
        case 'awaitApi': {
          const text = await step(page.pageText(), '检查页面')
          if (GUI_CHALLENGE_RE.test(text)) {
            throw new HotelFlowAbort(fail('风控/验证码命中;按红线不重试不绕过,交还用户', 'challenged'))
          }
          api = await step(page.waitForApiBody(Math.min(remain - 500, 18_000)), '等待酒店列表回包')
          if (!api) {
            const recent = page.recentApiUrls ? (await page.recentApiUrls().catch(() => [])) : []
            const nowUrl = await page.currentUrl().catch(() => '?')
            if (/passport\.ctrip\.com\/.*login/i.test(nowUrl)) {
              throw new HotelFlowAbort(fail('__NEEDS_LOGIN__', 'needs-login'))
            }
            throw new HotelFlowAbort(fail(`酒店列表回包嗅探超时(href=${nowUrl.slice(0, 120)})${recent.length ? ` ‖recent-apis: ${recent.slice(-8).join(' ; ').slice(0, 500)}` : ''}`))
          }
          break
        }
      }
    }
    return
  }

  try {
    await driveOnce()
  } catch (e) {
    // 登录态配对(#664 余尾,2026-10-15):needs-login 且调用方授权等待时,窗口停在官方
    // 登录页等用户本人完成登录(cookie 只读名字),随后原窗重驾一次拿登录态真实价。
    if (e instanceof HotelFlowAbort && e.result.verdict === 'needs-login' && q.interactiveLoginMs && q.interactiveLoginMs > 0) {
      const loggedIn = await withDeadline(page.waitForHumanLogin(q.interactiveLoginMs), q.interactiveLoginMs + 5_000, '等待人工登录').catch(() => false)
      if (!loggedIn) {
        return fail(`登录等待超时(${q.interactiveLoginMs}ms):用户未在 GUI 窗口完成登录——可稍后带 interactiveLogin 重试,或登录后走 bridge 车道`, 'needs-login')
      }
      humanLoggedIn = true
      api = null
      try {
        await driveOnce()
      } catch (e2) {
        if (e2 instanceof HotelFlowAbort) {
          return e2.result.error === '__NEEDS_LOGIN__'
            ? fail(needsLoginMessage(), 'needs-login')
            : e2.result
        }
        return fail((e2 as Error).message.slice(0, 400))
      }
    } else if (e instanceof HotelFlowAbort) {
      return e.result.error === '__NEEDS_LOGIN__'
        ? fail(needsLoginMessage(), 'needs-login')
        : e.result
    } else {
      return fail((e as Error).message.slice(0, 400))
    }
  } finally {
    await driver.close().catch(() => {})
  }
  try {
    listUrl = await page.currentUrl().catch(() => '')
  } catch { /* 已关窗口 */ }

  const captured = api as { url: string; body: string } | null
  if (captured === null) return fail('内部不变量失败:api 未结算(awaitApi 已过)')
  const classified = classifyCtripHotelList(captured.body)
  if (classified.shape === 'unrecognized') {
    return fail(`酒店列表回包形状未识别(body头:${captured.body.replace(/\s+/g, ' ').slice(0, 240)})`)
  }
  if (classified.shape === 'malformed') {
    return fail('酒店列表回包非 JSON(接口改版?)')
  }
  const hotels = classified.hotels
  const verdict: GuiHotelVerdict = hotels.length > 0 ? 'hit' : 'miss'
  return {
    ok: verdict === 'hit', via: 'session-ctrip-hotel-gui', latencyMs: Date.now() - started, verdict,
    ...(hotels.length > 0 ? { hotels: hotels.slice(0, 20) } : {}),
    ...(listUrl ? { listUrl } : {}),
    evidence: `[会话:ctrip-hotel-gui@${ts}] GUI 面检索:${hotels.length} 家(shape=${classified.shape};${humanLoggedIn ? '用户本人已在本窗口官方页登录,登录态真实价' : '匿名公开价,非登录态价'})`,
    anonymous: !humanLoggedIn,
  }
}

async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}:${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── 生产 driver:与机票车道同策略(隔离临时 profile headful Chrome) ──

const HOTEL_FORM_TEXT = `(() => Array.from(document.querySelectorAll('input'))
  .map(e => [e.value, e.placeholder].filter(Boolean).join('¤')).join(' | '))()`
const HOTEL_DEST_VALUE = `(() => { const els = Array.from(document.querySelectorAll('input')).filter(e => e.offsetParent)
  const hit = els.find(e => /目的地|城市|地点/.test(e.placeholder || '') && !/搜索/.test(e.placeholder || ''))
    || els.find(e => /目的地/.test(((e.parentElement && e.parentElement.innerText) || '').slice(0, 60)))
  return hit ? (hit.value || '') : '' })()`
const HOTEL_DATE_IDX = (which: 'in' | 'out'): string => `(() => { const els = Array.from(document.querySelectorAll('input')).filter(e => e.offsetParent)
  const hits = els.map((e, i) => ({ i, ph: e.placeholder || '', v: e.value || '' }))
    .filter(x => /入住|退房|离店|日期|date/i.test(x.ph) || /^\\d{4}-\\d{2}-\\d{2}/.test(x.v))
  const out = ${which === 'out'}
  if (hits.length >= (out ? 2 : 1)) return hits[out ? 1 : 0].i
  return els.length > 1 ? (out ? Math.min(2, els.length - 1) : 1) : 0 })()`
const HOTEL_CLICK_CELL = (ymd: string): string => {
  const day = String(Number(ymd.slice(8, 10)))
  const ymCn = `${ymd.slice(0, 4)}年${Number(ymd.slice(5, 7))}月`
  return `(() => {
    const all = Array.from(document.querySelectorAll('*'))
    const dayLeaves = all.filter(e => e.children.length === 0 && (e.textContent || '').trim() === '${day}')
    const clickEl = (e) => {
      const target = e.parentElement && /day|cell|date/.test(String(e.parentElement.className)) ? e.parentElement : e
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      target.click()
      return true }
    const ariaHit = dayLeaves.find(e =>
      ((e.getAttribute('aria-label') || '') + (e.getAttribute('title') || '')).includes('${ymd}'))
    if (ariaHit) return clickEl(ariaHit)
    const enabled = dayLeaves.filter(e => !/disabled|prev|next/.test(String(e.parentElement && e.parentElement.className)))
    if (enabled.length === 1) return clickEl(enabled[0])
    const norm = (s) => s.replace(/\\s+/g, '')
    let inTargetMonth = false
    for (const e of all) {
      const ownText = norm(Array.from(e.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join(''))
      if (/^\\d{4}年\\d{1,2}月$/.test(ownText)) { inTargetMonth = ownText === norm('${ymCn}'); continue }
      if (inTargetMonth && e.children.length === 0 && (e.textContent || '').trim() === '${day}') return clickEl(e)
    }
    return false })()`
}
const HOTEL_CLICK_SEARCH = `(() => {
  const els = Array.from(document.querySelectorAll('input')).filter(e => e.offsetParent)
  const anchor = els.find(e => /入住|退房|离店|日期|date/i.test(e.placeholder || '') || /^\\d{4}-\\d{2}-\\d{2}/.test(e.value || ''))
  if (!anchor) throw new Error('搜索按钮定位失败:日期框不存在')
  const click = (el) => {
    let target = el
    for (let k = 0; k < 3 && target.parentElement; k += 1) {
      const p = target.parentElement
      if (getComputedStyle(p).cursor === 'pointer' || p.tagName === 'BUTTON' || p.hasAttribute('role')) { target = p; break }
    }
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    target.click()
    return true }
  let node = anchor
  for (let k = 0; k < 8 && node; k += 1) {
    node = node.parentElement
    if (!node) break
    const hit = Array.from(node.querySelectorAll('*'))
      .find(e => e.children.length === 0 && (e.textContent || '').trim() === '搜索' && e.offsetParent)
    if (hit) return click(hit)
  }
  const rect = anchor.getBoundingClientRect()
  let best = null, bestDist = 1e9
  for (const e of Array.from(document.querySelectorAll('*'))) {
    if (e === anchor || !e.offsetParent || e.contains(anchor)) continue
    const r = e.getBoundingClientRect()
    if (r.width < 50 || r.width > 320 || r.height < 36) continue
    if (getComputedStyle(e).cursor !== 'pointer') continue
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
    if (cx < anchor.getBoundingClientRect().right - 40 || cx > anchor.getBoundingClientRect().right + 500) continue
    if (cy < rect.top - 80 || cy > rect.bottom + 160) continue
    const d = Math.abs(cy - (rect.top + rect.height / 2))
    if (d < bestDist) { best = e; bestDist = d }
  }
  if (best) return click(best)
  throw new Error('搜索按钮未找到') })()`

async function createHotelPlaywrightDriver(): Promise<GuiHotelDriver> {
  const { chromium } = await import('playwright-core')
  const profile = mkdtempSync(join(tmpdir(), 'gotry-gui-hotel-'))
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1480, height: 950 },
  })
  const page: Page = ctx.pages()[0] ?? (await ctx.newPage())
  let waiter: ((v: { url: string; body: string } | null) => void) | null = null
  const recentUrls: string[] = []
  page.on('request', r => {
    const u = r.url()
    if (/api|search|restapi|soa2|hotel|list/i.test(u) && !/\.(js|css|png|jpg|svg|woff)/.test(u)) {
      recentUrls.push(u.slice(0, 140))
      if (recentUrls.length > 30) recentUrls.shift()
    }
  })
  page.on('response', async r => {
    if (!waiter) return
    const url = r.url()
    if (!HOTEL_NETWORK_HINTS.some((re: RegExp) => re.test(url))) return
    try {
      const body = await r.text()
      if (!looksLikeHotelListBody(body)) return
      const resolve = waiter
      waiter = null
      resolve?.({ url, body })
    } catch { /* body gone */ }
  })
  return {
    async open(): Promise<GuiHotelPage> {
      const sleep = (ms: number): Promise<void> => page.waitForTimeout(ms)
      return {
        async goto(url) {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 })
          await page.locator('input:visible').first().waitFor({ state: 'visible', timeout: 30_000 })
          await sleep(2500)
        },
        async typeCity(text) {
          const direct = page.locator('input[placeholder*="目的地"]:visible, input[placeholder*="城市"]:visible').first()
          const fallback = page.locator('input:visible').first()
          const use = (await direct.count()) > 0 ? direct : fallback
          await use.click({ timeout: 6000 })
          await use.fill('', { timeout: 3000 }).catch(() => {})
          await use.pressSequentially(text, { delay: 160 })
        },
        async pickSuggest(text) {
          await sleep(1600)
          await page.keyboard.press('ArrowDown')
          await sleep(150)
          await page.keyboard.press('Enter')
          await sleep(700)
          const v = await page.evaluate<string>(HOTEL_DEST_VALUE).catch(() => '')
          if (!v.includes(text)) {
            await page.keyboard.press('ArrowDown')
            await sleep(150)
            await page.keyboard.press('Enter')
            await sleep(700)
          }
        },
        async setDate(which, ymd) {
          const idx = await page.evaluate<number>(HOTEL_DATE_IDX(which))
          const input = page.locator('input:visible').nth(idx)
          await input.click({ timeout: 5000 })
          await sleep(600)
          const typed = await input.evaluate((el: HTMLInputElement, v: string) => {
            if (el.readOnly) return false
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            setter?.call(el, v)
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return el.value === v
          }, ymd).catch(() => false)
          if (typed) { await sleep(400); return }
          const clicked = await page.evaluate<boolean>(HOTEL_CLICK_CELL(ymd)).catch(() => false)
          if (!clicked) throw new Error(`日期 ${ymd} 未能设置——readback 将兜底`)
          await sleep(400)
        },
        async press(key) { await page.keyboard.press(key) },
        async clickSearch() {
          await page.keyboard.press('Escape').catch(() => {})
          await sleep(500)
          await page.evaluate<void>(HOTEL_CLICK_SEARCH)
        },
        async visibleFormText() {
          return String(await page.evaluate<string>(HOTEL_FORM_TEXT).catch(() => ''))
        },
        async destFieldValue() {
          return String(await page.evaluate<string>(HOTEL_DEST_VALUE).catch(() => ''))
        },
        async pageText() {
          const title = await page.title().catch(() => '')
          const text = String(await page.evaluate<string>('document.body.innerText.slice(0, 3000)').catch(() => ''))
          return title + text
        },
        async currentUrl() { return page.url() },
        async waitForHumanLogin(timeoutMs: number) {
          // 红线:人自己完成登录;只轮询票据 cookie 名字(值即弃)。窗口此刻通常已在 passport 页。
          const deadline = Date.now() + timeoutMs
          while (Date.now() < deadline) {
            const names = await ctx.cookies().then(cs => cs.map(c => c.name)).catch(() => [] as string[])
            if (names.some(n => TICKET_COOKIE_NAMES.includes(n))) return true
            await page.waitForTimeout(5_000)
          }
          return false
        },
        async recentApiUrls() { return [...recentUrls] },
        async waitForApiBody(timeoutMs) {
          return new Promise(resolve => {
            const timer = setTimeout(() => {
              waiter = null
              resolve(null)
            }, timeoutMs)
            waiter = v => { clearTimeout(timer); resolve(v) }
          })
        },
      }
    },
    async close() {
      await ctx.close().catch(() => {})
      rmSync(profile, { recursive: true, force: true })
    },
  }
}
