/**
 * 证据日期绑定 gotry_evidence_date_binding(rc.33 行程实测 2026-11-01;ADR-19 §8.19)。
 *
 * 根反例(两例都是午夜前后的红眼):✅ 小节「出境(迪拜 → 上海,12/1)」下的 QR1019 ¥5747
 * 来自 11/30 的查询;✅ 小节「回程(深圳 → 迪拜,12/17 00:45)」下的 EK329 ¥2568 来自 12/16
 * 00:45 出发那班。两天都从未查过。内核闸(artifact-gate.ts)的 claim 抽取只认 7.17/07-17,
 * 读不出 12/1,于是行没有日期,同号事实不论哪天都算「可回溯」。
 *
 * 规则:声称证据的航班行——行或祖先标题标 ✅/实证/已核验、带事实锚点,或写明该航班的硬票价
 * (价格只可能来自查询结果)——必须引用同号、同一出发日的可下单事实;票价若只在别的日期出现,
 * 就是从相邻日期借来的。❌/⚠️/未核验/已订(用户自有资源)的行不算声称。
 *
 * 出发日:12/1、12月1日、ISO、7.17、07-17 按位置扫描;到达日(→ 12/2 14:40、12/17 清晨落地)、
 * 元数据日(2026-11-01 查询、[flyai@…]、截至 …、query id 里的日期)、区间(2026-12-01 → 12-16、
 * 12/5–6)不冒充;日期只沿祖先标题与节内纯日期行继承,不从兄弟小节串过来;无年份写法用
 * trip_year,没有时取 today 当天或之后最近的一次。
 *
 * 纯函数、零 I/O,与内核闸并列而不改它(内核清单冻结 artifact-gate.ts,run-all §63);航班
 * claim 的身份(行号/航班号/车次分流/锚点)复用内核 extractClaims,本层只加日期与核验声称。
 * 强制执行面:evidence-date-guard.ts(write/present 前);gotry_fact_gate 报告同样并入。
 */

import { extractClaims, type AirlineAirportMap, type ExtractedFlightClaim } from './artifact-gate.ts'
import { latestFactsForRouteDate, type BookableFact, type FlightFact } from './bookable-facts.ts'
import { isRealIsoDate } from './time-anchor.ts'

export const EVIDENCE_DATE_BINDING_SCHEMA = 'gotry_evidence_date_binding.v1' as const

export interface DateContextOpts {
  /** 无年份写法(12/1、7.17、12月1日、07-17)的年份,优先于 today */
  trip_year?: number
  /** 宿主当地今天 YYYY-MM-DD:无 trip_year 时,无年份写法取今天当天或之后最近的一次 */
  today?: string
}

export type EvidenceMark = 'verified' | 'negated'

export interface EvidenceDateViolation {
  kind: 'evidence_date_mismatch' | 'verified_flight_undated'
  line: number
  detail: string
}

/** 一条航班行在本层的视图(行号/航班号来自内核 extractClaims) */
export interface FlightEvidenceRow {
  line: number
  flight_no: string
  /** 出发日 YYYY-MM-DD;行内与祖先上下文都没有时缺省 */
  date?: string
  /** 出发日取自哪一行:本行 = 行内日期;否则为祖先标题或节内纯日期行 */
  date_line?: number
  /** 行(优先)或祖先标题上的核验声称 */
  mark?: EvidenceMark
  /** 该航班自身窗口内的 CNY 硬票价 */
  fare?: number
  claim: ExtractedFlightClaim
}

/** 航班号形状(与内核闸同一写法):用于窗口边界与调用方的廉价预筛 */
export const FLIGHT_NO_SHAPE = /(?<![A-Za-z0-9])[A-Z0-9]{2}\d{3,4}(?!\d)/

// ---------------------------------------------------------------------------
// 出发日 token
// ---------------------------------------------------------------------------

