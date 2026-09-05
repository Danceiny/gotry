/**
 * 政策事实生产端 v1(issue #141,D-26 收口切片)——C 档数据源:中国领事服务网
 * (cs.mfa.gov.cn,外交部一手口径,免费权威)的「了解目的地」国家指南树。
 *
 * 形态:VISA_POLICY_FETCH 效应(effect 注册表行,礼貌抓取:UA 标识 + 超时 +
 * 永不重试 + 断路器护站)→ 国家页 HTML → 「签证入境」章节文本 → PolicyFact[]
 * (as_of + review_by + cs.mfa.gov.cn 来源证据链)。
 *
 * 纪律(ADR-19 + 抓取红线):
 *   - 永不抛错(永不抛错能力层契约);传输失败 → {ok:false, via:'visa-policy-error'},
 *     **不落负事实**(无结论不是证据);
 *   - 抓取失败/页面缺失 → 结构化降级,不猜不填;
 *   - 政策事实恒带 review_by 复核 gate(默认 D-30);
 *   - 礼貌抓取:单站点串行 + 调用方控制频率;站点不可达不重试(策略表 null)。
 *
 * 升级路径:D-31 后可切 B 档 Sherpa° 商业源(effect 注册表行可插拔替换)。
 *
 * @module capabilities/visa-policy
 */

import { readFileSync } from 'node:fs'
import { BOOKABLE_FACT_SCHEMA, makeFactId } from '../src/bookable-facts.ts'

const SOURCE_HOST = 'https://cs.mfa.gov.cn'
const SOURCE_ID = 'cs-mfa'
const USER_AGENT = 'GoTry/0.0.1 (+https://github.com/Danceiny/gotry; polite policy reader)'

/** VISA_POLICY_FETCH 效应参数(issue #141):country 单国直抓;continent+limit 走洲列表遍历(礼貌上限 10) */
export interface VisaPolicyEffectParams {
  country?: string
  continent?: string
  countryLabel?: string
  limit?: number
  timeoutMs?: number
}

export interface VisaPolicyQuery {
  /** 洲路径段(如 yz_645708 亚洲);缺省 = 已知洲全遍历 */
  continent?: string
  /** 国家路径段(如 tg_647570 泰国);给了就只抓这一国 */
  country?: string
  timeoutMs?: number
}

export interface VisaPolicyResult {
  ok: boolean
  via: 'cs-mfa' | 'visa-policy-error'
  evidence: string
  latencyMs: number
  /** 抓取+解析出的政策事实(调用方落账;错误时为空数组——无结论不落账) */
  facts: Array<{ subject: string; statement: string; as_of: string; country_path: string }>
  countries_fetched: string[]
  error?: string
}

const CONTINENTS = [
  'yz_645708', // 亚洲
  'feizhou_645714', // 非洲
  'ouzhou_645711', // 欧洲
  'bz_645718', // 美洲(北/南)
  'dyz_645717', // 大洋洲
] as const

/** 国家路径 → 政策页 URL(抓取纪律:仅此两种 URL 形态,不拼接任意输入) */
export function countryPageUrl(continent: string, country: string): string | null {
  if (!/^[a-z0-9_]+$/.test(continent) || !/^[a-z0-9_]+$/.test(country)) return null
  return `${SOURCE_HOST}/zggmcg/ljmdd/${continent}/${country}/`
}

/** 剥 HTML 标签 → 纯文本(保守:不执行任何内嵌脚本/样式) */
function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
}

/**
 * 从国家页文本抽取「签证入境」章节(到下一个同级标题为止)。
 * 页面为 MFA 编辑器产出的散文(如中泰互免协定生效日期/停留期限条款),逐段保留原句。
 */
export function extractVisaSection(pageText: string): string | null {
  const text = stripTags(pageText)
  const start = text.indexOf('签证入境')
  if (start < 0) return null
  const rest = text.slice(start + '签证入境'.length)
  // 下一大节标题探测:中文数字编号(非签证词)+已知下一节名(不用正文高频词做边界)
  const sectionEnds = ['海关检查', '海关申报', '医疗条件', '交通出行', '实用信息', '领事保护', '国家安全', '特别提醒']
    .map(kw => rest.indexOf(kw))
    .filter(i => i > 0)
  const numHeaders = Array.from(rest.matchAll(/[一二三四五六七八九十]+、(?!免签|落地签|签证|入境规定)/g)).map(m => m.index!).filter(i => i > 0)
  const allEnds = [...sectionEnds, ...numHeaders].sort((a, b) => a - b)
  const end = allEnds.length > 0 ? allEnds[0]! : Math.min(rest.length, 4_000)
  const section = rest.slice(0, end).trim()
  return section.length > 20 ? section : null
}

