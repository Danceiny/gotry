/**
 * 行程 deck 渲染器(issue #564;研究决策见 docs/research/karpo-deck-web-research.md 决策 #1)。
 *
 * 纯有界渲染器,契约与 itinerary-html 完全同形:拒绝畸形输入,产出单文件
 * 自包含 HTML;无 IO、无时钟、无子进程、无 Markdown 回解析、无夜数/预算/
 * 时间运算;输入校验与证据卡渲染共用 `itinerary-doc-shared.ts` 的单一事实源。
 *
 * 与单页文档的差异只在排版:页面**确定性派生**(封面/按日期/每交通段/每住宿/
 * 住宿证据/政策/证据附录/航班事实),不接受调用方自由编排——deck spec 是
 * 归一化输入到页结构的固定投影,不是第二个可编排面。
 *
 * 翻页是纯 CSS scroll-snap(研究文档决策点 D-2:保持 inert 契约,不开脚本
 * 例外);页码用 CSS counter 渲染,产物无 `<script>`、无远程资源。
 *
 * 两条永不合流的证据面、目的地级库存降级陈述、无整体 verified 徽章——
 * 语义与单页文档逐字一致(同一共享层,不存在第二份文案)。
 */

import {
  DOC_BASE_CSS,
  DOC_NARROW_CSS,
  EVIDENCE_BOUNDARY_NOTICE,
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

export type ItineraryDeckResult = ItineraryDocResult

// ---------------------------------------------------------------------------
// deck 排版(内容组件复用共享层样式;slide 布局为本形态私有)
// ---------------------------------------------------------------------------

const DECK_CSS = DOC_BASE_CSS + `
html{scroll-snap-type:y proximity}
main.deck{max-width:64rem;margin:0 auto;padding:0 1rem;counter-reset:slide}
.slide{min-height:100vh;min-height:100svh;scroll-snap-align:start;padding:1rem 0 2.5rem;counter-increment:slide}
.slide.cover{display:flex;flex-direction:column;justify-content:center;gap:.4rem}
.slide h1{font-size:2rem;margin:0 0 .5rem}
.slide-tag{color:var(--muted);font-size:.8rem;margin:0 0 1rem}
.slide-tag::before{content:"第 " counter(slide) " 页"}
nav.deck-nav{position:sticky;top:0;z-index:9;background:var(--bg);border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:.35rem .9rem;padding:.45rem 1rem;max-width:64rem;margin:0 auto}
nav.deck-nav a{font-size:.85rem;text-decoration:none;white-space:nowrap}
` + DOC_NARROW_CSS + `
@media (max-width:480px){
main.deck{padding:0 .6rem}
nav.deck-nav{padding:.4rem .6rem}
}
@media print{
.slide{page-break-after:always;min-height:auto}
nav.deck-nav{position:static}
}`

function slideTag(): string {
  return '<p class="slide-tag" aria-hidden="true"></p>'
}

function renderDeck(input: { title: string; itinerary: NormalizedItinerary; facts: NormalizedFact[] }): string {
  const { title, itinerary, facts } = input
  const segs = itinerary.od_segments
  const stays = itinerary.stays
  const hotelFacts = facts.filter((f): f is NormalizedHotel => f.kind === 'hotel')
  const policyFacts = facts.filter((f): f is NormalizedPolicy => f.kind === 'policy')
  const flightFacts = facts.filter((f): f is NormalizedFlight => f.kind === 'flight' || f.kind === 'train')
  const leftovers = leftoverFacts(facts, itinerary)

  // 页结构确定性派生:封面 → 按日期 → 每交通段 → 每住宿 → 住宿证据 → 政策(仅有事实时)→ 证据附录 → 航班/车次事实
  const coverSlide = `<section class="slide cover" id="slide-cover">${slideTag()}`
    + `<h1>${escapeHtml(title)}</h1>`
    + `<p>行程 ${timeEl(itinerary.trip_start)} → ${timeEl(itinerary.trip_end)}</p>`
    + TWO_PLANE_STATEMENT
    + EVIDENCE_BOUNDARY_NOTICE
    + renderFactCountsLine(facts)
    + `</section>`

  const overviewSlide = `<section class="slide" id="slide-overview">${slideTag()}<h2>按日期行程</h2>`
    + renderDateList(buildDateIndex(itinerary))
    + `</section>`

  const segSlides = segs.map((seg, i) =>
    `<section class="slide" id="slide-seg-${i + 1}">${slideTag()}<h2>交通段 ${i + 1}/${segs.length}</h2>`
    + renderSegment(seg, `seg-${i + 1}`, routeFactsFor(facts, seg), itinerary.trip_start)
    + `</section>`,
  ).join('')

  const staySlides = stays.map((stay, i) =>
    `<section class="slide" id="slide-stay-${i + 1}">${slideTag()}<h2>住宿 ${i + 1}/${stays.length}</h2>`
    + renderPlannedStay(stay, `stay-${i + 1}`, hotelFactsForStay(hotelFacts, stay))
    + `</section>`,
  ).join('')

  const hotelEvidenceSlide = `<section class="slide" id="slide-hotel-evidence">${slideTag()}<h2>住宿证据</h2>`
    + renderHotelNote(hotelFacts)
    + renderHotelEvidenceSection(hotelFacts, itinerary.trip_start)
    + `</section>`

  const policySlide = policyFacts.length === 0 ? '' :
    `<section class="slide" id="slide-policy">${slideTag()}<h2>政策事实</h2>`
    + policyFacts.map(f => renderFact(f, `policy-${factIdSlug(f.fact.fact_id)}`, itinerary.trip_start)).join('')
    + renderPolicyNote(policyFacts)
    + `</section>`

  const leftoversSlide = `<section class="slide" id="slide-leftovers">${slideTag()}<h2>证据附录</h2>`
    + renderLeftoverBlock(leftovers, itinerary.trip_start)
    + `</section>`

  const flightsSlide = `<section class="slide" id="slide-flights">${slideTag()}<h2>全部航班/车次事实(含负事实与冲突)</h2>`
    + (flightFacts.map(f => renderFact(f, `flight-${factIdSlug(f.fact.fact_id)}`, itinerary.trip_start)).join('') || '<p class="muted missing">本次输入没有航班/车次事实。</p>')
    + `</section>`

  // 零脚本导航:组级锚点(逐段/逐住宿导航由「按日期」页承担)
  const navLinks = [
    `<a href="#slide-cover">封面</a>`,
    `<a href="#slide-overview">按日期</a>`,
    ...(segs.length > 0 ? [`<a href="#slide-seg-1">交通段</a>`] : []),
    ...(stays.length > 0 ? [`<a href="#slide-stay-1">住宿</a>`] : []),
    `<a href="#slide-hotel-evidence">住宿证据</a>`,
    ...(policyFacts.length > 0 ? [`<a href="#slide-policy">政策</a>`] : []),
    `<a href="#slide-leftovers">证据附录</a>`,
    `<a href="#slide-flights">航班/车次事实</a>`,
  ].join('')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${DECK_CSS}</style>
</head>
<body>
<a class="skip" href="#slide-cover">跳到封面</a>
<nav class="deck-nav" aria-label="deck 导航">${navLinks}</nav>
<main class="deck">
${coverSlide}
${overviewSlide}
${segSlides}
${staySlides}
${hotelEvidenceSlide}
${policySlide}
${leftoversSlide}
${flightsSlide}
</main>
</body>
</html>
`
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 纯渲染入口。`input` 是任意运行时数据,校验/归一化/拒绝语义与
 * `renderItineraryHtml` 完全一致(同一 `normalizeDocInput`,同一字节上限);
 * 任何一项不合法即返回 `ok:false` + 结构化 errors,绝不静默丢弃核心行程。
 */
export function renderItineraryDeck(input: unknown): ItineraryDeckResult {
  const normalized = normalizeDocInput(input)
  if (!normalized.ok) return normalized
  const html = renderDeck(normalized)
  // 输出大小硬上限:超限即整体失败(检查实现于共享层)
  const bytesError = docBytesError(html)
  if (bytesError !== undefined) return { ok: false, errors: bytesError }
  return { ok: true, html }
}