interface DateToken { start: number; end: number; month: number; day: number; year?: number; form: number }
interface DepartureToken { start: number; end: number; date?: string }

/** 第 0 式自带年份(年/月/日三组),其余为月/日两组;数量单位(4.5 星、10-15 分钟、1.5h)不是日期 */
const DATE_FORMS: readonly RegExp[] = [
  /(?<!\d)(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|号)?(?!\d)/g,
  /(?<![\d./-])(\d{1,2})月(\d{1,2})(?:日|号)(?!\d)/g,
  /(?<![\d./-])(\d{1,2})\/(\d{1,2})(?![\d/])/g,
  /(?<![\dA-Za-z./¥$-])(\d{1,2})\.(\d{1,2})(?![\d.]|[hHmMkK]|\s*(?:小时|分钟|天|晚|公里|倍|%|折|元|万|星|分|岁))/g,
  /(?<![\d./-])(\d{2})-(\d{2})(?![\d-]|\s*(?:小时|分钟|天|晚|公里|km|人|元|岁|%))/g,
]
const DOTTED_FORM = 3
/** 标题开头的「3.1 去程」是小节编号,不是 3 月 1 日(后接星期或括号的「7.17 周六」「7.17(周六)」仍是日期) */
const SECTION_NUMBER_HEAD = /^\s+[^\s周星礼（(]/
const ARROW_TAIL = /(?:→|->|⇀|⟶|➝|➔|⇒)$/
const ARRIVAL_TAIL = /(?:抵达|抵|到达|落地|到港)$/
const ARRIVAL_HEAD = /^[\s*_`]*(?:\d{1,2}:\d{2}\s*)?[一-鿿]{0,2}(?:抵达|抵|到达|落地|到港)/
const META_TAIL = /(?:截至|截止|生成日期|生成于|生成|更新于|更新|查询于|查询日|快照|as[ _]?of|@)$/i
const META_HEAD = /^[\s*_`)）\]】」]*(?:查询|实证|核验|验证|核实|生成|更新|发布|快照|抓取|取数)/
const QUERY_ID_TAIL = /:[^\s:]+:$/
const RANGE_GAP = /^\s*(?:–|—|~|～|至|-)\s*$/
/** 标题里两个日期用箭头相连 = 行程区间(行内则是出发 → 到达,由 ARROW_TAIL 排除后者) */
const HEADING_RANGE_GAP = /^\s*(?:→|->|⇀|⟶|到)\s*$/
const RANGE_BARE_DAY = /^\s*(?:–|—|~|～|至|-)\s*\d{1,2}(?![\d:./月])/

function dateTokensOf(text: string): DateToken[] {
  const found: DateToken[] = []
  DATE_FORMS.forEach((re, form) => {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0
      const token: DateToken = form === 0
        ? { start, end: start + m[0].length, year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), form }
        : { start, end: start + m[0].length, month: Number(m[1]), day: Number(m[2]), form }
      if (isRealIsoDate(token.year ?? 2000, token.month, token.day)) found.push(token)
    }
  })
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const tokens: DateToken[] = []
  for (const t of found) {
    if (tokens.length > 0 && t.start < tokens[tokens.length - 1]!.end) continue
    tokens.push(t)
  }
  return tokens
}

function resolveTokenDate(t: DateToken, opts: DateContextOpts | undefined): string | undefined {
  const md = `${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`
  let year = t.year
  if (year === undefined && opts?.trip_year) year = opts.trip_year
  if (year === undefined) {
    const today = opts?.today?.match(/^(\d{4})-(\d{2}-\d{2})$/)
    if (today) year = md >= today[2]! ? Number(today[1]) : Number(today[1]) + 1
  }
  return year !== undefined && isRealIsoDate(year, t.month, t.day) ? `${year}-${md}` : undefined
}

