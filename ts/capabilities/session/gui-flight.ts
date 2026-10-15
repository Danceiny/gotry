/**
 * 携程机票 GUI 车道(2026-10-14,创始人指示「直接新开 tab 打开 ctrip 页面操作 GUI」):
 * gotry 亲自开一个**隔离匿名**浏览器窗口(headful Chrome,临时 profile),驱动携程
 * PC 检索表单完成搜索,被动收站点自己的 batchSearch 回包——构造性覆盖「携程 PC
 * 有的功能」:往返/多程不需要知道 URL 形状,城市解析交给站点自己的自动补全
 * (城市码表退居缓存,永不在主链路上)。
 *
 * 与既有车道的关系(data-sources §8):
 *   - 扩展桥(默认):用户本人登录态,被动嗅探,用户 Chrome,零写;
 *   - GUI 车道:gotry 自己的匿名窗口,主动驱动**检索设置面**(trip/城市/日期),
 *     结果仍只从站点自己的 API 回包读取——写面红线不变:绝不触碰
 *     下单/支付/登录(动作白名单 + read-guard 提交件黑名单双闸);
 *   - Python browser-use 仍被否决(AGENTS 红线:不新增 Python 面)——本车道
 *     用仓库既有 playwright-core(TS,零新依赖)。
 *
 * 安全契约:
 *   - 动作闭集(goto/clickTripTab/typeCity/pickSuggest/setDate/press/readback/
 *     clickSearch/awaitApi),规划器产物先过 assertGuiPlanSafe 才可执行;
 *   - 一切可点文本过 isSubmitText(立即下单/去支付/提交订单…)→ 直接拒绝;
 *   - readback 硬闸:点搜索前逐项核对表单里已填的城市/日期与请求一致,
 *     不一致即 fail-closed 终止——绝不静默搜错城市/错日期;
 *   - 永不抛错;浏览器缺失/超时/风控页一律降级为结构化 verdict;
 *   - 节律闸不在本层(复用 session-search 的 ctrip-flight 桶,同站同闸)。
 *
 * 证据链:[会话:ctrip-flight-gui@ts](匿名 GUI 面标 anonymous,无登录态价格主张)。
 * 测试注入:__setGuiDriverForTest(离线全流程假 driver;默认 playwright 实现)。
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { isSubmitText } from './read-guard.ts'
import { NETWORK_HINTS, parseBatchSearchResult, LOGIN_COOKIE_NAMES, type SessionFlightOption } from './adapters/ctrip-flight.ts'

export const FLIGHT_GUI_HOME = 'https://flights.ctrip.com/'
/**
 * 低价日历接口(live 校准 2026-10-14):新版 PC 匿名 batchSearch 只回 needUserLogin
 * 配置探测(无行程数据),而该日历接口匿名有数据——GUI 车道的结果绑定面(#661)。
 */
export const CALENDAR_HINT = /FlightIntlAndInlandLowestPriceSearch/
const YMD = /^\d{4}-\d{2}-\d{2}$/
/** 挑战页特征(与桥车道同口径:验证/确认中文词) */
const GUI_CHALLENGE_RE = /验证|校验|拖动滑块|请输入验证码/

/** 动作闭集:GUI 车道能做的全部事情(检索设置面;无任何写语义)。
 * seg=多程行号(1–3;缺省 1)——2026-10-15 live 实测:多程表单为三行
 * [出发地|目的地|出发日期],标签同名按第 N 次出现消歧,日期框只读无占位符按序取。 */
export type GuiAction =
  | { t: 'goto'; url: string }
  | { t: 'clickTripTab'; trip: 'oneway' | 'roundtrip' | 'multi' }
  | { t: 'typeCity'; which: 'from' | 'to'; text: string; seg?: number }
  | { t: 'pickSuggest'; which: 'from' | 'to'; text: string; seg?: number }
  | { t: 'setDate'; which: 'dep' | 'back'; ymd: string; seg?: number }
  | { t: 'press'; key: string }
  | { t: 'readback'; expect: { legs: Array<{ from: string; to: string; date: string; back?: string }> } }
  | { t: 'clickSearch' }
  | { t: 'awaitApi' }

export interface GuiFlightLeg {
  from: string
  to: string
  /** YYYY-MM-DD */
  date: string
}

export interface GuiFlightQuery {
  from: string
  to: string
  /** YYYY-MM-DD(今天或未来) */
  date: string
  /** 存在即往返检索(回程日期) */
  backDate?: string
  /** 多程(2–3 段;存在即多程检索,忽略 from/to/date/backDate 顶层字段) */
  legs?: GuiFlightLeg[]
  /** 登录态配对(2026-10-15,#661 余尾):needUserLogin 探测命中时,窗口导航到携程官方
   * 登录页并等待用户本人在该窗口完成登录(cookie 只读名字,值即弃),随后自动重跑检索
   * 拿登录态行程明细。gotry 永不经手密码/验证码/cookie 值——登录永远发生在官方页。 */
  interactiveLoginMs?: number
  /** 总预算 ms(浏览器启动+SPA+检索),默认 90_000 */
  timeoutMs?: number
}

/** 纯函数:查询 → 动作序列(离线测试锚点;执行前必须过 assertGuiPlanSafe) */
export function planFlightGuiActions(q: GuiFlightQuery): GuiAction[] {
  // 多程(2026-10-15 live 实测:三行 [出发地|目的地|出发日期],标签第 N 次出现消歧)
  if (q.legs && q.legs.length >= 2) {
    const actions: GuiAction[] = [
      { t: 'goto', url: FLIGHT_GUI_HOME },
      { t: 'clickTripTab', trip: 'multi' },
    ]
    q.legs.slice(0, 3).forEach((leg, i) => {
      const seg = i + 1
      actions.push(
        { t: 'typeCity', which: 'from', text: leg.from, seg },
        { t: 'pickSuggest', which: 'from', text: leg.from, seg },
        { t: 'typeCity', which: 'to', text: leg.to, seg },
        { t: 'pickSuggest', which: 'to', text: leg.to, seg },
        { t: 'setDate', which: 'dep', ymd: leg.date, seg },
      )
    })
    actions.push(
      { t: 'press', key: 'Escape' },
      { t: 'readback', expect: { legs: q.legs.slice(0, 3).map(l => ({ from: l.from, to: l.to, date: l.date })) } },
      { t: 'clickSearch' },
      { t: 'awaitApi' },
    )
    return actions
  }
  // live 校准(2026-10-14 pre-search 截图):该表单默认即「往返」态(双日期框预填)——
  // 单程必须显式点「单程」,否则按非法日期对(回<去)搜索且日历面板挂在回程框上。
  const tripTab: GuiAction[] = [{ t: 'clickTripTab', trip: q.backDate ? 'roundtrip' : 'oneway' }]
  const backDate: GuiAction[] = q.backDate ? [{ t: 'setDate', which: 'back', ymd: q.backDate }] : []
  return [
    { t: 'goto', url: FLIGHT_GUI_HOME },
    ...tripTab,
    { t: 'typeCity', which: 'from', text: q.from },
    { t: 'pickSuggest', which: 'from', text: q.from },
    { t: 'typeCity', which: 'to', text: q.to },
    { t: 'pickSuggest', which: 'to', text: q.to },
    { t: 'setDate', which: 'dep', ymd: q.date },
    ...backDate,
    { t: 'press', key: 'Escape' },
    { t: 'readback', expect: { legs: [{ from: q.from, to: q.to, date: q.date, ...(q.backDate ? { back: q.backDate } : {}) }] } },
    { t: 'clickSearch' },
    { t: 'awaitApi' },
  ]
}

