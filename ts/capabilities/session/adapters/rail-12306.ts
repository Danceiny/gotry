/**
 * 12306 火车站点适配器(2026-09-03,继 ctrip-hotel 后会话面第三通道):
 *   - entry:https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=<城市名,电报码>&ts=<...>&date=YYYY-MM-DD&flag=N,N,Y
 *   - networkHints:kyfw leftTicket/query(负载均衡变体 queryG/queryZ/queryA 等全部命中)
 *   - 解析:leftTicket/query 返回 data.result[] 管道行(12306 经典 | 拼接格式,
 *     字段索引表为公开常识口径——**D-13:首个真会话后校准**,行级签名校验兜住
 *     索引漂移:车次码/时刻形态不符即整行跳过,fail-visible 不造数)
 *
 * 与机/酒通道的两点刻意差异:
 *   - 无登录闸:12306 余票查询是公开面(登录只关系下单),无账号数据过手;
 *     扩展照样只读被动嗅探(零写行为),证据链标注「公开查询面」
 *   - 列表接口不含票价:如实只呈现 车次/时刻/历时/余票,票价以 12306 落地页为准
 */

/** 城市电报码起步集(D-13 公开常识口径;12306 fs/ts 用城市码,服务端扩到市内全部站;
 * 词表外 unresolved 逐字保留,调用方可显式传电报码覆盖——kyfw 查询页 URL 里的 fs=城市,XXX) */
const STATION_TELECODES: Record<string, string> = {
  北京: 'BJP', 上海: 'SHH', 广州: 'GZQ', 深圳: 'SZQ', 天津: 'TJP',
  杭州: 'HZH', 南京: 'NJH', 武汉: 'WHN', 成都: 'CDW', 重庆: 'CUW',
  西安: 'XAY', 郑州: 'ZZF', 长沙: 'CSQ', 青岛: 'QDK', 昆明: 'KMM',
  厦门: 'XMS', 苏州: 'SZH', 济南: 'JNK', 合肥: 'HFH', 福州: 'FZS',
  哈尔滨: 'HBB', 沈阳: 'SYT', 长春: 'CCT', 大连: 'DLT', 贵阳: 'GIW',
  南宁: 'NIZ', 兰州: 'LZJ', 石家庄: 'SJP', 太原: 'TYV', 南昌: 'NCG',
  无锡: 'WGH', 三亚: 'SEQ',
}

export interface TrainEntryQuery {
  from: string
  to: string
  /** YYYY-MM-DD */
  date: string
  /** 显式城市电报码(覆盖码表;kyfw 查询页 URL fs=城市,XXX 的三位码) */
  fromStationTelecode?: string
  toStationTelecode?: string
}

export interface AdapterEntry {
  ok: boolean
  url?: string
  unresolved?: string[]
}

export function buildTrainEntryUrl(q: TrainEntryQuery): AdapterEntry {
  const unresolved: string[] = []
  const fromTc = (q.fromStationTelecode ?? '').trim().toUpperCase() || STATION_TELECODES[q.from.trim()]
  const toTc = (q.toStationTelecode ?? '').trim().toUpperCase() || STATION_TELECODES[q.to.trim()]
  if (!fromTc) unresolved.push(q.from)
  if (!toTc) unresolved.push(q.to)
  if (unresolved.length > 0 || !/^\d{4}-\d{2}-\d{2}$/.test(q.date)) {
    return { ok: false, unresolved: unresolved.length > 0 ? unresolved : [q.date] }
  }
  const fs = encodeURIComponent(`${q.from.trim()},${fromTc}`)
  const ts = encodeURIComponent(`${q.to.trim()},${toTc}`)
  return { ok: true, url: `https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=${fs}&ts=${ts}&date=${q.date}&flag=N,N,Y` }
}

/** networkHints:余票查询 XHR(queryG/Z/A/U 等负载均衡变体全命中) */
export const TRAIN_NETWORK_HINTS = [/leftTicket\/query/i]

