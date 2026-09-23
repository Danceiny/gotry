/**
 * 行程 HTML 渲染器(issue #442,父 #438;共享契约层抽取见 issue #564)。
 *
 * 纯有界渲染器:拒绝畸形输入,产出单文件自包含 HTML。本模块不执行 IO、
 * 不启动服务、不解析 Markdown、不做夜数/预算/时间运算——只把显式行程结构
 * 与已注册事实投影成可导航、可展开的安全文档。
 *
 * 输入校验、事实归一化与证据卡渲染的单一事实源在 `itinerary-doc-shared.ts`
 * (两个文档投影共用,防第二实现漂移);本模块只保留单页文档的排版与组装。
 *
 * 两条永不合流的证据面:
 *   1. 计划面(planner:trip_start/trip_end/stays/od_segments)——用户排期意图;
 *   2. 证据面(facts:调用方从注册表选出的 BookableFact)——exact-date 查询结论,
 *      逐条保留 tier/bookability/source/query_id/fetched_at/as_of。
 * 目的地级酒店库存绝不宣称「某家酒店有房/可订」;无任何整体 verified 徽章。
 *
 * 渲染闸锚点纪律:本模块不嵌入 `<!-- fact:<id> -->` 锚点(那属 Markdown 产物闸),
 * 事实 id 只作为可见文本展示,避免整篇 HTML 被当作锚点行解析。
 */

import {
  DOC_BASE_CSS,
  DOC_NARROW_CSS,
  EVIDENCE_BOUNDARY_NOTICE,
  MODE_LABEL,
  TWO_PLANE_STATEMENT,
  buildDateIndex,
  docBytesError,
  escapeHtml,
  factIdSlug,
  hotelFactsForStay,
  leftoverFacts,
  normalizeDocInput,
  renderDateList,
  renderFact,
  renderFactCountsLine,
  renderHotelEvidenceSection,
  renderHotelNote,
  renderLeftoverBlock,
  renderPlannedStay,
  renderPolicyNote,
  renderSegment,
  routeFactsFor,
  timeEl,
  type ItineraryDocResult,
  type NormalizedFact,
  type NormalizedFlight,
  type NormalizedHotel,
  type NormalizedItinerary,
  type NormalizedPolicy,
} from './itinerary-doc-shared.ts'

// API 面稳定性:既有消费方(itinerary-artifact.ts / 测试)继续从本模块导入
export { ITINERARY_DOC_LIMITS as ITINERARY_HTML_LIMITS } from './itinerary-doc-shared.ts'
export type { ItineraryDocInput as ItineraryHtmlInput, ItineraryDocResult as ItineraryHtmlResult } from './itinerary-doc-shared.ts'

// ---------------------------------------------------------------------------
// 单页文档排版(组装共享层的内容原语;CSS 为本形态私有)
// ---------------------------------------------------------------------------

const CSS = DOC_BASE_CSS + `
.wrap{max-width:64rem;margin:0 auto;padding:1rem}
header.doc{border-bottom:1px solid var(--line);padding-bottom:.75rem}
nav.toc{border:1px solid var(--line);border-radius:6px;padding:.6rem .8rem;margin:1rem 0;background:var(--card)}
nav.toc h2{font-size:1rem}
nav.toc ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:.35rem .9rem}
nav.toc ul ul{margin-left:.9rem;font-size:.92rem;display:block}
section{margin:1.75rem 0}
` + DOC_NARROW_CSS + `
@media (max-width:480px){
.wrap{padding:.6rem}
}`

