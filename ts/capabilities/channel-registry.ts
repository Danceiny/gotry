/**
 * 通道注册表(channel registry)——检索通道的**单一数据来源**
 * (docs/tool-orchestration-design.md §2.1,issue #106/#107/#108 编排设计)。
 *
 * 每行描述一条通道:覆盖意图 / 配额类 / 证据级 / 工具名 / setup 成本。
 * persona 路由卡(renderRoutingCard → {{channel_routing_card}})、工具结果内的
 * routing 建议字段(routingAdvice)、doctor 通道行,全部由本表**生成**——
 * 加一个通道 = 这里加一行 + handler 一个 + 测试断言,prose 站点零手改。
 *
 * 编排语义(§3.3,founder D-8 拍板采纳):工具面保持平铺(ADR-18/persona (19)
 * 判定不动),本模块只产出「健康态驱动的动态建议」——价值序 =
 * lexicographic(可用性, 可靠性=证据级, 效率=成本/时延)。通道间在给定健康态
 * 下相互独立,最优子结构成立,DP 退化为有序建议表;**建议不是派发**,
 * 解译器不做隐藏改道(调用可审计性)。
 *
 * 配额分类(§3.2,D-7 拍板采纳):user-session=用户本人账号;user-key=用户自备
 * 凭证;anonymous-trial=产品垫付导流层(达限即改道+升级指引);free-public=社区
 * 公平使用;static=无配额估算(内部自动降级面,不进模型可选路由)。
 *
 * @module capabilities/channel-registry
 */

import { channelState } from './channel-health.ts'

export type ChannelIntent =
  | 'search-flight'
  | 'search-train'
  | 'search-hotel'
  | 'search-geo'
  | 'read-web'
  | 'weather'
  | 'verify-flight'

export type ChannelQuotaClass =
  | 'user-session'
  | 'user-key'
  | 'anonymous-trial'
  | 'free-public'
  | 'static'

/** 可靠性=证据级:[实时API] > [会话] > 网页兜底 > [静态包:估算] */
export type EvidenceTier = 'realtime-api' | 'session' | 'best-effort' | 'static'

export interface ChannelEntry {
  /** 稳定 id(doctor/健康面/测试锚点) */
  id: string
  /** 人话名(persona 卡与 routing why 用) */
  label: string
  /** 模型调用的工具名 */
  tool: string
  /** 覆盖的意图(闭集) */
  intents: readonly ChannelIntent[]
  quotaClass: ChannelQuotaClass
  /** 该通道成功结果的证据链标注前缀 */
  evidenceTag: string
  tier: EvidenceTier
  /** 同 tier 内效率粗排(小者先:成本/时延) */
  efficiencyRank: number
  /** 一次性 setup 成本(routing 建议里带,让模型一句话向用户交代) */
  setup?: string
  /** kind 参数面(session 工具三通道同名工具)在 persona 卡里消歧用 */
  hint?: string
  /** false = 内部自动降级面,不进模型可选路由建议(静态包) */
  routable?: boolean
}

export const CHANNELS: readonly ChannelEntry[] = [
  {
    id: 'flyai',
    label: '飞猪官方 API',
    tool: 'gotry_flyai_search',
    intents: ['search-flight', 'search-train', 'search-hotel'],
    quotaClass: 'anonymous-trial',
    evidenceTag: '[实时API:flyai@ts]',
    tier: 'realtime-api',
    efficiencyRank: 0,
    setup: '零 setup(匿名试用共享池,易达限;正式 key 配 FLYAI_API_KEY 解除)',
  },
  {
    id: 'hbcli-hotel',
    label: 'hbcli 酒店实时源',
    tool: 'gotry_hotel_search',
    intents: ['search-hotel'],
    quotaClass: 'user-key',
    evidenceTag: '[实时API:hbcli@ts]',
    tier: 'realtime-api',
    efficiencyRank: 1,
    setup: 'hbcli 凭证(demo 沙箱一键);未装自动降静态包',
  },
  {
    id: 'session:ctrip-flight',
    label: '携程·用户登录态',
    tool: 'gotry_session_search',
    intents: ['search-flight'],
    quotaClass: 'user-session',
    evidenceTag: '[会话:ctrip-flight@ts]',
    tier: 'session',
    efficiencyRank: 2,
    setup: '一次性装 Session Bridge 扩展 + 授权卡 + (如需)官网登录',
    hint: 'kind=flight',
  },
  {
    id: 'session:ctrip-hotel',
    label: '携程·用户登录态',
    tool: 'gotry_session_search',
    intents: ['search-hotel'],
    quotaClass: 'user-session',
    evidenceTag: '[会话:ctrip-hotel@ts]',
    tier: 'session',
    efficiencyRank: 2,
    setup: '一次性装 Session Bridge 扩展 + 授权卡 + (如需)官网登录',
    hint: 'kind=hotel',
  },
  {
    id: 'session:12306-train',
    label: '12306 公开查询面',
    tool: 'gotry_session_search',
    intents: ['search-train'],
    quotaClass: 'user-session',
    evidenceTag: '[会话:train-12306@ts]',
    tier: 'session',
    efficiencyRank: 2,
    setup: '一次性装 Session Bridge 扩展(公开查询面,无需登录)',
    hint: 'kind=train',
  },
  {
    id: 'anything-geo',
    label: '目的地/酒店候选(hotel-be)',
    tool: 'gotry_anything_search',
    intents: ['search-geo'],
    quotaClass: 'user-key',
    evidenceTag: '[实时API:hbcli-anything@ts]',
    tier: 'realtime-api',
    efficiencyRank: 1,
    setup: 'hbcli 可达即可(随 hbcli 安装)',
  },
  {
    id: 'open-meteo',
    label: '天气(open-meteo)',
    tool: 'gotry_weather_check',
    intents: ['weather'],
    quotaClass: 'free-public',
    evidenceTag: '[实时API:open-meteo@ts]',
    tier: 'realtime-api',
    efficiencyRank: 0,
  },
  {
    id: 'opensky',
    label: '航班实时印证(OpenSky)',
    tool: 'gotry_flight_verify',
    intents: ['verify-flight'],
    quotaClass: 'free-public',
    evidenceTag: '[实时API:opensky@ts]',
    tier: 'realtime-api',
    efficiencyRank: 0,
  },
  {
    id: 'web-read',
    label: '网页读取兜底(agent-reach)',
    tool: 'gotry_web_search',
    intents: ['read-web', 'search-flight', 'search-train', 'search-hotel'],
    quotaClass: 'user-key',
    evidenceTag: '[agent-reach:web.read@ts]',
    tier: 'best-effort',
    efficiencyRank: 3,
    setup: 'gotry .venv 装 agent-reach(npx gotry doctor --fix)',
  },
  {
    id: 'static-hotel',
    label: '内置静态数据包',
    tool: 'gotry_hotel_search',
    intents: ['search-hotel'],
    quotaClass: 'static',
    evidenceTag: '[静态包:估算]',
    tier: 'static',
    efficiencyRank: 9,
    routable: false,
  },
]