/**
 * 安全白名单(纯函数):闭集外动作/提交件文本/非固定入口 URL/坏日期/坏城市
 * 一律拒绝并给出原因;通过才允许执行器消费。
 */
export function assertGuiPlanSafe(plan: GuiAction[]): { ok: true } | { ok: false; error: string } {
  for (const a of plan) {
    switch (a.t) {
      case 'goto':
        if (a.url !== FLIGHT_GUI_HOME) return { ok: false, error: `GUI 车道只允许固定入口 ${FLIGHT_GUI_HOME},拒绝 ${a.url}` }
        break
      case 'clickTripTab':
        if (a.trip !== 'oneway' && a.trip !== 'roundtrip' && a.trip !== 'multi') return { ok: false, error: `trip 闭集外:${a.trip}` }
        break
      case 'typeCity':
      case 'pickSuggest': {
        const text = a.text.trim()
        if (!text || text.length > 24) return { ok: false, error: `城市文本非法(空/超长):${text.slice(0, 30)}` }
        if (isSubmitText(text)) return { ok: false, error: `城市位出现提交件文本,拒绝:${text}` }
        if (a.which !== 'from' && a.which !== 'to') return { ok: false, error: `which 闭集外:${a.which}` }
        if (a.seg !== undefined && (![1, 2, 3].includes(a.seg))) return { ok: false, error: `seg 闭集外:${a.seg}` }
        break
      }
      case 'setDate':
        if (!YMD.test(a.ymd)) return { ok: false, error: `日期需 YYYY-MM-DD,实际 ${a.ymd}` }
        if (a.which !== 'dep' && a.which !== 'back') return { ok: false, error: `which 闭集外:${a.which}` }
        if (a.seg !== undefined && (![1, 2, 3].includes(a.seg))) return { ok: false, error: `seg 闭集外:${a.seg}` }
        break
      case 'press':
        if (a.key !== 'Escape' && a.key !== 'Enter') return { ok: false, error: `按键白名单只接受 Escape/Enter,拒绝 ${a.key}` }
        break
      case 'clickSearch':
        break // 「搜索」是本车道唯一允许的按钮;提交件黑名单语义(下单/支付)不在其列
      case 'readback':
        if (!Array.isArray(a.expect.legs) || a.expect.legs.length < 1 || a.expect.legs.length > 3) {
          return { ok: false, error: 'readback legs 须 1–3 段' }
        }
        for (const leg of a.expect.legs) {
          for (const v of [leg.from, leg.to, leg.date, leg.back]) {
            if (v !== undefined && (!v.trim() || v.length > 24)) return { ok: false, error: `readback 期望值非法:${v}` }
          }
        }
        break
      case 'awaitApi':
        break
      default:
        return { ok: false, error: `动作闭集外:${JSON.stringify(a).slice(0, 60)}` }
    }
  }
  return { ok: true }
}

// ── driver 面(执行器与浏览器解耦;测试注入假 driver,生产 playwright) ──

export interface GuiPage {
  goto(url: string): Promise<void>
  /** 点行程 tab(单程/往返/多程);找不到=表单改版,fail-closed */
  clickTripTab(trip: 'oneway' | 'roundtrip' | 'multi'): Promise<void>
  /** 城市框逐键打字(触发站点自动补全);seg=多程行号(1–3,缺省 1) */
  typeCity(which: 'from' | 'to', text: string, seg?: number): Promise<void>
  /** 选自动补全首项并验证归一化(形如 上海(SHA);未选中即重试一次,仍失败抛错) */
  pickSuggest(which: 'from' | 'to', text: string, seg?: number): Promise<void>
  /** 日期设值:输入框可打字则打字,否则点日历单元格;seg=多程行号;正确性由 readback 兜底 */
  setDate(which: 'dep' | 'back', ymd: string, seg?: number): Promise<void>
  press(key: string): Promise<void>
  clickSearch(): Promise<void>
  /** 读回当前表单全部输入的值+占位符(readback 硬闸的数据面) */
  visibleFormText(): Promise<string>
  /** 出发/到达城市框当前值(逐字段核对;seg=多程行号) */
  cityFieldValues(seg?: number): Promise<{ from: string; to: string }>
  /** 登录态配对:窗口导航到携程官方登录页,等用户本人完成登录。
   * 只轮询登录票据 cookie 的名字(值即弃,红线);超时返回 false。 */
  waitForHumanLogin(timeoutMs: number): Promise<boolean>
  /** 挑战页检测(title+页面前 3KB 文本) */
  pageText(): Promise<string>
  /** 当前页 URL(#663 URL 教师:GUI 检索后回传 list 页真实形状) */
  currentUrl(): Promise<string>
  /** 等待结果回包:行程 batchSearch(优先)或低价日历(匿名可用);两者都到或超时结算 */
  waitForApiCapture(timeoutMs: number): Promise<GuiApiCapture | null>
  /** 最近 API 请求 URL(超时诊断;可选) */
  recentApiUrls?(): Promise<string[]>
}

/** 双槽捕获:itinerary=含 flightItineraryList 的 batchSearch;calendar=低价日历(匿名可用);
 * loginProbe=needUserLogin 配置探测(登录态配对触发信号)。 */
export interface GuiApiCapture {
  itinerary?: { url: string; body: string }
  calendar?: { url: string; body: string }
  loginProbe?: { url: string; body: string }
}

/** 低价日历单日条目(parser 按实测形状产出;绝不发明价格) */
export interface GuiCalendarDay {
  date: string
  price?: number
  priceRaw?: string
}

export interface GuiDriver {
  open(): Promise<GuiPage>
  close(): Promise<void>
}

export type GuiFlightVerdict = 'hit' | 'miss' | 'error' | 'challenged' | 'needs-login'

export interface GuiFlightResult {
  ok: boolean
  via: 'session-ctrip-flight-gui' | 'session-ctrip-flight-gui-error'
  evidence: string
  latencyMs: number
  verdict: GuiFlightVerdict
  options?: SessionFlightOption[]
  /** 低价日历(匿名可用;#662:该航线哪些日期有票/低价) */
  calendar?: GuiCalendarDay[]
  /** 检索后站点自己落到的 list 页 URL(#663 URL 教师:真实形状回传,不猜) */
  listUrl?: string
  error?: string
  /** 匿名公开面=显式标注;登录态配对后为 false(用户本人在 GUI 窗口官方页完成登录) */
  anonymous: boolean
  trip: 'oneway' | 'roundtrip' | 'multi'
}

/** 测试注入 seam(__setTrainSessionTransportForTest 同款) */
let guiDriverFactory: (() => GuiDriver) | null = null
export function __setGuiDriverForTest(factory: (() => GuiDriver) | null): void {
  guiDriverFactory = factory
}

/**
 * GUI 检索执行:规划→安全闸→driver 走动作→readback 硬闸→API 回包→既有解析器。
 * 永不抛错;driver 缺省时 lazy 起 playwright 隔离窗口(生产路径)。
 */