function render(input: { title: string; itinerary: NormalizedItinerary; facts: NormalizedFact[] }): string {
  const { title, itinerary, facts } = input
  const stays = itinerary.stays
  const segs = itinerary.od_segments
  const hotelFacts = facts.filter((f): f is NormalizedHotel => f.kind === 'hotel')
  const policyFacts = facts.filter((f): f is NormalizedPolicy => f.kind === 'policy')
  const flightFacts = facts.filter((f): f is NormalizedFlight => f.kind === 'flight' || f.kind === 'train')

  const stayBlocks = stays.map((stay, i) => renderPlannedStay(stay, `stay-${i + 1}`, hotelFactsForStay(hotelFacts, stay)))
  const segBlocks = segs.map((seg, i) => renderSegment(seg, `seg-${i + 1}`, routeFactsFor(facts, seg), itinerary.trip_start))

  const stayDateItems = stays.filter((s, i) => stays.findIndex(x => x.check_in === s.check_in) === i)
    .map(s => `<li>${timeEl(s.check_in)} — <a href="#stay-${stays.indexOf(s) + 1}">计划住宿 ${escapeHtml(s.place)}</a></li>`)
    .join('')
  const segDateItems = [...new Set(segs.map(s => s.date))].sort()
    .map(d => `<li>${timeEl(d)} — <a href="#segments">交通段</a></li>`)
    .join('')

  const dateList = renderDateList(buildDateIndex(itinerary))
  const leftovers = leftoverFacts(facts, itinerary)
  const leftoverBlock = renderLeftoverBlock(leftovers, itinerary.trip_start)
  const hotelNote = renderHotelNote(hotelFacts)
  const policyNote = renderPolicyNote(policyFacts)

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">跳到主要内容</a>
<div class="wrap">
<header class="doc">
<h1>${escapeHtml(title)}</h1>
<p>行程 ${timeEl(itinerary.trip_start)} → ${timeEl(itinerary.trip_end)}</p>
${TWO_PLANE_STATEMENT}
</header>
<main id="main">
${EVIDENCE_BOUNDARY_NOTICE}
<nav class="toc" aria-label="行程导航">
<h2>导航</h2>
<ul>
<li><a href="#dates">按日期</a><ul>${dateList.startsWith('<p') ? '<li class="muted">无</li>' : ''}</ul></li>
<li><a href="#segments">航班/交通段</a><ul>${segDateItems || '<li class="muted">无</li>'}</ul></li>
<li><a href="#stays">住宿</a><ul>${stayDateItems || '<li class="muted">无</li>'}</ul></li>
<li><a href="#facts">事实与证据</a></li>
</ul>
</nav>
<section id="dates"><h2>按日期行程</h2>
${dateList}
</section>
<section id="segments"><h2>航班/交通段</h2>
<p class="muted">下列条目是计划段(用户排期意图);每段内另列可回溯到该 route + date 的已注册事实。计划段不因存在事实而变成可下单。</p>
${segBlocks.join('') || '<p class="muted missing">没有显式交通段。</p>'}
</section>
<section id="stays"><h2>住宿</h2>
${hotelNote}
${stayBlocks.join('') || '<p class="muted missing">没有显式住宿段。</p>'}
${renderHotelEvidenceSection(hotelFacts, itinerary.trip_start)}
</section>
<section id="facts"><h2>事实与证据</h2>
${renderFactCountsLine(facts)}
${policyFacts.map(f => renderFact(f, `policy-${factIdSlug(f.fact.fact_id)}`, itinerary.trip_start)).join('')}
${policyNote}
${leftoverBlock}
<h3>全部航班/车次事实(含负事实与冲突)</h3>
${flightFacts.map(f => renderFact(f, `flight-${factIdSlug(f.fact.fact_id)}`, itinerary.trip_start)).join('') || '<p class="muted missing">本次输入没有航班/车次事实。</p>'}
</section>
</main>
</div>
</body>
</html>
`
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 纯渲染入口。`input` 是任意运行时数据:结构、枚举、真实日历日期、有限数值、
 * 容量与文档大小全部现场校验;任何一项不合法即返回 `ok:false` + 结构化 errors,
 * 绝不静默丢弃核心行程后仍返回「成功」。校验与归一化的单一事实源在
 * `itinerary-doc-shared.ts`,与 deck 投影共用同一拒绝语义。
 */
export function renderItineraryHtml(input: unknown): ItineraryDocResult {
  const normalized = normalizeDocInput(input)
  if (!normalized.ok) return normalized
  const html = render(normalized)
  // 输出大小硬上限:超限即整体失败(检查实现于共享层)
  const bytesError = docBytesError(html)
  if (bytesError !== undefined) return { ok: false, errors: bytesError }
  return { ok: true, html }
}