/** 可作出发日的 token(按位置);年份解析不出时 date 为 undefined */
function departureTokens(text: string, opts: DateContextOpts | undefined, heading: boolean): DepartureToken[] {
  const tokens = dateTokensOf(text)
  const ranged = new Set<number>()
  for (let i = 0; i + 1 < tokens.length; i++) {
    const gap = text.slice(tokens[i]!.end, tokens[i + 1]!.start)
    if (RANGE_GAP.test(gap) || (heading && HEADING_RANGE_GAP.test(gap))) ranged.add(i).add(i + 1)
  }
  const out: DepartureToken[] = []
  tokens.forEach((t, i) => {
    if (ranged.has(i)) return
    const before = text.slice(0, t.start)
    const tail = before.replace(/[\s*_`]+$/, '')
    const after = text.slice(t.end)
    if (ARROW_TAIL.test(tail) || ARRIVAL_TAIL.test(tail) || ARRIVAL_HEAD.test(after)) return
    if (META_TAIL.test(tail) || QUERY_ID_TAIL.test(before) || META_HEAD.test(after) || RANGE_BARE_DAY.test(after)) return
    if (heading && t.form === DOTTED_FORM && /^[\s#]*$/.test(before) && SECTION_NUMBER_HEAD.test(after)) return
    out.push({ start: t.start, end: t.end, date: resolveTokenDate(t, opts) })
  })
  return out
}

/** 文本(标题或行)的出发日:第一个合格 token;无则 undefined */
export function departureDateOf(text: string, opts?: DateContextOpts, heading = false): string | undefined {
  return departureTokens(text, opts, heading)[0]?.date
}

/** 行内某个航班号的出发日 token:它前面最近的一个,否则它后面第一个 */
function departureTokenAt(tokens: DepartureToken[], pos: number): DepartureToken | undefined {
  let chosen: DepartureToken | undefined
  for (const t of tokens) {
    if (t.start >= pos) break
    chosen = t
  }
  return chosen ?? tokens.find(t => t.start > pos)
}

const WEEKDAY_OR_DAY_LABEL = /周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?|\bday\s*\d+|第[一二三四五六七八九十\d]+天/gi
const DATE_LINE_PUNCT = /[\s*_`#>·•\-–—:：()（）[\]【】,，.。、/]/g

/** 纯日期行(「**12/16 周三**」、HTML 日期格「12/1周二」):去掉记号与星期后只剩这一个日期 */
function isDateOnlyLine(line: string, tokens: DepartureToken[]): boolean {
  if (tokens.length !== 1 || /^\s*\|/.test(line)) return false
  const t = tokens[0]!
  return (line.slice(0, t.start) + line.slice(t.end)).replace(WEEKDAY_OR_DAY_LABEL, '').replace(DATE_LINE_PUNCT, '').length === 0
}

// ---------------------------------------------------------------------------
// 核验声称与票价
// ---------------------------------------------------------------------------

/** 「已核验」声称:✅✓✔☑ 或 实证/已验证/已核验/已核实/可直接下单/verified */
const VERIFIED_MARK = /[✅✓✔☑]|实证|已验证|已核验|已核实|可直接下单|\bverified\b/i
/** 否定、降级或用户自有资源:出现即不算声称 exact-date 证据(❌ ⚠️ 未核验 不得 待查 已订……) */
const NOT_EVIDENCE_MARK = /[❌✗✘⚠]|未(?:核验|验证|核实|查得|查到|实证|确认)|不得(?:下单|预订|订|标|写)|不可下单|待(?:核|查|确认)|查不到|已(?:订|购|出票|买|预订)|\bunverified\b/i

function evidenceMarkOf(text: string): EvidenceMark | undefined {
  if (NOT_EVIDENCE_MARK.test(text)) return 'negated'
  return VERIFIED_MARK.test(text) ? 'verified' : undefined
}

const CNY_FARE = /(?:¥|￥|\bCNY)\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?![\dA-Za-z,])/gi

/** 航班号在行内的位置(整 token:EK329 不落在 EK3291 里);找不到为 -1 */
function flightNoIndex(text: string, flightNo: string): number {
  return text.toUpperCase().search(new RegExp(`(?<![A-Za-z0-9])${flightNo.toUpperCase()}(?!\\d)`))
}

/** 该航班自身窗口(到下一个航班号/证据链 [..#..]/事实锚点为止)内第一个 CNY 硬票价;约价/起价不算 */
function fareInWindow(text: string, flightNo: string): number | undefined {
  const start = flightNoIndex(text, flightNo)
  if (start < 0) return undefined
  const from = start + flightNo.length
  const rest = text.slice(from)
  const ends = [rest.search(FLIGHT_NO_SHAPE), rest.search(/\[[^\]\n]*#[^\]\n]*\]/), rest.indexOf('<!-- fact:')].filter(i => i >= 0)
  const window = rest.slice(0, ends.length > 0 ? Math.min(...ends) : rest.length)
  for (const m of window.matchAll(CNY_FARE)) {
    const at = m.index ?? 0
    if (/(?:约|大约|约为|起价|起步|from)\s*$/i.test(window.slice(Math.max(0, at - 8), at))) continue
    if (/^\s*(?:起|起价|起步|左右|上下|以上|\+)/.test(window.slice(at + m[0].length))) continue
    return Number(m[1]!.replaceAll(',', ''))
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 行视图:航班行(内核抽取 + 本层日期/声称/票价)与锚点行
// ---------------------------------------------------------------------------

const HEADING_ATX = /^(#{1,6})\s+(.+)$/

interface LineCtx { tokens: DepartureToken[]; date?: string; date_line?: number; mark?: EvidenceMark }

/** 逐行上下文:出发日与核验声称只沿祖先标题继承;节内纯日期行给其后各行提供日期,直到下一个标题或纯日期行 */
function lineContexts(lines: string[], opts: DateContextOpts | undefined): LineCtx[] {
  const headings: Array<{ level: number; line: number; date?: string; mark?: EvidenceMark }> = []
  let dateLine: { date: string; line: number } | undefined
  return lines.map((line, i) => {
    const heading = line.match(HEADING_ATX)
    if (heading) {
      const level = heading[1]!.length
      while (headings.length > 0 && headings[headings.length - 1]!.level >= level) headings.pop()
      headings.push({ level, line: i + 1, date: departureDateOf(line, opts, true), mark: evidenceMarkOf(heading[2]!) })
      dateLine = undefined
      return { tokens: [] }
    }
    const tokens = departureTokens(line, opts, false)
    if (isDateOnlyLine(line, tokens) && tokens[0]!.date) dateLine = { date: tokens[0]!.date, line: i + 1 }
    const dated = dateLine ?? [...headings].reverse().find(h => h.date)
    const marked = [...headings].reverse().find(h => h.mark)
    return { tokens, date: dated?.date, date_line: dated?.line, mark: evidenceMarkOf(line) ?? marked?.mark }
  })
}

interface Analysis { lines: string[]; ctx: LineCtx[]; claims: ReturnType<typeof extractClaims> }

function analyze(markdown: string, map: AirlineAirportMap, opts: DateContextOpts | undefined): Analysis {
  const lines = markdown.split('\n')
  return { lines, ctx: lineContexts(lines, opts), claims: extractClaims(markdown, map, { trip_year: opts?.trip_year }) }
}

/** 全部航班行(承运级直飞断言与车次除外)的出发日/核验声称/票价视图 */
export function flightEvidenceRows(markdown: string, map: AirlineAirportMap, opts?: DateContextOpts): FlightEvidenceRow[] {
  return rowsOf(analyze(markdown, map, opts))
}

function rowsOf({ lines, ctx, claims }: Analysis): FlightEvidenceRow[] {
  return claims.flights
    .filter(c => !c.carrier_only && c.flight_no !== '')
    .map(c => {
      const text = lines[c.line - 1] ?? ''
      const here = ctx[c.line - 1] ?? { tokens: [] }
      const at = departureTokenAt(here.tokens, flightNoIndex(text, c.flight_no))
      return {
        line: c.line,
        flight_no: c.flight_no,
        date: at?.date ?? here.date,
        date_line: at?.date ? c.line : here.date_line,
        mark: here.mark,
        fare: fareInWindow(text, c.flight_no),
        claim: c,
      }
    })
}

// ---------------------------------------------------------------------------
// 绑定判定
// ---------------------------------------------------------------------------

function factDay(f: FlightFact): string {
  return `${f.date}${f.dep_local ? ` ${f.dep_local}` : ''}(${f.price !== undefined ? `¥${f.price}` : '价待询'},${f.query_id})`
}

function factDays(facts: FlightFact[]): string {
  const sorted = [...facts].sort((a, b) => a.date.localeCompare(b.date) || a.fetched_at.localeCompare(b.fetched_at))
  const shown = sorted.slice(0, 4).map(factDay).join('、')
  return sorted.length > 4 ? `${shown} 等 ${sorted.length} 条` : shown
}

/** 该航班(按其事实里的航线;无事实时用行内航线)在行日期上的查询状态 */
function routeDateStatus(facts: BookableFact[], sameNo: FlightFact[], c: ExtractedFlightClaim, no: string, date: string): string {
  const routes = sameNo.length > 0
    ? [...new Map(sameNo.map(f => [`${f.route.origin}→${f.route.destination}`, f.route])).values()]
    : c.origin && c.destination ? [{ origin: c.origin, destination: c.destination }] : []
  return routes.map(r => {
    const scoped = latestFactsForRouteDate(facts, r.origin, r.destination, date, 'flight')
    if (scoped.length === 0) return `${r.origin}→${r.destination} ${date} 从未经 exact-date 查询`
    if (scoped.every(f => f.bookability !== 'bookable_exact_date')) return `${r.origin}→${r.destination} ${date} exact-date 返回 0 条`
    return `${r.origin}→${r.destination} ${date} 的 exact-date 结果里没有 ${no}`
  }).join(';')
}

function dateSource(lineNo: number, dateLine: number | undefined): string {
  return dateLine === undefined || dateLine === lineNo ? '行内' : `取自 L${dateLine}`
}

/**
 * 证据日期绑定:返回 evidence_date_mismatch / verified_flight_undated 违例(按行号排序)。
 * 未声称证据的行(无 ✅/实证、无锚点、无票价)与 ❌/⚠️/已订行不判;其余断言归内核 gateArtifact。
 */
export function checkEvidenceDateBinding(markdown: string, facts: BookableFact[], map: AirlineAirportMap, opts?: DateContextOpts): EvidenceDateViolation[] {
  const bookable = facts.filter((f): f is FlightFact => f.kind === 'flight' && f.bookability === 'bookable_exact_date' && f.flight_no !== '')
  const analysis = analyze(markdown, map, opts)
  const violations: EvidenceDateViolation[] = []
  for (const row of rowsOf(analysis)) {
    if (row.mark === 'negated' || (row.mark !== 'verified' && row.fare === undefined)) continue
    const no = row.flight_no.toUpperCase()
    const how = row.mark === 'verified' ? '标 ✅/实证' : `写明票价 ¥${row.fare}`
    const sameNo = bookable.filter(f => f.flight_no.toUpperCase() === no)
    if (!row.date) {
      // 只写票价、无日期的叙述行有歧义但不构成错绑;标了 ✅ 却无日期 = 无法绑定 → fail closed
      if (row.mark !== 'verified') continue
      violations.push({
        kind: 'verified_flight_undated',
        line: row.line,
        detail: `${no} ${how},但行内与所属标题都没有可解析的出发日期——${sameNo.length > 0 ? `注册表里 ${no} 的事实出发日是 ${factDays(sameNo)}` : `注册表里没有 ${no} 的可下单事实`};写明出发日期,或去掉 ✅/实证 标「未核验」`,
      })
      continue
    }
    const sameDay = sameNo.filter(f => f.date === row.date)
    const src = dateSource(row.line, row.date_line)
    if (sameDay.length === 0) {
      const status = routeDateStatus(facts, sameNo, row.claim, no, row.date)
      violations.push({
        kind: 'evidence_date_mismatch',
        line: row.line,
        detail: `${no} ${how},行日期 ${row.date}(${src}),但${sameNo.length > 0 ? `注册表里 ${no} 的可下单事实出发日是 ${factDays(sameNo)}` : `注册表里没有 ${no} 的任何可下单事实`}${status ? `;${status}` : ''}——别的日期查到的结果不得写到 ${row.date}`,
      })
      continue
    }
    if (row.fare !== undefined && !sameDay.some(f => f.price === row.fare)) {
      const donors = sameNo.filter(f => f.date !== row.date && f.price === row.fare)
      if (donors.length > 0) {
        violations.push({
          kind: 'evidence_date_mismatch',
          line: row.line,
          detail: `${no} 行日期 ${row.date}(${src})的同日事实是 ${factDays(sameDay)},行内 ¥${row.fare} 却是 ${[...new Set(donors.map(f => f.date))].join('/')} 那班的票价——票价与日期必须出自同一条事实`,
        })
      }
    }
  }
  // 事实锚点行:锚点引用的事实出发日必须等于该行日期(保留锚点改可见日期 = 伪绑定)
  for (const [lineNo, factId] of analysis.claims.anchors) {
    const here = analysis.ctx[lineNo - 1]
    if (!here || here.mark === 'negated') continue
    const f = facts.find(x => x.fact_id === factId)
    if (!f || f.kind !== 'flight' || !f.flight_no) continue
    const own = here.tokens[0]?.date
    const date = own ?? here.date
    if (!date) {
      violations.push({ kind: 'verified_flight_undated', line: lineNo, detail: `${f.flight_no} 引用事实锚点 fact:${f.fact_id}(出发日 ${factDay(f)}),但该行与所属标题都没有可见的出发日期——写明 ${f.date}` })
    } else if (date !== f.date) {
      violations.push({ kind: 'evidence_date_mismatch', line: lineNo, detail: `${f.flight_no} 引用事实锚点 fact:${f.fact_id}(出发日 ${factDay(f)}),但该行日期是 ${date}(${dateSource(lineNo, own ? lineNo : here.date_line)})——锚点事实与行日期必须一致` })
    }
  }
  return violations.sort((a, b) => a.line - b.line)
}

// ---------------------------------------------------------------------------
// HTML 产物投影
// ---------------------------------------------------------------------------

/**
 * HTML 产物 → 闸的行文本投影:h1–h6 → ATX 标题行,单元格 → 「 | 」,块级边界 → 换行,
 * 其余标签剥除、实体解码;head/script/style 整段丢弃,事实锚点注释原样保留。
 */
export function htmlToGateText(html: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rarr: '→', larr: '←', harr: '↔', mdash: '—', ndash: '–', yen: '¥', middot: '·' }
  const anchors: string[] = []
  return html
    .replace(/<!--\s*fact:([0-9a-f]{16})\s*-->/gi, (_m, id: string) => `\u0000${anchors.push(id) - 1}\u0000`)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, n: string, inner: string) => `\n${'#'.repeat(Number(n))} ${inner.replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim()}\n`)
    .replace(/<\/t[dh]\s*>/gi, ' | ')
    .replace(/<br\s*\/?>|<\/(?:p|li|tr|div|ul|ol|table|section|article|details|summary|dt|dd|blockquote|pre|header|footer|nav|main)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== '#') return named[e.toLowerCase()] ?? m
      const cp = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    })
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<!-- fact:${anchors[Number(i)]} -->`)
}