export async function runFlightGuiSearch(q: GuiFlightQuery): Promise<GuiFlightResult> {
  const started = Date.now()
  const ts = new Date().toISOString()
  const trip: 'oneway' | 'roundtrip' | 'multi' = q.legs && q.legs.length >= 2 ? 'multi' : q.backDate ? 'roundtrip' : 'oneway'
  let humanLoggedIn = false
  const base = { get anonymous() { return !humanLoggedIn }, trip }
  const fail = (error: string, verdict: GuiFlightVerdict = 'error'): GuiFlightResult => ({
    ok: false, via: 'session-ctrip-flight-gui-error', latencyMs: Date.now() - started, verdict, error,
    evidence: `[会话:ctrip-flight-gui@error@${ts}] ${error.slice(0, 120)}`, ...base,
  })

  const plan = planFlightGuiActions(q)
  const safe = assertGuiPlanSafe(plan)
  if (!safe.ok) return fail(`GUI 计划被安全闸拒绝:${safe.error}`)

  const budget = q.timeoutMs ?? 90_000
  const trace: string[] = []
  const driver = guiDriverFactory ? guiDriverFactory() : await createPlaywrightDriver()
  let page: GuiPage
  try {
    page = await withDeadline(driver.open(), Math.min(budget, 30_000), 'GUI 浏览器窗口启动失败/超时(本机需已装 Chrome)')
  } catch (e) {
    await driver.close().catch(() => {})
    return fail((e as Error).message.slice(0, 500))
  }

  let apiBody: GuiApiCapture | null = null
  let listUrl = ''
  /** 流程性失败(硬闸/挑战页/超时)以结果对象抛出,由外层统一返回 */
  class GuiFlowAbort { constructor(public result: GuiFlightResult) {} }

  /** 单次驾驶:整计划走到结果回包,返回捕获 */
  const driveOnce = async (): Promise<GuiApiCapture | null> => {
    let localCapture: GuiApiCapture | null = null
    for (const a of plan) {
      const remain = budget - (Date.now() - started)
      if (remain <= 0) throw new GuiFlowAbort(fail(`GUI 预算耗尽(${budget}ms)`))
      const step = <T,>(p: Promise<T>, what: string): Promise<T> =>
        withDeadline(p, Math.min(remain, 20_000), `GUI 步骤失败(${what})`)
      switch (a.t) {
        case 'goto': await step(page.goto(a.url), '打开携程机票首页'); break
        case 'clickTripTab': await step(page.clickTripTab(a.trip), `切换${a.trip === 'roundtrip' ? '往返' : a.trip === 'multi' ? '多程' : '单程'}`); break
        case 'typeCity': await step(page.typeCity(a.which, a.text, a.seg ?? 1), `填写第${a.seg ?? 1}段${a.which === 'from' ? '出发' : '到达'}城市`); break
        case 'pickSuggest':
          await step(page.pickSuggest(a.which, a.text, a.seg ?? 1), '选择城市自动补全项')
          if (a.which === 'to' && (a.seg ?? 1) === 1) trace.push(`after to-pick: ${JSON.stringify(await page.cityFieldValues(1).catch(() => ({})))}`)
          break
        case 'setDate': await step(page.setDate(a.which, a.ymd, a.seg ?? 1), `设置第${a.seg ?? 1}段${a.which === 'dep' ? '去程' : '回程'}日期`); break
        case 'press': await step(page.press(a.key), `按键 ${a.key}`); break
        case 'clickSearch': await step(page.clickSearch(), '点击搜索'); break
        case 'readback': {
          const form = await step(page.visibleFormText(), '读回表单')
          for (const [i, leg] of a.expect.legs.entries()) {
            const cities = await step(page.cityFieldValues(i + 1), `读回第${i + 1}段城市框`)
            if (!cities.from.includes(leg.from) || !cities.to.includes(leg.to)) {
              throw new GuiFlowAbort(fail(`readback 硬闸:第${i + 1}段城市框未确认「${leg.from}/${leg.to}」(实际「${cities.from.slice(0, 20)}/${cities.to.slice(0, 20)}」;表单摘要:${form.slice(0, 100)})——已终止,未发起搜索`))
            }
            if (!form.includes(leg.date)) {
              throw new GuiFlowAbort(fail(`readback 硬闸:第${i + 1}段日期「${leg.date}」未在表单确认(表单摘要:${form.slice(0, 120)})——已终止,未发起搜索`))
            }
            if (leg.back && !form.includes(leg.back)) {
              throw new GuiFlowAbort(fail(`readback 硬闸:回程日期「${leg.back}」未在表单确认——已终止,未发起搜索`))
            }
          }
          break
        }
        case 'awaitApi': {
          const text = await step(page.pageText(), '检查页面')
          if (GUI_CHALLENGE_RE.test(text)) {
            throw new GuiFlowAbort(fail('风控/验证码命中;按红线不重试不绕过,交还用户', 'challenged'))
          }
          localCapture = await step(page.waitForApiCapture(Math.min(remain - 500, 18_000)), '等待结果回包(batchSearch/低价日历)')
          if (!localCapture || (!localCapture.itinerary && !localCapture.calendar)) {
            const recent = page.recentApiUrls ? (await page.recentApiUrls().catch(() => [])) : []
            throw new GuiFlowAbort(fail(`结果回包嗅探超时:batchSearch(行程)与低价日历均未收到;本次检索未完成${recent.length ? ` ‖recent-apis: ${recent.slice(-8).join(' ; ').slice(0, 600)}` : ''}`))
          }
          break
        }
      }
    }
    return localCapture
  }

  try {
    apiBody = await driveOnce()
    // 登录态配对(#661 余尾,2026-10-15):匿名探测(needUserLogin)命中且调用方授权等待时,
    // 窗口停在携程官方登录页等用户本人完成登录(cookie 只读名字),随后原窗重驾一次拿登录态明细。
    if (q.interactiveLoginMs && q.interactiveLoginMs > 0 && apiBody?.loginProbe && !apiBody.itinerary) {
      const loggedIn = await withDeadline(page.waitForHumanLogin(q.interactiveLoginMs), q.interactiveLoginMs + 5_000, '等待人工登录')
      if (!loggedIn) {
        return fail(`登录等待超时(${q.interactiveLoginMs}ms):用户未在 GUI 窗口完成登录——本次未取得登录态行程;可稍后带 interactiveLogin 重试或用匿名日历面`, 'needs-login')
      }
      humanLoggedIn = true
      trace.push('human-login ok; re-drive')
      apiBody = await driveOnce()
    }
    listUrl = await page.currentUrl().catch(() => '')
  } catch (e) {
    if (e instanceof GuiFlowAbort) return e.result
    return fail(`${(e as Error).message.slice(0, 500)}${trace.length ? ` ‖trace: ${trace.join(' ; ').slice(0, 400)}` : ''}`)
  } finally {
    await driver.close().catch(() => {})
  }

  dumpCapture(apiBody, listUrl)
  // 结算优先级:行程 batchSearch(登录态/部分构建)> 低价日历(匿名可用,#661 绑定面)
  if (apiBody?.itinerary) {
    const parsed = parseBatchSearchResult(apiBody.itinerary.body)
    if (parsed.verdict === 'error') {
      return fail(`batchSearch 响应形状异常(${parsed.shape};非合法空响应)body头:${apiBody.itinerary.body.replace(/\s+/g, ' ').slice(0, 500)}`)
    }
    const verdict: GuiFlightVerdict = parsed.verdict === 'hit' ? 'hit' : 'miss'
    const calendar = apiBody.calendar ? parseLowestPriceCalendar(apiBody.calendar.body) : undefined
    return {
      ok: verdict === 'hit', via: 'session-ctrip-flight-gui', latencyMs: Date.now() - started, verdict,
      ...(verdict === 'hit' ? { options: parsed.options } : {}),
      ...(calendar && calendar.length > 0 ? { calendar } : {}),
      ...(listUrl ? { listUrl } : {}),
      evidence: `[会话:ctrip-flight-gui@${ts}] ${trip} GUI 面检索:${parsed.options.length} 条(transport=gui shape=${parsed.shape}${calendar?.length ? `;calendar=${calendar.length}天` : ''};${humanLoggedIn ? '用户本人已在本窗口官方页登录,登录态真实数据' : '匿名公开面'})`,
      ...base,
    }
  }
  if (apiBody?.calendar) {
    const calendar = parseLowestPriceCalendar(apiBody.calendar.body)
    if (calendar.length === 0) {
      return fail(`低价日历回包形状未识别(body头:${apiBody.calendar.body.replace(/\s+/g, ' ').slice(0, 300)};GOTRY_GUI_DUMP 可落盘原样供校准)`)
    }
    return {
      ok: true, via: 'session-ctrip-flight-gui', latencyMs: Date.now() - started, verdict: 'hit',
      calendar, ...(listUrl ? { listUrl } : {}),
      evidence: `[会话:ctrip-flight-gui@${ts}] ${trip} 匿名 GUI 面·低价日历:${calendar.length} 天(行程明细需登录态:interactiveLogin=true 可在窗口内本人登录后自动重查)`,
      ...base,
    }
  }
  return fail('内部不变量失败:apiBody 双槽皆空(awaitApi 已结算)')
}

