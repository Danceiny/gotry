/**
 * i18n 消息目录(README Known limitation「zh-CN 体验」的工程清偿件):
 * GoTry 自有「确定性输出面」= 求解 answer_md(候选/航班链两渲染)+ 放宽建议文案
 * + 排除理由。LLM 人格面(对话语言)由模型跟随用户语言,不在此层。
 *
 * 契约:
 *   - 默认 `zh-CN`,模板与历次金标准逐字节一致(engine/unified 金标准套件即回归闸);
 *   - `GOTRY_LOCALE=en`(或 setLocale)切英文;键缺失回退 zh 再回退键名——en 目录不齐不算错;
 *   - 插值 `{var}`;数字/时刻在调用点格式化,catalog 只管词序与措辞。
 */

export type Locale = 'zh-CN' | 'en'

export type MsgKey =
  | 'md.header' | 'md.constraints' | 'md.infeasible' | 'md.relax_one' | 'md.wish_pool'
  | 'md.wish_budget' | 'md.wish_season'
  | 'md.feasible_engine' | 'md.feasible_unified'
  | 'md.recommend' | 'md.alt' | 'md.decide_two'
  | 'md.q_choice' | 'md.q_single' | 'md.q_none' | 'md.q_wish' | 'md.q_depart'
  | 'sg.duration' | 'sg.budget' | 'sg.wake_floor' | 'sg.energy_floor' | 'sg.usable_hours' | 'sg.arrival'
  | 'sg.plan' | 'sg.wish_reason_engine' | 'sg.wish_reason_window'
  | 'un.workwindow_reason' | 'un.redflag_redeye'

type Catalog = Record<MsgKey, string>

const ZH: Catalog = {
  'md.header': '> 憧憬:{note}',
  'md.constraints': '> 已识别约束:窗口 {days} 天 | 预算 ¥{budget} | 动机(休整改写需求 {hours}h 有效休整)',
  'md.infeasible': '**{name}:现在不行**——冲突约束:{core}。',
  'md.relax_one': '- 放宽 {relax}:约 ¥{money}',
  'md.wish_pool': '- 已放入「下一次出发」清单:需要 {days} 天{budgetNote}{season}',
  'md.wish_budget': '、约 ¥{cny}',
  'md.wish_season': ',{months} 月最佳',
  'md.feasible_engine': '**{name}:可行**({id} {dep} 出发,{mode} 接驳,{arrive} 到住处,起床 {wake},到达精力 {energy}%,门到门 {d2d},有效休整 {hours}h,共 ¥{money})',
  'md.feasible_unified': '**{name}:可行**({svc} 出发,{mode} 接驳,起床 {wake},到达精力 {energy}%,门到门 {d2d},有效休整 {hours}h,共 ¥{money})',
  'md.recommend': '**建议:{best}**(意象匹配 {match}%)。',
  'md.alt': '备选:{name}(¥{money},匹配 {match}%)。',
  'md.decide_two': '**待你决定的两个问题**:',
  'md.q_choice': '1. {a} 还是 {b}?(前者更贴意象,后者更省)',
  'md.q_single': '1. 就去 {name} 吗?',
  'md.q_none': '1. 所有候选都不可行——考虑放宽哪条约束?',
  'md.q_wish': '2. 把 {name} 留给「下一次出发」({days} 天起),这次先去可行的?',
  'md.q_depart': '2. 出发班次选 {id}({dep})还是更晚的?',
  'sg.duration': '把行程延长到 {days} 天({name} 值得这个窗口)',
  'sg.budget': '预算提高到 ¥{cost}(原 ¥{budget})',
  'sg.wake_floor': '接受 {wake} 起床——破坏生物钟,与你的休整动机冲突,不推荐',
  'sg.energy_floor': '接受到达精力 {pct}%(低于你要求的 {min}%)',
  'sg.usable_hours': '接受有效休整 {hours}h(低于动机所需的 {need}h)',
  'sg.arrival': '接受 {time} 才到住处',
  'sg.plan': '可行方案:{id} {dep} 出发、{mode} 接驳,¥{money},{wake} 起床,{arrive} 到住处,到达精力 {percent}%',
  'sg.wish_reason_engine': '动机谱系 {weights} 下,{days} 天窗口装不下这个目的地',
  'sg.wish_reason_window': '{days} 天窗口装不下(目的需 {minDays} 天)',
  'un.workwindow_reason': '周{wd} {dep} 起飞落在工作窗口(当地 {start}-{end})内',
  'un.redflag_redeye': '{leg} 落地精力仅 {pct}%(红眼后直奔事务,当日不宜安排重要会议)',
}

