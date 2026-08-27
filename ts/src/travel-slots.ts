/**
 * 槽位抽取层(travel_slot_extraction.v1):面向差旅 intake 的槽位 schema + 确定性过期校验 + 评分器。
 *
 * 设计约定(与评测 golden 逐条对齐):
 *  - 时间表达**逐字保留**(「下周一」就写「下周一」),换算归下游工具——tool-owned dates;
 *  - 过期判定在代码层(flagExpiredSlots),LLM 只负责逐字抽取;
 *  - 过期只判**主日期字段**(requisition.start_date / flight.departure_date / hotel.check_in_date),
 *    且槽位原值保留,仅往 missing_slots 追加 "<domain>.<field> (date is expired)";
 *  - 相对/模糊表达永不判过期(「本周三」即使已过也逐字传递,由人裁决语义)。
 *
 * slot→spec 求解桥接不在本期(architecture §10 债务)。
 */

import { parseAbsoluteDate, type TimeAnchor } from './time-anchor.ts'

export type SlotDomain = 'requisition' | 'flight' | 'hotel'

export interface RequisitionSlots {
  mode?: 'create' | string
  destination?: string | string[]
  start_date?: string
  end_date?: string
  duration_days?: number
  trip_type?: 'one_way' | 'round_trip' | string
}

export interface FlightSlots {
  action?: 'search' | string
  origin?: string
  destination?: string | string[]
  departure_date?: string
  return_date?: string
  departure_time_pref?: string
  sort_name?: string
  sort_type?: string
  multi_destination?: boolean
  trip_type?: 'one_way' | 'round_trip' | string
}

export interface HotelSlots {
  action?: 'search' | string
  city?: string
  check_in_date?: string
  check_out_date?: string
}

export interface TravelSlotExtraction {
  schema_version: 'travel_slot_extraction.v1'
  language: 'zh' | 'en' | 'mixed'
  domains: SlotDomain[]
  slots: {
    requisition?: RequisitionSlots
    flight?: FlightSlots
    hotel?: HotelSlots
  }
  missing_slots: string[]
}

/** 各域的主日期字段——过期校验只判它(对齐 golden:8.1-8.10 仅 start_date 进 missing_slots) */
const PRIMARY_DATE_FIELD: Record<SlotDomain, string> = {
  requisition: 'start_date',
  flight: 'departure_date',
  hotel: 'check_in_date',
}

/**
 * 确定性过期校验(纯函数,不改入参):主日期字段是**绝对**月日表达且早于锚点今天,
 * 往 missing_slots 追加 "<domain>.<field> (date is expired)"(幂等去重);槽位原值不动。
 */
export function flagExpiredSlots(ext: TravelSlotExtraction, anchor: TimeAnchor): TravelSlotExtraction {
  const anchorYear = Number(anchor.today.slice(0, 4))
  const missing = [...ext.missing_slots]
  for (const domain of ext.domains) {
    const slots = ext.slots[domain] as Record<string, unknown> | undefined
    const field = PRIMARY_DATE_FIELD[domain]
    const value = slots?.[field]
    if (typeof value !== 'string') continue
    const resolved = parseAbsoluteDate(value, anchorYear)
    if (resolved && resolved < anchor.today) {
      const flag = `${domain}.${field} (date is expired)`
      if (!missing.includes(flag)) missing.push(flag)
    }
  }
  return { ...ext, missing_slots: missing }
}