/**
 * 低价日历解析(#662):按 live 实测形状产出 date/price;形状未识别返回空数组
 * (fail-closed,绝不发明价格)。形状锚定见 session-tests §L fixture。
 */
export function parseLowestPriceCalendar(body: string): GuiCalendarDay[] {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return []
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  // live 实测(2026-10-14,香港/上海 GUI 捕获):顶层 priceList 数组(responseStatus.Ack
  // 信封);兼容 data.* 形态。条目键按实测锚定,未识别=空(fail-closed)。
  const scopes: Array<Record<string, unknown>> = [raw as Record<string, unknown>]
  const data = (raw as { data?: unknown }).data
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) scopes.push(data as Record<string, unknown>)
  for (const key of ['priceList', 'priceCalendar', 'calendarList', 'lowPriceList', 'flightLowPrice']) {
    const list = scopes.map(scope => scope[key]).find(v => Array.isArray(v))
    if (!list) continue
    const days: GuiCalendarDay[] = []
    for (const item of list) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      const it = item as Record<string, unknown>
      // live 实测锚点(2026-10-14):departDate = .NET /Date(ms+0800)/;price>0 才是可售低价
      const date = netDateToYmd(it.departDate) ?? (typeof it.date === 'string' ? it.date.trim() : '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      if (typeof it.price !== 'number' || !Number.isFinite(it.price) || it.price <= 0) continue
      days.push({ date, price: it.price })
    }
    if (days.length > 0) {
      // 往返回包含去/回两程日历(同日双价,live 实测)——按日聚合取最低,evidence 可追溯。
      const byDate = new Map<string, GuiCalendarDay>()
      for (const d of days) {
        const prev = byDate.get(d.date)
        if (!prev || (d.price ?? Infinity) < (prev.price ?? Infinity)) byDate.set(d.date, d)
      }
      return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    }
  }
  return []
}