/** 12306 页域(content_scripts 注入面与 background 白名单的对账源) */
export const TRAIN_SITE_HOST = 'kyfw.12306.cn'

export interface SessionTrainOption {
  /** 车次(G1375 / K79 等) */
  trainCode: string
  fromStation: string
  toStation: string
  /** 出发/到达时刻(HH:MM;跨日由 arriveDayDiff 表达) */
  depTime: string
  arrTime: string
  /** 历时(分钟) */
  durationMin: number
  /** 到达隔日数(0=当日,1=次日…) */
  arriveDayDiff?: number
  /** Y=可预订 / N=不可 / 其他上游原话 */
  canWebBuy: string
  /** 余票分桶(公开常识索引口径,D-13;值原样:数字 / 有 / 无 / 空) */
  seats: Record<string, string>
  /** 查询落地页(由人选车完成预订;gotry 不碰) */
  jumpUrl?: string
}

/** 座位桶索引表(公开常识口径,D-13 首个真会话后校准;解析时行级越界安全跳过) */
const SEAT_BUCKETS: Array<{ index: number; label: string }> = [
  { index: 19, label: '商务座' },
  { index: 20, label: '一等座' },
  { index: 21, label: '高级软卧' },
  { index: 22, label: '二等座' },
  { index: 23, label: '软卧' },
  { index: 24, label: '动卧' },
  { index: 25, label: '硬卧' },
  { index: 26, label: '无座' },
  { index: 27, label: '其他' },
  { index: 28, label: '硬座' },
]

const TRAIN_CODE_RE = /^[GDCZTKYLSF]\d{1,5}[A-Z]?$/i
const HHMM_RE = /^\d{2}:\d{2}$/

/** 历时 "07:52" → 分钟 */
function lishiToMin(s: string | undefined): number {
  const m = /^(\d{1,3}):(\d{2})$/.exec((s ?? '').trim())
  if (!m) return 0
  return Number(m[1]) * 60 + Number(m[2])
}

/** 行级签名:车次码形态 + 时刻形态不符即整行跳过(索引漂移 fail-visible,不造数) */
function rowToOption(row: string, entryUrl: string): SessionTrainOption | null {
  const f = row.split('|')
  if (f.length < 29) return null
  const trainCode = (f[3] ?? '').trim()
  const depTime = (f[8] ?? '').trim()
  const arrTime = (f[9] ?? '').trim()
  if (!TRAIN_CODE_RE.test(trainCode) || !HHMM_RE.test(depTime) || !HHMM_RE.test(arrTime)) return null
  const seats: Record<string, string> = {}
  for (const b of SEAT_BUCKETS) {
    const v = (f[b.index] ?? '').trim()
    if (v) seats[b.label] = v
  }
  return {
    trainCode,
    fromStation: (f[15] ?? '').trim(),
    toStation: (f[16] ?? '').trim(),
    depTime,
    arrTime,
    durationMin: lishiToMin(f[10]),
    arriveDayDiff: /^\d+$/.test((f[17] ?? '').trim()) ? Number(f[17]) : undefined,
    canWebBuy: (f[11] ?? '').trim(),
    seats,
    jumpUrl: entryUrl,
  }
}

/** 解析 leftTicket/query 响应(纯函数,fixture 测试锚点);malformed 一律返空,不抛错 */
export function parseLeftTicketQuery(body: string, entryUrl: string, opts: { maxItems?: number } = {}): SessionTrainOption[] {
  let raw: { data?: { result?: unknown } }
  try {
    raw = JSON.parse(body) as typeof raw
  } catch {
    return []
  }
  const rows = raw.data?.result
  if (!Array.isArray(rows)) return []
  const out: SessionTrainOption[] = []
  for (const r of rows) {
    if (typeof r !== 'string') continue
    const opt = rowToOption(r, entryUrl)
    if (opt) {
      out.push(opt)
      if (out.length >= (opts.maxItems ?? 30)) break
    }
  }
  return out
}