const TIER_RANK: Record<EvidenceTier, number> = {
  'realtime-api': 0,
  session: 1,
  'best-effort': 2,
  static: 3,
}

const TIER_WHY: Record<EvidenceTier, string> = {
  'realtime-api': '官方结构化数据,证据链最强',
  'session': '用户本人登录态的真实价/库存',
  'best-effort': '非结构化兜底(读页汇总),证据弱于 API',
  'static': '内置估算,仅覆盖内置场景',
}

export const INTENT_LABELS: Record<ChannelIntent, string> = {
  'search-flight': '机票',
  'search-train': '火车',
  'search-hotel': '酒店',
  'search-geo': '目的地候选',
  'read-web': '网页/社媒',
  'weather': '天气',
  'verify-flight': '航班印证',
}

/** 意图 → 候选通道(证据级降序,同 tier 按效率升序)。纯函数。 */
export function channelsForIntent(intent: ChannelIntent): ChannelEntry[] {
  return CHANNELS
    .filter(c => c.routable !== false && c.intents.includes(intent))
    .slice()
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.efficiencyRank - b.efficiencyRank)
}

export interface RoutingAlternative {
  tool: string
  channel: string
  label: string
  why: string
  setup?: string
  hint?: string
}

export interface RoutingAdvice {
  intent: ChannelIntent
  alternatives: RoutingAlternative[]
}

export interface RoutingAdviceOptions {
  /** 发起本次调用(失败)的通道——建议表里排除 */
  excludeChannel?: string
  now?: number
  /** 最多几条(默认 3,控 token) */
  limit?: number
}

/**
 * 意图 × 健康态 → 有序改道建议(模型可见的 routing 字段形状)。
 * 排除规则:发起通道本身;会话健康面标记为 down 的通道。
 * cooldown 是瞬时节律,不算不可用(保留在表里,why 不变——模型自然
 * 「稍候重试或其他」),down(配额尽/挑战/需登录/需扩展)才排除。
 */
export function routingAdvice(intent: ChannelIntent, opts: RoutingAdviceOptions = {}): RoutingAdvice {
  const alternatives = channelsForIntent(intent)
    .filter(c => c.id !== opts.excludeChannel)
    .filter(c => channelState(c.id, opts.now)?.state !== 'down')
    .slice(0, opts.limit ?? 3)
    .map(c => ({
      tool: c.tool,
      channel: c.id,
      label: c.label,
      why: TIER_WHY[c.tier],
      ...(c.setup ? { setup: c.setup } : {}),
      ...(c.hint ? { hint: c.hint } : {}),
    }))
  return { intent, alternatives }
}

/**
 * persona 路由卡({{channel_routing_card}}):每意图一行顺位 + 额度口径脚注。
 * 确定性渲染(零 IO,时钟只进脚注);只列有 ≥2 条可选通道的意图——
 * 单通道意图没有路由选择,列了只是 token 噪声。
 */
export function renderRoutingCard(now = new Date()): string {
  const multiChannel = (Object.keys(INTENT_LABELS) as ChannelIntent[])
    .map(intent => ({ intent, channels: channelsForIntent(intent) }))
    .filter(x => x.channels.length >= 2)
  const lines = multiChannel.map(({ intent, channels }) =>
    `- ${INTENT_LABELS[intent]}: ${channels.map(c => `${c.label}(${c.tool}${c.hint ? ` ${c.hint}` : ''})`).join(' → ')}`)
  return [
    '检索通道顺位(官方API > 用户会话 > 网页兜底;某次检索 verdict≠hit 时,按该结果内 routing 字段改道下一通道,同通道本会话不盲试第二次):',
    ...lines,
    '额度口径:匿名试用=首次体验导流(达限即改道并提示配 key);正式 key(FLYAI_API_KEY/hbcli 凭证)与账号会话=正式用量;静态包=估算必标注。',
    `卡生成于 ${now.toISOString()}(通道状态变化不改变顺位表本身,只影响 routing 建议的可用性过滤)。`,
  ].join('\n')
}