/** 槽位抽取 system prompt:锚点卡注入 + 逐字保留铁律(LLM 不做算术、不判过期) */
export function buildSlotSystem(anchor: TimeAnchor): string {
  return `你是差旅需求的槽位抽取器。从用户原话抽取槽位,只输出 JSON:
{"schema_version":"travel_slot_extraction.v1","language":"zh|en|mixed","domains":["requisition"|"flight"|"hotel",...],"slots":{...},"missing_slots":[...]}

## 时间锚点卡
${anchor.card}
相对日期(明天/下周X/下个月中旬/国庆前…)对应的绝对日期都查锚点卡,不要自己心算。

## 铁律
1. 时间表达逐字保留、不翻译:用户说「下周一」就写「下周一」,说「next Thursday」就写 "next Thursday"——绝不换算成绝对日期、绝不切换语言(换算归下游工具)。模糊时间词(过几天/近期/下周初/隔周/下个月)同样是合法槽位值,逐字保留,**不算缺失**。
2. language 指**用户原话**的语言(与槽位值用什么语言无关):全中文 zh;全英文 en;中英混排 mixed。即使槽位值按规则 10 含中文城市名,只要原话全英文,language 仍为 en。
3. 域判定——看用户的**动作动词**,一句话可落多个域:
   - 安排行程/行程推荐/帮我安排 → requisition:{"mode":"create","destination","start_date","end_date"?,"trip_type"}
   - 看/查/订机票、航班、票价 → flight:{"action":"search","origin"?,"destination","departure_date","return_date"?,"trip_type"}
   - 看/订酒店、入住、订房 → hotel:{"action":"search","city","check_in_date","check_out_date"?};「待/住 N 天」只是时长语义,不单独构成 hotel 域
   - 「出差/去 X」本身不构成 requisition;没有上述动词的单城出行意图按回程形态分流:
     「去 X,当天往返」→ 仅 requisition(round_trip);「去 X,周日回/X 号回」跨天回程 → 仅 flight(round_trip)。
4. trip_type 必填(requisition 与 flight;hotel 不要):出现「往返/回程/当天往返/X 号回」→ "round_trip";否则显式 "one_way"。
5. 停留天数:「出差/待/住 N 天」→ requisition 用 "duration_days":N;hotel 用 "check_out_date":"<入住表达>+N" 原样拼接。
6. 回程机票(「住 N 天回 X」「待到周日回 X」):flight.origin=旅行城市, flight.destination=X, flight.departure_date="<入住/到达表达>+N" 或逐字回程表达,只有回程时 trip_type="one_way"。
7. 价格**排序**偏好只在找低价时加(「哪天便宜/比较便宜/最便宜」→ flight "sort_name":"PRICE","sort_type":"ASC");单纯「看价格/多少钱」不加。
8. 出发时段偏好(「早上七点后出发」)→ flight 加 "departure_time_pref":"07:00后"(HH:MM后 格式)。
9. 多目的地:
   - 国内多城链路(≥3 城):requisition.destination 与 flight.destination 都写**全程城市数组**(含首站),flight 不写 origin,departure_date=首段出发表达,加 "multi_destination":true;不为链路每段单独建 hotel/子段。
   - 国际开口程(open-jaw):flight.origin=首站(单值), flight.destination=后续链路数组, 加 "multi_destination":true。
10. 城市名:纯国内行程用中文标准名(北京/上海/广州/深圳…,即使原文是拼音);国际或跨国多城链路的城市名保留用户原文。
11. 关键槽位缺失(如有机票意图但无目的地)→ missing_slots 加 "<domain>.<field>";不缺则空数组。
12. 过期判定不归你:绝对日期是否已过由下游确定性层处理,你只管逐字抽取。

## 示例(学习约定,勿照抄内容)
用户:下周五入住上海,住三天回杭州
输出:{"schema_version":"travel_slot_extraction.v1","language":"zh","domains":["hotel","flight"],"slots":{"hotel":{"action":"search","city":"上海","check_in_date":"下周五","check_out_date":"下周五+3"},"flight":{"action":"search","origin":"上海","destination":"杭州","departure_date":"下周五+3","trip_type":"one_way"}},"missing_slots":[]}

用户:next Monday 去上海,订酒店
输出:{"schema_version":"travel_slot_extraction.v1","language":"mixed","domains":["hotel"],"slots":{"hotel":{"action":"search","city":"上海","check_in_date":"next Monday"}},"missing_slots":[]}

用户:这阵子想去广州,帮我看下深圳到广州的机票
输出:{"schema_version":"travel_slot_extraction.v1","language":"zh","domains":["flight"],"slots":{"flight":{"action":"search","origin":"深圳","destination":"广州","departure_date":"这阵子","trip_type":"one_way"}},"missing_slots":[]}

用户:8.20 日去杭州,当天往返
输出:{"schema_version":"travel_slot_extraction.v1","language":"zh","domains":["requisition"],"slots":{"requisition":{"mode":"create","destination":"杭州","start_date":"8.20","trip_type":"round_trip"}},"missing_slots":[]}

用户:下周三去杭州,周六回
输出:{"schema_version":"travel_slot_extraction.v1","language":"zh","domains":["flight"],"slots":{"flight":{"action":"search","destination":"杭州","departure_date":"下周三","return_date":"周六","trip_type":"round_trip"}},"missing_slots":[]}

用户:下周三去成都,待到周六,周六去西安待一天然后回杭州
输出:{"schema_version":"travel_slot_extraction.v1","language":"zh","domains":["requisition","flight"],"slots":{"requisition":{"mode":"create","destination":["成都","西安","杭州"],"start_date":"下周三","trip_type":"round_trip"},"flight":{"action":"search","destination":["成都","西安","杭州"],"departure_date":"下周三","multi_destination":true,"trip_type":"round_trip"}},"missing_slots":[]}

用户:open-jaw please: Shanghai to Tokyo next Monday, back from Osaka to Shanghai next Friday
输出:{"schema_version":"travel_slot_extraction.v1","language":"en","domains":["flight"],"slots":{"flight":{"action":"search","origin":"Shanghai","destination":["Tokyo","Osaka","Shanghai"],"departure_date":"next Monday","return_date":"next Friday","multi_destination":true,"trip_type":"round_trip"}},"missing_slots":[]}

只输出 JSON,不要多余文本。`
}