/** /Date(1791993600000+0800)/ → YYYY-MM-DD(按 +0800 面向用户的日历日) */
function netDateToYmd(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^\/Date\((\d+)(?:[+-]\d{4})?\)\/$/.exec(value.trim())
  if (!match) return undefined
  const ms = Number(match[1])
  if (!Number.isFinite(ms)) return undefined
  const d = new Date(ms + 8 * 3600 * 1000) // 日历面向 +0800 时区
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 校准/漂移诊断钩子:GOTRY_GUI_DUMP=<dir> 落盘原始回包与 listUrl(不含任何账号面) */
function dumpCapture(capture: GuiApiCapture | null, listUrl: string): void {
  const dir = process.env.GOTRY_GUI_DUMP
  if (!dir || !capture) return
  try {
    mkdirSync(dir, { recursive: true })
    if (capture.itinerary) writeFileSync(join(dir, 'itinerary.json'), capture.itinerary.body)
    if (capture.calendar) writeFileSync(join(dir, 'calendar.json'), capture.calendar.body)
    if (listUrl) writeFileSync(join(dir, 'page-url.txt'), listUrl)
  } catch { /* best effort */ }
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

// ── 生产 driver:隔离临时 profile 的 headful Chrome(匿名公开面;不碰用户 Chrome) ──

const VIS_FORM_TEXT = `(() => Array.from(document.querySelectorAll('input'))
  .map(e => [e.value, e.placeholder].filter(Boolean).join('¤')).join(' | '))()`
/**
 * 城市框定位(2026-10-14 live 校准,第 11 轮定稿):两框占位符同为「可输入城市或机场」,
 * 标签「出发地」「目的地」是与输入框同容器的叶子——祖先 ctx 判别会爬到共享行同时命中
 * 两框(实测 from/to 双双解析到同一框)。改文档顺序叶子邻接:标签叶子 ±10 叶子窗口内
 * 最近的「城市或机场」输入框即归属框。标签失配返回 -1(fail-closed 带实证)。
 */
/** CITY_LABEL_ADJOIN 思路(文档顺序标签±10 叶子窗口邻接)的落地:返回目标框在可见 input 序 */
const CITY_INPUT_IDX_FROM_LEAVES = (which: 'from' | 'to'): string => `(() => {
  const leaves = Array.from(document.querySelectorAll('*'))
    .filter(e => e.offsetParent && e.children.length === 0)
  const isCityInput = (e) => e.tagName === 'INPUT'
    && (!e.placeholder || /城市|机场/.test(e.placeholder)) && !/旅游|搜索|请输入/.test(e.placeholder || '')
  const inputs = leaves.map((e, i) => ({ e, i })).filter(({ e }) => isCityInput(e))
  const visibleInputs = Array.from(document.querySelectorAll('input')).filter(e => e.offsetParent)
  const nearest = (label) => {
    let li = -1
    for (let i = 0; i < leaves.length; i += 1) {
      const e = leaves[i]
      if ((e.textContent || '').trim() === label) { li = i; break }
    }
    if (li < 0) return -1
    let best = -1, bestDist = 99
    for (const inp of inputs) {
      const d = Math.abs(inp.i - li)
      if (d < bestDist && d <= 10) { best = inp.i; bestDist = d }
    }
    if (best < 0) return -1
    return visibleInputs.indexOf(leaves[best])
  }
  return nearest(${which === 'from' ? "'出发地'" : "'目的地'"}) })()`
const CITY_INPUT_IDX = CITY_INPUT_IDX_FROM_LEAVES
/** 多程行定位(live 实测 2026-10-15):三行 [出发地|目的地|出发日期],标签同名——
 * 「出发地/目的地」第 N 次出现(occurrence)的 ±10 叶子窗口内城市输入框即第 N 段框。 */
const CITY_INPUT_IDX_N = (which: 'from' | 'to', occurrence: number): string => `(() => {
  const leaves = Array.from(document.querySelectorAll('*'))
    .filter(e => e.offsetParent && e.children.length === 0)
  const isCityInput = (e) => e.tagName === 'INPUT'
    && (!e.placeholder || /城市|机场/.test(e.placeholder)) && !/旅游|搜索|请输入/.test(e.placeholder || '')
  const inputs = leaves.map((e, i) => ({ e, i })).filter(({ e }) => isCityInput(e))
  const visibleInputs = Array.from(document.querySelectorAll('input')).filter(e => e.offsetParent)
  const label = ${which === 'from'} ? '出发地' : '目的地'
  const yOf = (e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2 }
  let seen = 0
  for (let li = 0; li < leaves.length; li += 1) {
    if ((leaves[li].textContent || '').trim() !== label) continue
    seen += 1
    if (seen !== ${occurrence}) continue
    const ly = yOf(leaves[li])
    let best = -1, bestDist = 99
    for (const inp of inputs) {
      const d = Math.abs(inp.i - li)
      // 同行 y 对齐(±60px):防止上一行已物化框抢亲(多程行惰性物化,live 实测)
      if (d < bestDist && d <= 10 && Math.abs(yOf(inp.e) - ly) <= 60) { best = inp.i; bestDist = d }
    }
    if (best >= 0) return visibleInputs.indexOf(leaves[best])
  }
  return -1 })()`
/** 城市框当前值(出发/到达各自;readback 逐字段核对用,防全局搜索框文本假阳) */
const CITY_FIELD_VALUES_FN = (occurrence?: number): string => `(() => {
  const leaves = Array.from(document.querySelectorAll('*'))
    .filter(e => e.offsetParent && e.children.length === 0)
  const isCityInput = (e) => e.tagName === 'INPUT'
    && (!e.placeholder || /城市|机场/.test(e.placeholder)) && !/旅游|搜索|请输入/.test(e.placeholder || '')
  const inputs = leaves.map((e, i) => ({ e, i })).filter(({ e }) => isCityInput(e))
  const nearest = (label, occurrence) => {
    let li = -1, seen = 0
    for (let i = 0; i < leaves.length; i += 1) {
      if ((leaves[i].textContent || '').trim() === label) {
        seen += 1
        if (seen === (occurrence || 1)) { li = i; break }
      }
    }
    if (li < 0) return null
    const yOf = (e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2 }
    const ly = yOf(leaves[li])
    let best = null, bestDist = 99
    for (const inp of inputs) {
      const d = Math.abs(inp.i - li)
      if (d < bestDist && d <= 10 && Math.abs(yOf(inp.e) - ly) <= 60) { best = inp; bestDist = d }
    }
    return best
  }
  const f = nearest('出发地', ${occurrence ?? 1}), t = nearest('目的地', ${occurrence ?? 1})
  return JSON.stringify({ from: f ? (f.e.value || '') : '', to: t ? (t.e.value || '') : '' }) })()`
/** 日期框定位(live 校准:只读,占位 yyyy-mm-dd;往返时第二个) */
const DATE_INPUT_IDX = (which: 'dep' | 'back'): string => `(() => { const els = Array.from(document.querySelectorAll('input')).filter(e => e.offsetParent)
  const hits = els.map((e, i) => ({ i, ph: e.placeholder || '', ro: e.readOnly, v: e.value || '' }))
    .filter(x => /y{2,4}[-/]m{1,2}|日期|date/i.test(x.ph) || /^\\d{4}-\\d{2}-\\d{2}/.test(x.v))
  const back = ${which === 'back'}
  if (hits.length >= (back ? 2 : 1)) return hits[back ? 1 : 0].i
  return els.length - 1 })()`
/** 多程日期框(live 实测 2026-10-15:只读无占位符,按序=第 N 个只读空占位输入) */
const DATE_INPUT_IDX_SEG = (seg: number): string => `(() => { const els = Array.from(document.querySelectorAll('input')).filter(e => e.offsetParent)
  const dates = els.map((e, i) => ({ i, ro: e.readOnly, ph: e.placeholder || '' }))
    .filter(x => (x.ro && !x.ph) || /日期|date/i.test(x.ph))
  const idx = ${seg} - 1
  return dates.length > idx ? dates[idx].i : -1 })()`
/** 多程段就绪谓词:第 N 个「出发地」标签 ±6 叶子内出现城市输入框(行惰性物化,live 实测 2026-10-15) */
const SEG_READY = (occurrence: number): string => `(() => {
  const leaves = Array.from(document.querySelectorAll('*')).filter(e => e.offsetParent && e.children.length === 0)
  let seen = 0
  for (let li = 0; li < leaves.length; li += 1) {
    if ((leaves[li].textContent || '').trim() !== '出发地') continue
    seen += 1
    if (seen !== ${occurrence}) continue
    return leaves.some((e, i) => Math.abs(i - li) <= 6 && e.tagName === 'INPUT'
      && (!e.placeholder || /城市|机场/.test(e.placeholder || '')) && !/旅游|搜索|请输入/.test(e.placeholder || ''))
  }
  return false })()`
/** 点击第 N 个行标签(出发地/目的地;行惰性物化的物化触发) */
const CLICK_SEG_LABEL = (label: '出发地' | '目的地', occurrence: number): string => `(() => {
  const leaves = Array.from(document.querySelectorAll('*')).filter(e => e.offsetParent && e.children.length === 0)
  let seen = 0
  for (const e of leaves) {
    if ((e.textContent || '').trim() !== '${label}') continue
    seen += 1
    if (seen === ${occurrence}) { (e.parentElement || e).click(); return true }
  }
  return false })()`

/** 表单内搜索按钮(live 校准:按钮是无语义 div,文本「搜索」为精确叶子;全局搜索框旁
 *  也有「搜索」——只在日期框 8 层祖先窗口内找,绝不全局兜底) */
const CLICK_FORM_SEARCH = `(() => {
  const els = Array.from(document.querySelectorAll('input')).filter(e => e.offsetParent)
  const dateEls = els.filter(e => /y{2,4}[-/]m{1,2}|日期|date/i.test(e.placeholder || '')
    || (!e.placeholder && e.readOnly) || /^\d{4}-\d{2}-\d{2}/.test(e.value || ''))
  // 多程(live 实测 2026-10-15):行堆叠,搜索按钮在末行右/下方——锚=最底部日期框
  const dateEl = dateEls.length
    ? dateEls.reduce((a, b) => ((a.getBoundingClientRect().top >= b.getBoundingClientRect().top) ? a : b))
    : undefined
  if (!dateEl) throw new Error('搜索按钮定位失败:日期框不存在')
  const click = (el) => {
    let target = el
    for (let k = 0; k < 3 && target.parentElement; k += 1) {
      const p = target.parentElement
      const st = getComputedStyle(p)
      if (st.cursor === 'pointer' || p.tagName === 'BUTTON' || p.hasAttribute('role')) { target = p; break }
    }
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    target.click()
    return true }
  // 几何判据 v2(live 校准 2026-10-14:按钮在表单行右端的无语义 styled div,文本非
  // 「搜索」叶子;首版「下方最大块」会误中低价推广卡——SHA→TGO fuzzy 跳页实测):
  // ①行右端:cx 在日期框右侧 500px 内、cy 与行对齐,宽 60–320、高 ≥40,取最近;
  // ②次选:日期框正下方 250px 内的窄块(兼容改版)。绝不取大横幅(宽>320)。
  const dateRect = dateEl.getBoundingClientRect()
  let rowBtn = null, rowDist = 1e9
  let belowBtn = null, belowDist = 1e9
  for (const e of Array.from(document.querySelectorAll('*'))) {
    if (e === dateEl || !e.offsetParent || e.contains(dateEl)) continue
    const r = e.getBoundingClientRect()
    if (r.width < 60 || r.width > 320 || r.height < 40) continue
    if (getComputedStyle(e).cursor !== 'pointer') continue
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    if (cx >= dateRect.right - 20 && cx <= dateRect.right + 500
      && cy >= dateRect.top - 320 && cy <= dateRect.bottom + 400) {
      const d = Math.abs(cy - (dateRect.top + dateRect.height / 2)) + (cx - dateRect.right) * 0.2
      if (d < rowDist) { rowBtn = e; rowDist = d }
    }
    if (cy >= dateRect.bottom && cy <= dateRect.bottom + 400
      && cx >= dateRect.left - 80 && cx <= dateRect.right + 420) {
      const d = cy - dateRect.bottom
      if (d < belowDist) { belowBtn = e; belowDist = d }
    }
  }
  const best = rowBtn || belowBtn
  if (best) return click(best)
  // 兜底(live 实测 2026-10-15 多程):按钮=右侧蓝色「搜索」大块,若指针游标不在本体上,
  // 按右半区的「搜索」精确叶子点其可点祖先。
  const searchLeaf = Array.from(document.querySelectorAll('*'))
    .find(e => e.children.length === 0 && (e.textContent || '').trim() === '搜索' && e.offsetParent
      && e.getBoundingClientRect().left > dateRect.left)
  if (searchLeaf) return click(searchLeaf)
  // 终极兜底(live 截图实证 2026-10-15 多程:按钮=表单右侧蓝色圆角大块):蓝色主导背景
  // 且 ≥80×80、位于表单纵向范围内 → 点击(白字「搜索」可能在非叶子嵌套里,不依赖文本)。
  const top = dateEls.reduce((m, e) => Math.min(m, e.getBoundingClientRect().top), 1e9)
  const bottom = dateEls.reduce((m, e) => Math.max(m, e.getBoundingClientRect().bottom), -1e9)
  let blue = null, blueArea = 0
  for (const e of Array.from(document.querySelectorAll('*'))) {
    if (!e.offsetParent) continue
    const r = e.getBoundingClientRect()
    if (r.width < 80 || r.height < 80 || r.width > 360) continue
    const cy = r.top + r.height / 2
    if (cy < top - 200 || cy > bottom + 300) continue
    const bgNums = getComputedStyle(e).backgroundColor.replace(/[^0-9,]/g, '').split(',').filter(s2 => s2 !== '').map(Number)
    if (bgNums.length < 3) continue
    const [rr, gg, bb] = [bgNums[0], bgNums[1], bgNums[2]]
    if (bb > 140 && bb > rr + 40 && bb > gg + 30) {
      const area = r.width * r.height
      if (area > blueArea) { blue = e; blueArea = area }
    }
  }
  if (blue) return click(blue)
  const ptr = Array.from(document.querySelectorAll('*'))
    .filter(e => e.offsetParent && getComputedStyle(e).cursor === 'pointer' && e.textContent && e.textContent.trim().length <= 6)
    .slice(0, 10).map(e => ({ t: (e.textContent || '').trim(), tag: e.tagName, cls: String(e.className).slice(0, 40) }))
  throw new Error('搜索按钮未找到(日期框下方几何窗口内无 pointer 大块)pointer 候选:' + JSON.stringify(ptr))
})()`
/** 校准采集版(GOTRY_GUI_DUMP 时 driver 落盘):行内全部 pointer 候选(文本/标签/类名/矩形) */
const CLICK_FORM_SEARCH_CANDIDATES = `(() => {
  const els = Array.from(document.querySelectorAll('input')).filter(e => e.offsetParent)
  const dateEl = els.find(e => /y{2,4}[-/]m{1,2}|日期|date/i.test(e.placeholder || '') || /^\\d{4}-\\d{2}-\\d{2}/.test(e.value || ''))
  if (!dateEl) return JSON.stringify({ err: 'no dateEl' })
  const dateRect = dateEl.getBoundingClientRect()
  const cands = Array.from(document.querySelectorAll('*'))
    .filter(e => e.offsetParent && getComputedStyle(e).cursor === 'pointer')
    .map(e => { const r = e.getBoundingClientRect()
      return { t: (e.textContent || '').trim().slice(0, 24), tag: e.tagName, cls: String(e.className).slice(0, 60),
        x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } })
    .filter(c => c.w >= 20 && c.h >= 12)
    .slice(0, 100)
  return JSON.stringify({ dateRect: { x: Math.round(dateRect.left), y: Math.round(dateRect.top), w: Math.round(dateRect.width), h: Math.round(dateRect.height) }, cands })
})()`

/**
 * 日历单元格(live 校准 2026-10-14):channel/domestic 日历同屏双月(「2026年10月」「2026年11月」),
 * 日号格不匹配通用选择器——改走文档顺序状态机:叶子元素流里,目标月标题(YYYY年M月)之后、
 * 下一个月标题之前,文本恰为日号的第一个元素即目标格;aria-label/title 含完整日期者优先。
 */
const CLICK_DATE_CELL = (ymd: string, anchorYmd?: string): string => {
  const day = String(Number(ymd.slice(8, 10)))
  const ymCn = `${ymd.slice(0, 4)}年${Number(ymd.slice(5, 7))}月`
  return `(() => {
    const all = Array.from(document.querySelectorAll('*'))
    const dayLeaves = all.filter(e => e.children.length === 0 && (e.textContent || '').trim() === '${day}')
    const clickEl = (e) => {
      const target = e.parentElement && /date-day|day|cell/.test(String(e.parentElement.className)) ? e.parentElement : e
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      target.click()
      return true }
    // 捷径:aria-label/title 含完整日期
    const ariaHit = dayLeaves.find(e =>
      ((e.getAttribute('aria-label') || '') + (e.getAttribute('title') || '')).includes('${ymd}'))
    if (ariaHit) return clickEl(ariaHit)
    // 捷径:目标月可视(面板 body 含 YYYY年M月)且候选日号中父级非 disabled 的恰一个 → 直接点
    // (2026-10-15 教训:目标月不在可视双月时,enabled-unique 会选中相邻月的同号日)
    const ymVisible = Array.from(document.querySelectorAll('.month'))
      .some(e => ((e.textContent || '').trim() === '${Number(ymd.slice(5, 7))}月') || ((e.textContent || '').trim().includes('${ymCn}')))
    const enabled = dayLeaves.filter(e => !/disabled/.test(String(e.parentElement && e.parentElement.className)))
    if (ymVisible && enabled.length === 1) return clickEl(enabled[0])
    // 几何月消歧(live 校准 2026-10-14 往返回程:双月面板两个同日号都可点,月标题元素
    // 不可寻):日号格按 x 聚簇=月列,以「今天」锚定第 0 列=当前月,目标月偏移选列。
    const rect = (e) => e.getBoundingClientRect()
    const xs = enabled.map(e => rect(e).left + rect(e).width / 2).sort((a, b) => a - b)
    if (xs.length >= 2 && xs[xs.length - 1] - xs[0] > 120) {
      const split = (xs[0] + xs[xs.length - 1]) / 2
      const left = enabled.filter(e => rect(e).left + rect(e).width / 2 < split)
      const right = enabled.filter(e => rect(e).left + rect(e).width / 2 >= split)
      const anchor = ${anchorYmd ? `{ y: ${Number(anchorYmd.slice(0, 4))}, m: ${Number(anchorYmd.slice(5, 7))} }` : 'null'}
      const now = new Date()
      const ay = anchor ? anchor.y : now.getFullYear()
      const am = anchor ? anchor.m : now.getMonth() + 1
      const delta = (${Number(ymd.slice(0, 4))} * 12 + ${Number(ymd.slice(5, 7))}) - (ay * 12 + am)
      const pick = delta <= 0 ? left[0] : delta === 1 ? right[0] : null
      if (pick) return clickEl(pick)
    }
    // 兜底:月边界状态机(月标题去空白精确匹配;标题可能拆分文本节点)
    const norm = (s) => s.replace(/\\s+/g, '')
    let inTargetMonth = false
    for (const e of all) {
      const ownText = norm(Array.from(e.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join(''))
      if (/^\\d{4}年\\d{1,2}月$/.test(ownText)) { inTargetMonth = ownText === norm('${ymCn}'); continue }
      if (inTargetMonth && e.children.length === 0 && (e.textContent || '').trim() === '${day}') return clickEl(e)
    }
    return false })()`
}

/** 日历翻月(live 实测 2026-10-15:面板头 iconf-right=下月,iconf-left.disa=上月禁用) */
const CLICK_NEXT_MONTH = `(() => {
  const next = Array.from(document.querySelectorAll('[class*=in-date-picker][class*=iconf-right],[class*=in-date-picker][class*=next-ico]'))
    .filter(e => e.offsetParent && !/disa/.test(String(e.className)))[0]
  if (!next) return false
  ;(next.parentElement || next).click()
  return true })()`
/** 目标月是否可视(live 实测:面板月标题=SPAN.month,形如「10月」无年份) */
const YM_VISIBLE = (ymd: string): string => `Array.from(document.querySelectorAll('.month'))
  .some(e => ((e.textContent || '').trim() === '${Number(ymd.slice(5, 7))}月')
    || ((e.textContent || '').trim().includes('${ymd.slice(0, 4)}年${Number(ymd.slice(5, 7))}月')))`

async function createPlaywrightDriver(): Promise<GuiDriver> {
  const { chromium } = await import('playwright-core')
  const profile = mkdtempSync(join(tmpdir(), 'gotry-gui-flight-'))
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chrome', // 本机 Chrome,不下载浏览器(session PoC 同款)
    headless: false, // headless 下携程回壳页(data-sources §8 已验证)
    viewport: { width: 1480, height: 950 },
  })
  const page: Page = ctx.pages()[0] ?? (await ctx.newPage())

  // 双槽捕获:行程 batchSearch(优先)与低价日历(#661);监听常挂,waitForApiCapture 注册等待者
  const capture: GuiApiCapture = {}
  let apiWaiter: ((v: GuiApiCapture | null) => void) | null = null
  let itinerarySeen = false
  const recentUrls: string[] = []
  page.on('request', r => {
    const u = r.url()
    if (/api|search|restapi|soa2|itinerary/i.test(u) && !/\\.(js|css|png|jpg|svg|woff)/.test(u)) {
      recentUrls.push(u.slice(0, 140))
      if (recentUrls.length > 30) recentUrls.shift()
    }
  })
  page.on('response', async r => {
    const url = r.url()
    const isItineraryHint = NETWORK_HINTS.some((re: RegExp) => re.test(url))
    const isCalendarHint = CALENDAR_HINT.test(url)
    if (!isItineraryHint && !isCalendarHint) return
    try {
      const body = await r.text()
      if (isCalendarHint) {
        capture.calendar = { url, body }
      } else if (body.includes('flightItineraryList')) {
        capture.itinerary = { url, body }
        itinerarySeen = true
      } else if (body.includes('needUserLogin')) {
        // 配置预检回包(needUserLogin 探测)——作为登录态配对触发信号捕获
        capture.loginProbe = { url, body }
      }
      // 行程一到位即早结算(最富数据);否则等日历或超时
      if (itinerarySeen && apiWaiter) {
        const resolve = apiWaiter
        apiWaiter = null
        resolve?.({ ...capture })
      }
    } catch { /* 回包体已释放 */ }
  })

  return {
    async open(): Promise<GuiPage> {
      const sleep = (ms: number): Promise<void> => page.waitForTimeout(ms)
      const visibleInput = (i: number) => page.locator('input:visible').nth(i)
      let lastDepYmd = ''
      const cityValues = async (seg = 1): Promise<{ from: string; to: string }> =>
        JSON.parse(String(await page.evaluate<string>(CITY_FIELD_VALUES_FN(seg)).catch(() => '{"from":"","to":""}'))) as { from: string; to: string }
      return {
        async goto(url) {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 })
          // 就绪闸(live 校准 2026-10-14:channel/domestic 冷启动是骨架屏,提前操作会被
          // hydrate 重建表单吞掉——城市值消失/框互换都源于此)。等表单真出现再动手。
          await page.locator('input[placeholder*="城市或机场"]').first().waitFor({ state: 'visible', timeout: 30_000 })
          await sleep(2500) // hydrate 后的二次稳定
        },
        async clickTripTab(trip) {
          const label = trip === 'roundtrip' ? '往返' : trip === 'multi' ? '多程' : '单程'
          try {
            await page.getByText(label, { exact: true }).first().click({ timeout: 4000 })
          } catch {
            try {
              await page.getByText(label, { exact: false }).first().click({ timeout: 4000 })
            } catch {
              // 实证诊断:把页面真实事实(url/title/候选文本)带进错误,供下一轮校准
              const facts = String(await page.evaluate<string>(
                `(() => JSON.stringify({ url: location.href.slice(0, 120), title: document.title.slice(0, 80),
                  cands: Array.from(document.querySelectorAll('*'))
                    .filter(e => e.children.length === 0 && /单程|往返|多程/.test(e.textContent || '') && e.offsetParent)
                    .slice(0, 8).map(e => (e.textContent || '').trim()) }))()`,
              ).catch(() => '?'))
              throw new Error(`行程 tab「${label}」未命中;页面事实:${facts}`)
            }
          }
          await sleep(800)
        },
        async typeCity(which, text, seg = 1) {
          // 多程行惰性物化(live 实测 2026-10-15):第 N 行城市框在前行填完后才出现——
          // 先等就绪,超时点该行「出发地」标签触发物化再等,仍无则 fail-closed。
          if (seg > 1) {
            const ready = await page.waitForFunction(SEG_READY(seg), { timeout: 6000 }).then(() => true).catch(() => false)
            if (!ready) {
              await page.evaluate<void>(CLICK_SEG_LABEL('出发地', seg)).catch(() => {})
              await page.waitForTimeout(1200)
              const ready2 = await page.waitForFunction(SEG_READY(seg), { timeout: 4000 }).then(() => true).catch(() => false)
              if (!ready2) throw new Error(`第${seg}段城市框未物化(点「出发地」标签后仍未出现)——表单改版?`)
            }
          }
          // 标签即时定位(「出发地」/「目的地」;多程=标签第 N 次出现;就绪闸后 DOM 已稳定)
          let idx = await page.evaluate<number>(seg > 1 ? CITY_INPUT_IDX_N(which, seg) : CITY_INPUT_IDX(which))
          // 「到达」框可能仍惰性:点该行「目的地」标签触发物化后重定位(严格同行,绝不覆写前行)
          if (idx < 0 && seg > 1 && which === 'to') {
            await page.evaluate<void>(CLICK_SEG_LABEL('目的地', seg)).catch(() => {})
            await page.waitForTimeout(1200)
            idx = await page.evaluate<number>(CITY_INPUT_IDX_N(which, seg))
          }
          if (idx < 0) {
            await page.screenshot({ path: `/tmp/gotry-gui-typecity-${which}-${Date.now()}.png` }).catch(() => {})
            const rows = String(await page.evaluate<string>(`(() => JSON.stringify({
              inputs: Array.from(document.querySelectorAll('input')).filter(e => e.offsetParent).map(e => {
                const r = e.getBoundingClientRect()
                return { ph: (e.placeholder || '').slice(0, 10), y: Math.round(r.top), v: (e.value || '').slice(0, 16) }
              }).slice(0, 12),
              labels: Array.from(document.querySelectorAll('*'))
                .filter(e => e.offsetParent && e.children.length === 0 && /^(出发地|目的地)$/.test((e.textContent || '').trim()))
                .map(e => { const r = e.getBoundingClientRect(); return { t: (e.textContent || '').trim(), y: Math.round(r.top) } })
            }))()`).catch(() => '?'))
            const href = String(await page.evaluate<string>('location.href').catch(() => '?'))
            throw new Error(`${which === 'from' ? '出发' : '到达'}城市输入框未定位到(seg=${seg};href=${href});行结构:${rows.slice(0, 700)}`)
          }
          const input = visibleInput(idx)
          await input.click({ timeout: 5000 })
          await input.fill('', { timeout: 3000 }).catch(() => {})
          await input.pressSequentially(text, { delay: 160 })
        },
        async pickSuggest(which, text, seg = 1) {
          // 站点补全默认高亮首项:ArrowDown+Enter 显式选中(live 校准:裸 Enter 可能
          // 未命中面板,失焦后字段回弹默认值);选中后验证归一化 (XXX),不成立重试一次。
          const pick = async (): Promise<boolean> => {
            await sleep(1800)
            await page.keyboard.press('ArrowDown')
            await sleep(150)
            await page.keyboard.press('Enter')
            await sleep(700)
            const values = await cityValues(seg)
            const v = which === 'from' ? values.from : values.to
            return v.includes(text) && /\([A-Z]{3}\)/.test(v)
          }
          if (await pick()) return
          if (await pick()) return
          if (seg > 1) await sleep(1500) // 行内后续框的物化窗口(live 实测)
          await page.screenshot({ path: `/tmp/gotry-gui-pick-${which}-${Date.now()}.png` }).catch(() => {})
          const href = String(await page.evaluate<string>('location.href').catch(() => '?'))
          const values = await cityValues(seg)
          const ctxDump = String(await page.evaluate<string>(
            `(() => JSON.stringify(Array.from(document.querySelectorAll('input'))
              .filter(e => e.offsetParent && /城市|机场/.test(e.placeholder || '') && !/旅游|搜索/.test(e.placeholder || ''))
              .map(e => { let node = e, ctx = ''
                for (let k = 0; k < 4 && node; k++) { node = node.parentElement; if (node) ctx += '∥' + node.innerText.slice(0, 100) }
                return { ph: e.placeholder, v: e.value, ctx: ctx.slice(0, 260) } })))()`,
          ).catch(() => '?'))
          throw new Error(`城市补全未选中:${which} 框实际「${(which === 'from' ? values.from : values.to).slice(0, 30)}」(期望含 ${text} 且归一化为 (三字码);href=${href});城市框实证:${ctxDump.slice(0, 900)}`)
        },
        async setDate(which, ymd, seg = 1) {
          if (which === 'dep' && seg === 1) lastDepYmd = ymd
          const idx = await page.evaluate<number>(seg > 1 ? DATE_INPUT_IDX_SEG(seg) : DATE_INPUT_IDX(which))
          const input = visibleInput(idx)
          await input.click({ timeout: 5000 })
          await sleep(600)
          // 策略①:输入框可写(部分构建支持键入;React 受控件用原生 setter+input 事件)
          const typed = await input.evaluate((el: HTMLInputElement, v: string) => {
            if (el.readOnly) return false
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
            setter?.call(el, v)
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return el.value === v
          }, ymd).catch(() => false)
          if (typed) { await sleep(400); return }
          // 策略②:日历单元格(aria/title 含完整日期优先;否则面板可见目标月时按日号)
          let clicked = await page.evaluate<boolean>(CLICK_DATE_CELL(ymd, which === 'back' ? lastDepYmd : undefined)).catch(() => false)
          if (!clicked) {
            // 目标月不在可视双月(多程跨月,live 实测):点 iconf-right 翻月至可见再消歧
            for (let k = 0; k < 12 && !clicked; k += 1) {
              // 真实鼠标事件点击面板翻月箭头(evaluate 的 .click() 实测被 React 层吞)
              const next = page.locator('[class*=in-date-picker][class*=iconf-right]').first()
              const advanced = await next.click({ timeout: 2000 }).then(() => true).catch(() => false)
              if (!advanced) break
              await sleep(600)
              if (!(await page.evaluate<boolean>(YM_VISIBLE(ymd)).catch(() => false))) continue
              clicked = await page.evaluate<boolean>(CLICK_DATE_CELL(ymd, which === 'back' ? lastDepYmd : undefined)).catch(() => false)
            }
          }
          if (!clicked) {
            await page.screenshot({ path: `/tmp/gotry-gui-date-${which}-${Date.now()}.png` }).catch(() => {})
            // 实证诊断:日号叶子(任意可见性)+ 月标题叶子的真实形状,供下一轮校准
            const facts = String(await page.evaluate<string>(
              `(() => JSON.stringify({
                href: location.href.slice(0, 140),
                days: Array.from(document.querySelectorAll('*'))
                  .filter(e => e.children.length === 0 && /^${String(Number(ymd.slice(8, 10)))}$/.test((e.textContent || '').trim()))
                  .slice(0, 8).map(e => ({ tag: e.tagName, cls: String(e.className).slice(0, 50),
                    vis: e.getClientRects().length > 0, offParent: !!e.offsetParent,
                    pCls: String(e.parentElement && e.parentElement.className).slice(0, 50) })),
                months: Array.from(document.querySelectorAll('*'))
                  .filter(e => e.children.length === 0 && /年\\d{1,2}月$/.test((e.textContent || '').trim()))
                  .slice(0, 6).map(e => ({ t: (e.textContent || '').trim(), vis: e.getClientRects().length > 0 }))
              }))()`,
            ).catch(() => '?'))
            throw new Error(`日期 ${ymd} 未能设置(输入框只读且日历未命中);页面事实:${facts}`)
          }
          await sleep(400)
        },
        async press(key) { await page.keyboard.press(key) },
        async clickSearch() {
          await page.keyboard.press('Escape').catch(() => {})
          await sleep(500)
          // 语义优先(live 实测 2026-10-15 多程:几何/叶子/色块三策在该构建全部 miss,
          // role=button name=搜索 命中蓝色大按钮):短超时,失败回落 evaluate 几何族。
          const byRole = page.getByRole('button', { name: '搜索' }).first()
          const roleOk = await byRole.click({ timeout: 5000 }).then(() => true).catch(() => false)
          if (roleOk) { await sleep(600); return }
          const dumpDir = process.env.GOTRY_GUI_DUMP
          if (dumpDir) {
            const cands = String(await page.evaluate<string>(CLICK_FORM_SEARCH_CANDIDATES).catch(() => '{"err":"eval-fail"}'))
            try { mkdirSync(dumpDir, { recursive: true }); writeFileSync(join(dumpDir, 'search-candidates.json'), cands) } catch { /* best effort */ }
            await page.screenshot({ path: join(dumpDir, 'pre-search.png') }).catch(() => {})
          }
          await page.evaluate<void>(CLICK_FORM_SEARCH)
        },
        async visibleFormText() {
          return String(await page.evaluate<string>(VIS_FORM_TEXT).catch(() => ''))
        },
        async cityFieldValues(seg = 1) {
          return cityValues(seg)
        },
        async waitForHumanLogin(timeoutMs: number) {
          // 红线:窗口导航到携程官方登录页,人自己完成登录;只轮询票据 cookie 的名字(值即弃)。
          await page.goto('https://passport.ctrip.com/user/login?backurl=' + encodeURIComponent('https://flights.ctrip.com/online/channel/domestic'), { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
          const deadline = Date.now() + timeoutMs
          while (Date.now() < deadline) {
            const names = await ctx.cookies().then(cs => cs.map(c => c.name)).catch(() => [] as string[])
            if (names.some(n => LOGIN_COOKIE_NAMES.includes(n))) return true
            await page.waitForTimeout(5_000)
          }
          return false
        },
        async pageText() {
          const title = await page.title().catch(() => '')
          const text = String(await page.evaluate<string>('document.body.innerText.slice(0, 3000)').catch(() => ''))
          return title + text
        },
        async currentUrl() {
          return page.url()
        },
        async waitForApiCapture(timeoutMs) {
          return new Promise(resolve => {
            const timer = setTimeout(() => {
              apiWaiter = null
              resolve(capture.itinerary || capture.calendar ? { ...capture } : null)
            }, timeoutMs)
            apiWaiter = v => { clearTimeout(timer); resolve(v) }
          })
        },
        async recentApiUrls() { return [...recentUrls] },
      }
    },
    async close() {
      await ctx.close().catch(() => {})
      rmSync(profile, { recursive: true, force: true })
    },
  }
}