/**
 * 章节 → 政策陈述条目:按中文序号段落切分(一、二、…),每段一条 PolicyFact 原料。
 * 免签/落地签/签证要求各成一条,供闸侧逐条回溯。
 */
export function splitPolicyEntries(section: string): string[] {
  const parts = section.split(/(?:[一二三四五六七八九十]+、|[（(]\s*[一二三四五六七八九十]+\s*[）)])\s*/).map(p => p.trim())
  return parts.filter(p => p.length > 30)
}

/**
 * 解析后的章节 → PolicyFact[](as_of + review_by + 来源证据链;issue #141 v1)。
 * 纯函数;fact_id 由 makeFactId 派生幂等。
 */
export interface MfaPolicyFact {
  schema: typeof BOOKABLE_FACT_SCHEMA
  fact_id: string
  kind: 'policy'
  subject: string
  statement: string
  source: string
  query_id: string
  fetched_at: string
  as_of: string
  review_by: string
}

export function policyFactsFromMfa(input: {
  countryLabel: string
  countryPath: string
  section: string
  fetchedAt: string
}): MfaPolicyFact[] {
  const entries = splitPolicyEntries(input.section)
  const asOf = input.fetchedAt.slice(0, 10)
  const queryId = `visa-policy:${SOURCE_ID}:${input.countryPath}:${asOf}`
  return entries.map((entry, i) => ({
    schema: BOOKABLE_FACT_SCHEMA,
    fact_id: makeFactId([input.countryPath, String(i), entry.slice(0, 64), queryId]),
    kind: 'policy' as const,
    subject: `${input.countryLabel} 签证入境(条款 ${i + 1})`,
    statement: entry,
    source: `${SOURCE_ID}@${input.fetchedAt}`,
    query_id: queryId,
    fetched_at: input.fetchedAt,
    as_of: asOf,
    review_by: defaultReviewBy(input.fetchedAt),
  }))
}

/** 政策复核 gate:抓取日 +30 天(D-30 族) */
export function defaultReviewBy(fetchedAt: string): string {
  const d = new Date(fetchedAt)
  d.setDate(d.getDate() + 30)
  return d.toISOString().slice(0, 10)
}

/** 从洲列表页 HTML 提取国家路径段(相对形态 ./tg_647570/ → tg_647570;仅收本站链接) */
export function listCountryPaths(continentListHtml: string, continent: string): string[] {
  const hits = continentListHtml.matchAll(new RegExp(`href="(\\./([a-z0-9_]+)/)"[^>]*>([^<]{2,20})<`, 'g'))
  const out: Array<{ path: string; label: string }> = []
  for (const m of hits) {
    if (!m[2] || !m[3]) continue
    out.push({ path: m[2]!, label: m[3]!.trim() })
  }
  return out.map(x => x.path).filter(p => /^[a-z0-9_]+$/.test(p))
}

/** 洲路径段 → 洲列表页 URL(形态受控,不拼接任意输入) */
export function continentListUrl(continent: string): string | null {
  if (!/^[a-z0-9_]+$/.test(continent)) return null
  return `${SOURCE_HOST}/zggmcg/ljmdd/${continent}/`
}

/** 从本地 fixture 读页面(测试确定性;生产走 fetchVisaPolicyPage) */
export function readPageFixture(path: string): string {
  return readFileSync(path, 'utf-8')
}

/** 礼貌抓取国家页(永不抛错;失败 = 结构化降级,不落负事实) */
export async function fetchVisaPolicyPage(url: string, timeoutMs = 20_000): Promise<{ ok: boolean; html?: string; error?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'zh-CN,zh' },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    return { ok: true, html: await res.text() }
  } catch (e) {
    const msg = controller.signal.aborted ? `timeout after ${timeoutMs}ms` : String((e as Error).message ?? e)
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}