/**
 * language 的确定性判定(判定归代码层,不信模型):只看用户原话——
 * 含中文且含拉丁字母 → mixed;仅中文 → zh;仅拉丁 → en。
 * (对齐 golden:「next Thursday 去北京」=mixed;全英文带中文槽位值仍=en)
 */
export function detectLanguage(utterance: string): 'zh' | 'en' | 'mixed' {
  const hasCjk = /[一-鿿]/.test(utterance)
  const hasLatin = /[A-Za-z]/.test(utterance)
  if (hasCjk && hasLatin) return 'mixed'
  if (hasLatin) return 'en'
  return 'zh'
}

/** 模型原始 JSON → 规范化 v1 抽取结果(缺省补齐,域外键容忍;language 由 detectLanguage 覆写) */
export function normalizeExtraction(obj: Record<string, unknown>, utterance?: string): TravelSlotExtraction | null {
  const domains = obj['domains']
  if (!Array.isArray(domains) || domains.length === 0) return null
  const valid = domains.filter((d): d is SlotDomain => d === 'requisition' || d === 'flight' || d === 'hotel')
  if (valid.length === 0) return null
  const lang = obj['language']
  const slots = (obj['slots'] ?? {}) as TravelSlotExtraction['slots']
  const missing = obj['missing_slots']
  return {
    schema_version: 'travel_slot_extraction.v1',
    language: utterance !== undefined ? detectLanguage(utterance) : (lang === 'en' || lang === 'mixed' ? lang : 'zh'),
    domains: valid,
    slots,
    missing_slots: Array.isArray(missing) ? missing.map(String) : [],
  }
}

export interface ScoreResult {
  pass: boolean
  /** 致命差异(导致 fail) */
  diffs: string[]
  /** 非致命提示(actual 多出 expected 没有的槽位键等) */
  warnings: string[]
}

const sortedSet = (xs: string[]) => [...xs].sort()

/**
 * 评分器:case pass 的口径 = language 一致 + domains 集合一致 +
 * expected 的每个槽位键值在 actual 中精确命中(actual 多出的键只记 warning)+
 * missing_slots 集合一致。逐字保留语义下,值比较就是字符串精确比较。
 */
export function scoreExtraction(expected: TravelSlotExtraction, actual: TravelSlotExtraction): ScoreResult {
  const diffs: string[] = []
  const warnings: string[] = []

  if (expected.language !== actual.language) {
    diffs.push(`language: 期望 ${expected.language},实际 ${actual.language}`)
  }
  if (JSON.stringify(sortedSet(expected.domains)) !== JSON.stringify(sortedSet(actual.domains))) {
    diffs.push(`domains: 期望 [${sortedSet(expected.domains)}],实际 [${sortedSet(actual.domains)}]`)
  }
  for (const domain of expected.domains) {
    const exp = expected.slots[domain] as Record<string, unknown> | undefined
    const act = actual.slots[domain] as Record<string, unknown> | undefined
    if (!exp) continue
    if (!act) {
      diffs.push(`slots.${domain}: 实际缺失整个域`)
      continue
    }
    for (const [k, v] of Object.entries(exp)) {
      if (JSON.stringify(act[k]) !== JSON.stringify(v)) {
        diffs.push(`slots.${domain}.${k}: 期望 ${JSON.stringify(v)},实际 ${JSON.stringify(act[k])}`)
      }
    }
    for (const k of Object.keys(act)) {
      if (!(k in exp)) warnings.push(`slots.${domain}.${k}: 实际多出键 ${JSON.stringify(act[k])}`)
    }
  }
  if (JSON.stringify(sortedSet(expected.missing_slots)) !== JSON.stringify(sortedSet(actual.missing_slots))) {
    diffs.push(`missing_slots: 期望 [${expected.missing_slots}],实际 [${actual.missing_slots}]`)
  }
  return { pass: diffs.length === 0, diffs, warnings }
}