const EN: Catalog = {
  'md.header': '> Aspiration: {note}',
  'md.constraints': '> Constraints captured: {days}-day window | budget ¥{budget} | motivation (needs {hours}h of usable rest)',
  'md.infeasible': '**{name}: not yet** — conflicting constraints: {core}.',
  'md.relax_one': '- Relax {relax}: about ¥{money}',
  'md.wish_pool': '- Added to the "next departure" list: needs {days} days{budgetNote}{season}',
  'md.wish_budget': ', about ¥{cny}',
  'md.wish_season': ', best in months {months}',
  'md.feasible_engine': '**{name}: feasible** ({id} departs {dep}, {mode} transfer, at your stay by {arrive}, wake {wake}, arrival energy {energy}%, door-to-door {d2d}, {hours}h of real rest, total ¥{money})',
  'md.feasible_unified': '**{name}: feasible** ({svc} departs, {mode} transfer, wake {wake}, arrival energy {energy}%, door-to-door {d2d}, {hours}h of real rest, total ¥{money})',
  'md.recommend': '**Suggestion: {best}** (imagery match {match}%).',
  'md.alt': 'Alternative: {name} (¥{money}, match {match}%).',
  'md.decide_two': '**Two decisions for you**:',
  'md.q_choice': '1. {a} or {b}? (former fits the vision, latter saves more)',
  'md.q_single': '1. Go with {name}?',
  'md.q_none': '1. All candidates are infeasible — which constraint to relax?',
  'md.q_wish': '2. Keep {name} for the "next departure" ({days}+ days) and go feasible this time?',
  'md.q_depart': '2. Departure: {id} ({dep}) or later?',
  'sg.duration': 'Extend the trip to {days} days ({name} deserves this window)',
  'sg.budget': 'Raise budget to ¥{cost} (was ¥{budget})',
  'sg.wake_floor': 'Accept a {wake} wake-up — wrecks your body clock, conflicts with your rest motivation, not recommended',
  'sg.energy_floor': 'Accept arrival energy {pct}% (below your required {min}%)',
  'sg.usable_hours': 'Accept {hours}h of usable rest (below the {need}h your motivation needs)',
  'sg.arrival': 'Accept reaching your stay only at {time}',
  'sg.plan': 'Feasible plan: {id} departs {dep}, {mode} transfer, ¥{money}, wake {wake}, at your stay {arrive}, arrival energy {percent}%',
  'sg.wish_reason_engine': 'under motivation weights {weights}, a {days}-day window cannot fit this destination',
  'sg.wish_reason_window': '{days}-day window cannot fit (the purpose needs {minDays} days)',
  'un.workwindow_reason': 'Departs {dep} on weekday {wd}, inside your work window (local {start}-{end})',
  'un.redflag_redeye': '{leg} lands with only {pct}% energy (red-eye then straight to business — no big meetings that day)',
}

let locale: Locale = process.env['GOTRY_LOCALE'] === 'en' ? 'en' : 'zh-CN'

export function getLocale(): Locale {
  return locale
}

export function setLocale(l: Locale): void {
  locale = l
}

/** 词条渲染:en 缺键回退 zh,再回退键名;插值 {var},缺变量原样保留 `{var}`。 */
export function t(key: MsgKey, vars: Record<string, string | number> = {}): string {
  const tpl = (locale === 'en' ? EN[key] : undefined) ?? ZH[key] ?? String(key)
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`))
}

/** en 目录完备性检查:缺键即列出(测试闸用,运行时回退而非抛错) */
export function enCoverage(): Array<MsgKey> {
  return (Object.keys(ZH) as MsgKey[]).filter(k => EN[k] === undefined)
}