/**
 * 冒烟:不启动完整 dsh 运行时,验证插件注册 + execute + 桥接 + Python 引擎全链路。
 * 运行(在 ts/ 下):npx tsx scripts/smoke.ts
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import type { FlightFact } from '../src/bookable-facts.ts'
import { installModelOverride, type AgentRequestConfig } from '../capabilities/model-override.ts'
import { offlineSessionFlightResult, sessionLiveEnabled } from '../capabilities/session-search.ts'

interface ToolLike {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
  presentResult?: (args: Record<string, unknown>, result: unknown) => { card?: string; title?: string; content?: Array<{ type: string; text?: string }> } | undefined
}

async function main() {
  // 巡检状态纪律:smoke 的探针数据(wish/profile/sidecar)写进独立临时 stateRoot,
  // 不与真实用户状态(gotry-state)混居;结束即删
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const smokeRoot = mkdtempSync(join(tmpdir(), 'gotry-smoke-'))
  const registered: ToolLike[] = []
  const variables: Record<string, () => string> = {}
  // pre-execute 监听器捕获:账号会话授权闸(RFC 支柱④进代码)在 apply() 里经 ctx.on 挂注册表
  type PreDecision = { kind: 'allow' | 'deny' | 'ask'; reason?: string }
  const preExecutes: Array<(exec: { name?: string }, next: () => Promise<PreDecision>) => Promise<PreDecision>> = []
  const ctx = {
    tools: { register: (t: unknown) => registered.push(t as ToolLike) },
    systemPrompt: { variable: (name: string, provider: () => string) => { variables[name] = provider } },
    on: (event: string, fn: (exec: { name?: string }, next: () => Promise<PreDecision>) => Promise<PreDecision>) => {
      if (event === 'tools/pre-execute') preExecutes.push(fn)
      return () => {}
    },
  } as unknown as Context

  // 配置对象持引用:授权闸总闸(sessionAccess)在 §13 里运行时切闸验证
  const cfg = {
    stateRoot: smokeRoot,
    timeoutMs: 30_000,
    hbcliBin: 'hbcli-not-on-path',  // 强制走降级路径的确定性验证
    sessionAccess: 'ask',
  }
  apply(ctx, cfg)

  console.log(`registered tools: ${registered.map(t => t.name).join(', ')}`)

  const byName = (n: string) => {
    const t = registered.find(t => t.name === n)
    if (!t) throw new Error(`tool ${n} not registered`)
    return t
  }

  // 1) 动机画像:evidence 缺失必须被拒绝(P0 反幻觉红线)
  const motivation = byName('gotry_motivation_save')
  const rejectedMotivation = await motivation.execute(
    { profile: { weights: { escape_rest: 0.7 } } },
    null,
  ) as { ok?: boolean; summary?: string }
  if (rejectedMotivation.ok !== false || !rejectedMotivation.summary?.includes('without evidence')) {
    throw new Error(`FAIL: profile without evidence should have been rejected, actual ${JSON.stringify(rejectedMotivation).slice(0, 120)}`)
  }
  console.log(`motivation without evidence rejected: ${rejectedMotivation.summary.slice(0, 80)}...`)
  const saved = await motivation.execute({
    profile: {
      weights: { escape_rest: 0.7, curiosity: 0.3 },
      evidence: ['用户原话:想去湖边什么都不干(洱海照片)'],
      hard: { wake_not_before: '06:30', min_arrival_energy_pct: 40 },
    },
  }, null)
  console.log(`motivation saved -> ${JSON.stringify(saved).slice(0, 80)}...`)

  // 2) 可行性引擎:洱海金标准用例,经桥接跑 Python Z3
  const payload = JSON.parse(await readFile(join('..', 'data', 'golden_erhai.json'), 'utf-8'))
  const feasibility = byName('gotry_feasibility_check')
  const result = await feasibility.execute({ payload }, null) as {
    ok?: boolean
    recommended: string | null
    answer_md: string
    latency_ms: number
    via: string
  }
  console.log(`\nfeasibility: recommended=${result.recommended}, via=${result.via}, latency=${result.latency_ms}ms\n`)
  console.log(result.answer_md)

  // 3) wish pool:把不可行的憧憬连同成行条件放入「下一次出发」
  const wish = byName('gotry_wish_pool_add')
  const added = await wish.execute({
    entry: {
      name: '大理·洱海',
      reason: '2 天窗口装不下(冲突:duration)',
      conditions: { days: 5, budget_cny: 4950, best_months: [3, 4, 5, 9, 10, 11] },
    },
  }, null)
  console.log(`\nwish pool -> ${JSON.stringify(added)}`)

  if (result.recommended !== 'qiandao') throw new Error('FAIL: expected qiandao recommended')

  // 4) D-4 结果卡:presentResult 把逐候选判定 + 全成本 vs 预算渲染成紧凑行(非裸 JSON)
  if (typeof feasibility.presentResult !== 'function') throw new Error('FAIL: feasibility 缺 presentResult')
  const view = feasibility.presentResult({ payload }, result)
  if (!view?.title?.includes('qiandao')) throw new Error(`FAIL: 结果卡标题缺推荐,实际 ${view?.title}`)
  const body = view?.content?.[0]?.text ?? ''
  if (!body.includes('✅') || !body.includes('¥')) throw new Error('FAIL: 结果卡缺判定行/成本行')
  console.log(`\nresult card: ${view?.title}\n${body.split('\n').slice(0, 5).join('\n')}`)

  // 5) D-4 结果卡面:高流量 5 工具均带 presentResult;agent_reach 纯函数实拍
  for (const n of ['gotry_feasibility_check', 'gotry_hotel_search', 'gotry_weather_check', 'gotry_anything_search', 'gotry_agent_reach']) {
    if (typeof byName(n).presentResult !== 'function') throw new Error(`FAIL: ${n} 缺 presentResult`)
  }
  const ar = byName('gotry_agent_reach')
  const arView = ar.presentResult!({ query: { action: 'reach', channel: 'v2ex', method: 'get_hot_topics' } }, { verdict: 'found', summary: '10 topics' })
  if (!arView?.title?.includes('✅') || !arView.title.includes('v2ex.get_hot_topics')) throw new Error(`FAIL: agent_reach 结果卡,实际 ${arView?.title}`)
  console.log(`result cards on 5 tools; agent_reach card: ${arView.title}`)

  // 6) #12/#13 参数形态兼容:字符串 query 与裸对象都能落到 url(不再「url 必填」)
  const ws = byName('gotry_web_search')
  const r1 = await ws.execute({ query: 'not-a-url' } as never, null) as { summary?: string }
  const r2 = await ws.execute({ url: 'not-a-url' } as never, null) as { summary?: string }
  for (const [name, r] of [['string', r1], ['bare-obj', r2]] as const) {
    if (r.summary === 'url 必填') throw new Error(`FAIL: ${name} 形态未被 unwrapQuery 接住`)
  }
  console.log('unwrapQuery: string + bare-object shapes both accepted')

  // 7) 骨架输出 schema 放宽回归:execute 正常返回三字段;guard 错误兜底(ok/summary)
  // 不再被 strict schema 拒(dsh 参数层拒错→guard 兜底→旧 strict schema 校验炸,
  // 真实错误信息被掩盖——patrol 实测抓到)
  const skTool = byName('gotry_skeleton_check')
  const skFlat = await skTool.execute({ from: 'HKG', to: 'BKK' } as never, null) as { connected?: boolean; evidence?: string }
  if (skFlat.connected !== true) throw new Error(`FAIL: 骨架平铺调用应 connected=true,实际 ${JSON.stringify(skFlat).slice(0, 120)}`)
  const skBad = await skTool.execute({ from: '', to: '' } as never, null) as { ok?: boolean; summary?: string }
  if (typeof skBad?.summary === 'string' && (skBad as { connected?: boolean }).connected === undefined) {
    // guard 兜底路径:宽松 schema 下字段可存在即可,不抛
    console.log('skeleton guard-fallback shape survives (loose schema)')
  }
  console.log(`skeleton flat-args: connected=${skFlat.connected}`)

  // 8) D-10 切片 B:hotel 日期槽位接线——逐字表达代码层换算;unresolved 不猜(降级+note)
  {
    const hotel = byName('gotry_hotel_search')
    const resolved = await hotel.execute({ query: { destination: '大理', checkIn: '2026-9-4', checkOut: '2026-09-06' } } as never, null) as { date_notes?: string[] }
    if (!resolved.date_notes?.some(n => n.includes('2026-9-4 → 2026-09-04'))) {
      throw new Error(`FAIL: 非规整 ISO 应产生 slot-resolved note,实际 ${JSON.stringify(resolved.date_notes)}`)
    }
    const unresolved = await hotel.execute({ query: { destination: '大理', checkIn: '近期' } } as never, null) as { date_notes?: string[] }
    if (!unresolved.date_notes?.some(n => n.includes('日期未解析:近期'))) {
      throw new Error(`FAIL: 词表外表达应产生「日期未解析」note(不猜),实际 ${JSON.stringify(unresolved.date_notes)}`)
    }
    console.log('hotel date slots: verbatim resolved in code layer; unresolved degrades with explicit note')
  }

  // 9) RFC S1 observation envelope:成功路径平铺 ok:true;guard 兜底即失败分支同形
  {
    const wish = byName('gotry_wish_pool_add')
    const w = await wish.execute({ entry: { name: 'envelope-probe', conditions: { days: 3 } } } as never, null) as { ok?: boolean }
    if (w.ok !== true) throw new Error(`FAIL: wish 添加应 ok:true,实际 ${JSON.stringify(w)}`)
    if (result.ok !== true) throw new Error(`FAIL: feasibility 应 ok:true,实际 ${String(result.ok)}`)
    console.log('observation envelope: success payloads carry flat ok:true (guard fallback = failure branch)')
  }

  // 10) RFC S2+S3:wish pool sidecar——0..1 召回/muted 不召回/无命中不硬推/owner 确认归因
  {
    const add = byName('gotry_wish_pool_add')
    const list = byName('gotry_wish_pool_list')
    const a = await add.execute({ entry: { name: 'sidecar-probe-洱海', reason: '5 天起', conditions: { days: 5, budget_cny: 4950, best_months: [3, 4, 5] } } } as never, null) as { ok?: boolean; wish_id?: string }
    if (!a.wish_id) throw new Error('FAIL: wish add 应返回稳定 wish_id')
    const recall = await list.execute({ query: { action: 'recall', days: 6, budgetCny: 6000, month: 4 } } as never, null) as { suggestion?: { wish_id?: string; match_score?: number } | null; summary?: string }
    if (!recall.suggestion?.wish_id) throw new Error(`FAIL: 条件命中应召回恰好 1 条(0..1),实际 ${JSON.stringify(recall.suggestion)}`)
    if ((recall.suggestion.match_score ?? 0) < 3) throw new Error(`FAIL: 召回应按条件匹配评分,实际 ${JSON.stringify(recall.suggestion)}`)
    const confirm = await list.execute({ query: { action: 'confirm-outcome', wishId: a.wish_id, attribution: 'helpful', detail: '用户明说:这条建议成了' } } as never, null) as { ok?: boolean; status?: string }
    if (!confirm.ok || confirm.status !== 'helpful') throw new Error(`FAIL: owner 确认归因应落盘,实际 ${JSON.stringify(confirm)}`)
    const noAttr = await list.execute({ query: { action: 'confirm-outcome', wishId: a.wish_id } } as never, null) as { ok?: boolean }
    if (noAttr.ok !== false) throw new Error('FAIL: 无归因的 confirm 应拒绝(归因不许缺省)')
    // muted:置休眠后 0..1 召回不再出现(同名更新 muted:true)
    await add.execute({ entry: { name: 'sidecar-probe-洱海', conditions: { days: 5, budget_cny: 4950, best_months: [3, 4, 5] }, muted: true } } as never, null)
    const recall2 = await list.execute({ query: { action: 'recall', days: 6, budgetCny: 6000, month: 4 } } as never, null) as { suggestion?: { wish_id?: string } | null }
    if (recall2.suggestion?.wish_id === a.wish_id) throw new Error('FAIL: muted wish 不得召回')
    console.log('wish sidecar: recall 0..1 + muted excluded + owner-confirmed attribution only')
  }

  // 11) M4 T1 读回:记忆 brief——save 前空态/回访态含画像字段(与用户当轮冲突以用户为准)
  {
    const brief = variables['motivation_brief']
    if (typeof brief !== 'function') throw new Error('FAIL: motivation_brief 变量未注册')
    const saved = await byName('gotry_motivation_save').execute({
      profile: { weights: { brief_probe: 0.6 }, evidence: ['用户原话:smoke 读回探针'], hard: { wake_not_before: '07:15' } },
    }, null) as { ok?: boolean }
    if (saved.ok !== true) throw new Error('FAIL: 读回探针画像应保存成功')
    const rendered = brief()
    if (!rendered.includes('brief_probe=') || !rendered.includes('wake_not_before=07:15') || !/证据 [1-9]\d* 条/.test(rendered)) {
      throw new Error(`FAIL: 回访 brief 应含画像字段,实际:${rendered.slice(0, 200)}`)
    }
    console.log('memory read-back: motivation_brief renders profile for returning sessions (empty = first visit)')
  }

  // 12) 会话数据面工具(P3 切片1):官方通道 live + 会话工具 needs-login 合同(隔离 profile,零导航)
  {
    const fa = await byName('gotry_flyai_search').execute({ query: { kind: 'flight', from: '上海', to: '丽江', date: '2026-10-01' } }, null) as { ok?: boolean; verdict?: string; via?: string; options?: unknown[]; evidence?: string; error?: string }
    const faBlocked = fa.verdict === 'error' && /sentinel|block|trial limit/i.test(fa.error ?? '')
    // 端点不可达/超时(出口 IP 被拒或网络抖动)→ 工具以带证据链的 error 终态优雅降级,同样合法
    const faErrTerminal = fa.ok === false && fa.verdict === 'error' && /^flyai-error$/.test(String(fa.via ?? '')) && /\[实时API:flyai@error@/.test(String(fa.evidence ?? ''))
    if (faBlocked) {
      console.log('  WARN - flyai 上游限流中(Sentinel/trial-limit 429),降级合同通过(hit 断言跳过)')
    } else if (faErrTerminal) {
      console.log('  WARN - flyai 端点不可达(超时/降级),证据链合同通过(hit 断言跳过)')
    } else if (fa.ok !== true || fa.verdict !== 'hit' || (fa.options?.length ?? 0) < 1 || !/\[实时API:flyai@/.test(fa.evidence ?? '')) {
      throw new Error(`FAIL: flyai 工具应 live hit,实际:${JSON.stringify(fa).slice(0, 200)}`)
    }
    // smoke 不得 attach 或读取用户日常 Chrome；显式选择 cdp 诊断车道并把发现目录
    // 指向隔离空目录，确定性验证 needs-attach/no-spend 合同。真实 attach 只走 #21 人在场验收。
    const prof = mkdtempSync(join(smokeRoot, 'sess-'))
    // 过去日期预校验(issue #24):代码层直接拒绝并指明修正方向,不发上游查询、不产生误导性 miss
    const faPast = await byName('gotry_flyai_search').execute({ query: { kind: 'flight', from: '深圳', to: '普吉', date: '2026-01-01' } }, null) as { ok?: boolean; summary?: string }
    if (!(faPast.ok === false && /已是过去/.test(String(faPast.summary ?? '')))) {
      throw new Error(`FAIL: flyai 过去日期应代码层预校验拒绝,实际:${JSON.stringify(faPast).slice(0, 200)}`)
    }
    let ss: { ok?: boolean; verdict?: string; via?: string; evidence?: string }
    if (!sessionLiveEnabled()) {
      ss = offlineSessionFlightResult()
      console.log('  OFFLINE - GOTRY_SESSION_LIVE!=1: session transport was not invoked')
    } else {
      const previousChromeUserDataDir = process.env.CHROME_USER_DATA_DIR
      process.env.CHROME_USER_DATA_DIR = prof
      try {
        ss = await byName('gotry_session_search').execute({ query: { from: '上海', to: '丽江', date: '2026-10-01' } }, null) as typeof ss
      } finally {
        if (previousChromeUserDataDir === undefined) delete process.env.CHROME_USER_DATA_DIR
        else process.env.CHROME_USER_DATA_DIR = previousChromeUserDataDir
      }
    }
    rmSync(prof, { recursive: true, force: true })
    // puppeteer-core 可用时应为 needs-attach；缺依赖环境仍以带证据链 error 优雅降级。
    const ssErrTerminal = ss.ok === false && /^session-[a-z0-9-]+-error$/.test(String(ss.via ?? '')) && !!ss.evidence
    if (!(ss.verdict === 'needs-login' || ss.verdict === 'needs-attach' || ss.verdict === 'hit' || ss.verdict === 'cooldown' || ss.verdict === 'challenged') && !ssErrTerminal) {
      throw new Error(`FAIL: session 工具终态应属 {needs-attach,needs-login,hit,cooldown,challenged} 或带证据的 error 终态,实际:${JSON.stringify(ss).slice(0, 200)}`)
    }
    const faOutcome = faBlocked
      ? 'sentinel-限流降级'
      : faErrTerminal
        ? '端点不可达降级'
        : `live hit(${fa.options?.length ?? 0} 条)`
    console.log(`session-face tools: flyai ${faOutcome}; session cdp 隔离门禁=needs-attach`)
    // 酒店平铺接入(2026-08-29):同一 flyai 工具 kind=hotel——live 双合法终态(限流/端点降级 or hit)
    const fh = await byName('gotry_flyai_search').execute({ query: { kind: 'hotel', to: '大理', checkIn: '2026-10-01', checkOut: '2026-10-03' } }, null) as { ok?: boolean; verdict?: string; via?: string; hotels?: unknown[]; evidence?: string; error?: string }
    const fhBlocked = fh.verdict === 'error' && /sentinel|block|trial limit/i.test(fh.error ?? '')
    const fhErrTerminal = fh.ok === false && fh.verdict === 'error' && /^flyai-error$/.test(String(fh.via ?? '')) && /\[实时API:flyai@error@/.test(String(fh.evidence ?? ''))
    if (fhBlocked || fhErrTerminal) {
      console.log('  WARN - flyai hotel 限流/端点降级,证据链合同通过(hit 断言跳过)')
    } else if (fh.ok !== true || fh.verdict !== 'hit' || (fh.hotels?.length ?? 0) < 1 || !/\[实时API:flyai@/.test(fh.evidence ?? '')) {
      throw new Error(`FAIL: flyai hotel 应 live hit,实际:${JSON.stringify(fh).slice(0, 220)}`)
    }
    const fhDest = await byName('gotry_flyai_search').execute({ query: { kind: 'hotel' } }, null) as { ok?: boolean }
    if (fhDest.ok !== false) throw new Error('FAIL: hotel 缺目的地应参数闸拒绝')
    // 会话酒店路由(2026-09-03 实装):未收录城市在 transport 前短路 → error + cityId 指引(offline 零桥零浏览器)
    const sh = await byName('gotry_session_search').execute({ query: { kind: 'hotel', to: '不在码表的城市' } }, null) as { ok?: boolean; verdict?: string; summary?: string }
    if (!(sh.ok === false && /city=/.test(String(sh.summary ?? '')))) {
      throw new Error(`FAIL: 会话酒店未收录城市应带 cityId 指引,实际:${JSON.stringify(sh).slice(0, 200)}`)
    }
    console.log('  hotel kind 路由:未收录城市 → error + cityId 指引(transport 前短路)')
    const fhPast = await byName('gotry_flyai_search').execute({ query: { kind: 'hotel', to: '大理', checkIn: '2026-01-01', checkOut: '2026-01-03' } }, null) as { ok?: boolean; summary?: string }
    if (!(fhPast.ok === false && /不是未来合法区间/.test(String(fhPast.summary ?? '')))) {
      throw new Error(`FAIL: 酒店过去入住日应代码层预校验拒绝,实际:${JSON.stringify(fhPast).slice(0, 200)}`)
    }
    const fhOutcome = fhBlocked
      ? 'sentinel-限流降级'
      : fhErrTerminal
        ? '端点不可达降级'
        : `${fh.hotels?.length ?? 0} 家`
    console.log(`  hotel channel: ${fhOutcome}; 参数闸/过去日闸生效`)
  }

  // 13) 账号会话授权闸(v2,RFC 支柱④进代码):每会话每站点首次弹卡、会话内记住;
  // 总闸 off → fail-closed deny(随时可关);其他工具原样放行。授权完整语义(批准记忆/
  // 拒绝吊销/allow)由 session-tests §I 纯函数覆盖;此处验证闸确实挂上了注册表。
  {
    const gate = preExecutes.at(-1)
    if (!gate) throw new Error('FAIL: tools/pre-execute 授权闸未注册')
    const next = async () => ({ kind: 'allow' as const })
    const ask = await gate({ name: 'gotry_session_search' }, next) as { kind?: string; reason?: string }
    if (ask.kind !== 'ask' || !/只读检索/.test(String(ask.reason ?? ''))) {
      throw new Error(`FAIL: 会话工具无审批通道时应交 ask(运行时原生结算),实际:${JSON.stringify(ask)}`)
    }
    const pass = await gate({ name: 'gotry_anything_search' }, next)
    if (pass.kind !== 'allow') throw new Error(`FAIL: 非会话工具应原样放行,实际:${JSON.stringify(pass)}`)
    cfg.sessionAccess = 'off'
    const deny = await gate({ name: 'gotry_session_search' }, next) as { kind?: string; reason?: string }
    if (deny.kind !== 'deny' || !/sessionAccess=off/.test(String((deny as { reason?: string }).reason ?? ''))) {
      throw new Error(`FAIL: sessionAccess=off 应 fail-closed deny,实际:${JSON.stringify(deny)}`)
    }
    cfg.sessionAccess = 'ask'
    console.log('consent gate: session tool → approval-card ask(每会话一次/拒绝即会话内吊销); off → fail-closed deny; other tools pass through')
  }

  // 14) 登录引导产品工具(gotry_session_login,第 18 工具):注册 + 「登录在外部网站完成、
  // gotry 不经手任何凭证」红线钉在描述里;不真调 execute(测试纪律:不开用户浏览器/不 attach)
  {
    const lo = byName('gotry_session_login')
    if (typeof lo.presentResult !== 'function') throw new Error('FAIL: gotry_session_login 缺 presentResult')
    const desc = String((lo as unknown as { description?: string }).description ?? '')
    if (!/NEVER collects, stores, or transmits credentials/.test(desc)) {
      throw new Error(`FAIL: 登录工具描述缺「不经手凭证」语义红线,实际 ${desc.slice(0, 120)}`)
    }
    console.log('login tool: registered; 登录=外部网站+用户自己的浏览器,gotry 只读票据名(0 值过手)语义钉死')
  }

  // 15) 产物面(issue #25):账本工单 + cwd md 可发现;read 行号窗口;dsh read 卡字段;越界/类型护栏
  {
    const { writeFileSync } = await import('node:fs')
    const { listArtifacts, readArtifact } = await import('../capabilities/artifacts.ts')
    const { ensureLedger } = await import('../src/state-ledger.ts')
    const cwdDir = mkdtempSync(join(tmpdir(), 'gotry-artifacts-cwd-'))
    const twelve = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行`).join('\n')
    writeFileSync(join(cwdDir, 'trip-2027-probe.md'), `# 行程·产物探针\n${twelve}\n`)

    // 账本权威路径:种一个已交付工单(隔离 stateRoot,不碰真实 gotry-state)
    const ledger = ensureLedger(smokeRoot)
    ledger.createWorkflowRun({ id: 'art-probe-1', goal: '行程·产物探针(账本)', ticket: { objective: 'probe' }, state: {} })
    ledger.settleWorkflowRun('art-probe-1', '# 交付·账本权威\nD1 大理\nD2 洱海')

    const listTool = byName('gotry_artifacts_list')
    const ledList = await listTool.execute({ query: {} }, null) as { ok?: boolean; artifacts?: Array<{ source?: string; id?: string; status?: string }>; total?: number }
    const run = ledList.artifacts?.find(a => a.id === 'art-probe-1')
    if (!ledList.ok || !run || run.source !== 'async-run' || run.status !== 'settled') {
      throw new Error(`FAIL: artifacts list 应发现账本已交付工单,实际:${JSON.stringify(ledList).slice(0, 200)}`)
    }
    const direct = await listArtifacts({ stateRoot: smokeRoot, cwd: cwdDir })
    if (!direct.artifacts.some(a => a.source === 'cwd-file' && a.id === 'trip-2027-probe.md')) {
      throw new Error(`FAIL: artifacts list 应发现 cwd 顶层 md,实际:${JSON.stringify(direct.artifacts.map(a => a.id))}`)
    }

    const readTool = byName('gotry_artifacts_read')
    const r1 = await readTool.execute({ query: { path: 'art-probe-1' } }, null) as { ok?: boolean; path?: string; offset?: number; lines?: Array<{ number: number; text: string }>; totalLines?: number; lang?: string }
    if (!r1.ok || r1.lines?.[0]?.number !== 1 || !r1.lines?.[0]?.text.includes('交付·账本权威') || r1.lang !== 'markdown') {
      throw new Error(`FAIL: 裸工单 id 应从账本读出行号视图,实际:${JSON.stringify(r1).slice(0, 200)}`)
    }
    const view = readTool.presentResult?.({ query: { path: 'art-probe-1' } }, r1) as { card?: string; path?: string; offset?: number; lines?: unknown[]; totalLines?: number; lang?: string }
    if (view?.card !== 'read' || view.path !== r1.path || view.offset !== 1 || view.lines?.length !== r1.lines?.length || view.totalLines !== r1.totalLines || view.lang !== 'markdown') {
      throw new Error(`FAIL: read 卡字段不齐,实际:${JSON.stringify(view).slice(0, 200)}`)
    }
    const r2 = await readArtifact({ stateRoot: smokeRoot, cwd: cwdDir, path: 'trip-2027-probe.md', offset: 10, limit: 5 })
    if (!r2.ok || r2.lines[0].number !== 10 || r2.windowed !== false) {
      throw new Error(`FAIL: 行窗口 12 行文件 offset=10 应从行号 10 起,实际:${JSON.stringify(r2.ok ? { o: r2.offset, first: r2.lines[0]?.number } : r2)}`)
    }
    if (r2.lines.length !== 5) throw new Error(`FAIL: 14 行文件 offset=10/limit=5 窗口应恰 5 行(10-14),实际 ${r2.lines.length}`)
    const badPath = await readArtifact({ stateRoot: smokeRoot, cwd: cwdDir, path: '../../../../../etc/passwd' })
    if (badPath.ok) throw new Error('FAIL: 越界路径必须被拒')
    const badExt = await readArtifact({ stateRoot: smokeRoot, cwd: cwdDir, path: 'gotry-state/gotry-state.db' })
    if (badExt.ok) throw new Error('FAIL: 白名单外扩展名(.db)必须被拒')
    rmSync(cwdDir, { recursive: true, force: true })
    console.log(`artifacts: ledger run + cwd md discovered; read window(${r2.ok ? r2.lines.length : '?'} lines @10) + read card; path/ext guardrails hold`)
  }

  // 16) 产物事实闸(issue #46,第 21 工具):事实落账(hit 正事实 + miss 负事实,隔离 stateRoot)
  //     → 闸内回溯:已验证措辞 pass;exact-date miss 的 route+date 被航班号填充 = blocked
  {
    const { appendFacts, loadFactRegistry } = await import('../capabilities/fact-log.ts')
    const { factsFromFlyai } = await import('../src/bookable-facts.ts')
    // 与生产同路径:事实落账即归一到 IATA 空间(index.ts 传 city_alias;闸侧 claim 也归一,两边才可比)
    const avMap = JSON.parse(await readFile(join(import.meta.dirname, '..', '..', 'data', 'airline-airports.json'), 'utf-8')) as { city_alias?: Record<string, string> }
    const fetchedAt = '2026-08-29T00:00:00.000Z'
    await appendFacts(smokeRoot, [
      ...factsFromFlyai({ kind: 'flight', origin: '香港', destination: '普吉', date: '2027-07-18' },
        { verdict: 'hit', options: [{ no: 'CX771', name: '国泰航空', depDateTime: '2027-07-18T08:05:00+08:00', arrDateTime: '2027-07-18T10:35:00+07:00', price: 1234 }], evidence: '' }, fetchedAt, avMap.city_alias),
      ...factsFromFlyai({ kind: 'flight', origin: '深圳', destination: '普吉', date: '2027-07-16' },
        { verdict: 'miss', options: [], evidence: '' }, fetchedAt, avMap.city_alias),
    ])
    const registry = await loadFactRegistry(smokeRoot)
    // §12 的 flyai live 检索也会落账(接线正确性的副产品)——按本次探针的 query_id 过滤
    const probeFacts = registry.filter((f): f is FlightFact => f.kind !== 'policy' && (f.query_id.endsWith(':2027-07-16') || f.query_id.endsWith(':2027-07-18')))
    if (probeFacts.length !== 2 || !probeFacts.some(f => f.bookability === 'unavailable_exact_date') || !probeFacts.some(f => f.bookability === 'bookable_exact_date')) {
      throw new Error(`FAIL: 事实侧车应落 1 正 1 负两条,实际:${JSON.stringify(probeFacts.map(f => f.bookability))}`)
    }
    const gate = byName('gotry_fact_gate')
    const passMd = ['# 行程片段', '## D3 7.18 香港 → 普吉', '- 国泰航空 CX771 08:05→10:35(已按 exact-date 检索记录)'].join('\n')
    const pass = await gate.execute({ query: { markdown: passMd, tripYear: 2027 } }, null) as { verdict?: string; presentation?: string }
    if (pass.verdict !== 'pass' || pass.presentation !== 'verified_itinerary_allowed') {
      throw new Error(`FAIL: 可回溯产物应 pass,实际:${JSON.stringify(pass).slice(0, 300)}`)
    }
    const badMd = ['# 行程片段', '## D1 7.16 深圳 → 普吉', '- 香港快运 UO784 10:05→12:40 直飞 ✓'].join('\n')
    const blocked = await gate.execute({ query: { markdown: badMd, tripYear: 2027 } }, null) as { verdict?: string; violations?: Array<{ kind?: string }>; summary?: string }
    if (blocked.verdict !== 'blocked' || !blocked.violations?.some(v => v.kind === 'not_in_source')) {
      throw new Error(`FAIL: exact-date miss 被 UO784 填充必须 blocked(not_in_source),实际:${JSON.stringify(blocked).slice(0, 300)}`)
    }
    const view = gate.presentResult?.({ query: {} }, blocked) as { title?: string }
    if (!view?.title?.includes('blocked')) throw new Error(`FAIL: blocked 呈现卡标题应含 blocked,实际:${view?.title}`)
    console.log(`fact gate: registry 1+1(hit/miss);verified 措辞 pass;miss 填充 UO784 blocked(not_in_source) + 呈现卡`)
  }

  // 17) LLM_MODEL 会话面覆盖(issue #77):未设 GOTRY_LLM_MODEL 不挂监听(默认路径
  //     面不变);设了则 agent/request 瀑布 post-next 覆盖 provider/model 并清掉继承
  //     effort——用户层(~/.dsh)选择被显式 .env 意图压过,内存态零持久化
  {
    // 17a 未设环境变量 → 不挂监听(默认面不变)
    const none: Array<unknown> = []
    const ctxNone = { on: (_e: string, fn: unknown) => { none.push(fn) } }
    if (installModelOverride(ctxNone, {}) !== false || none.length !== 0) {
      throw new Error('FAIL: 未设 GOTRY_LLM_MODEL 时不得挂 agent/request 覆盖')
    }
    // 17b 无事件总线的极简宿主 → false 而非抛错
    if (installModelOverride({}, { GOTRY_LLM_MODEL: 'MiniMax-M2' }) !== false) {
      throw new Error('FAIL: 无事件总线宿主应返回 false 而非抛错')
    }
    // 17c 设定 → 覆盖生效且清继承 effort(其余请求字段原样保留)
    const listeners: Array<(p: unknown, next: () => Promise<AgentRequestConfig>) => Promise<AgentRequestConfig>> = []
    const ctxOn = { on: (_e: string, fn: (p: unknown, next: () => Promise<AgentRequestConfig>) => Promise<AgentRequestConfig>) => { listeners.push(fn) } }
    if (installModelOverride(ctxOn, { GOTRY_LLM_MODEL: 'MiniMax-M2' }) !== true || listeners.length !== 1) {
      throw new Error('FAIL: 设定 GOTRY_LLM_MODEL 后应挂恰好一条 agent/request 覆盖')
    }
    const inner = async () => ({ provider: 'deepseek-official', model: 'glm-5.3-flash', reasoningEffort: 'high', maxTokens: 4096 })
    const overridden = await listeners[0](null, inner)
    if (overridden.model !== 'MiniMax-M2' || overridden.provider !== 'deepseek-official'
      || 'reasoningEffort' in overridden || overridden.maxTokens !== 4096) {
      throw new Error(`FAIL: 覆盖结果不符预期:${JSON.stringify(overridden)}`)
    }
    console.log('model override: 未设不挂/无总线不抛/设定后压过用户层选择(glm-5.3-flash→MiniMax-M2)且清继承 effort')
  }

  rmSync(smokeRoot, { recursive: true, force: true })
  console.log(`smoke state cleaned: ${smokeRoot}`)

  console.log('\nSMOKE OK')
}

main().catch((e) => { console.error(e); process.exit(1) })
