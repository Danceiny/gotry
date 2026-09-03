/**
 * 12306 火车站点适配器(2026-09-03,继 ctrip-hotel 后会话面第三通道):
 *   - entry:https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc&fs=<城市名,电报码>&ts=<...>&date=YYYY-MM-DD&flag=N,N,Y
 *     (电报码表官方站表全量校准 2026-09-03,129 城;曾纠出南宁 NIZ→NNZ 错码)
 *   - networkHints:kyfw leftTicket/query(负载均衡变体 queryG/queryZ/queryA 等全部命中)
 *   - 解析:leftTicket/query 返回 data.result[] 管道行(12306 经典 | 拼接格式)。
 *     **第一方校准(2026-09-03)**:字段索引与站名映射(data.map[电报码])逐一
 *     取自官方前端 queryLeftTicket_end_js.js 的 cN(result,map) 转换函数——旧版
 *     公开常识索引与官方现行映射不符(站名/座位桶全错),真会话前即纠;行级
 *     签名校验(车次码/时刻形态)继续兜住未来漂移:失配整行跳过,fail-visible
 *
 * 与机/酒通道的两点刻意差异:
 *   - 无登录闸:12306 余票查询是公开面(登录只关系下单),无账号数据过手;
 *     扩展照样只读被动嗅探(零写行为),证据链标注「公开查询面」
 *   - 列表接口不含票价:如实只呈现 车次/时刻/历时/余票,票价以 12306 落地页为准
 */

/** 城市电报码表(**官方口径校准 2026-09-03**:全部条目逐一核对自
 * kyfw.12306.cn/otn/resources/js/framework/station_name.js 官方全量站表
 * ——曾借此抓出南宁 NIZ→NNZ 错码;代表站规则=城市同名站,fs/ts 用城市码
 * 服务端扩到市内全部站。词表外 unresolved 逐字保留,调用方可显式传电报码
 * 覆盖——kyfw 查询页 URL 里的 fs=城市,XXX 三位码;核对快照见
 * data/stations-12306-verify.json) */
export const STATION_TELECODES: Record<string, string> = {
  "三亚": 'SEQ',
  "上海": 'SHH',
  "上饶": 'SRG',
  "东莞": 'RTQ',
  "中卫": 'ZWJ',
  "中山": 'ZSQ',
  "丽江": 'LHM',
  "乌鲁木齐": 'WAR',
  "乐山": 'IVW',
  "九江": 'JJG',
  "伊宁": 'YMR',
  "佛山": 'FSQ',
  "保山": 'BAM',
  "六盘水": 'UMW',
  "兰州": 'LZJ',
  "包头": 'BTC',
  "北京": 'BJP',
  "北海": 'BHZ',
  "十堰": 'SNN',
  "南京": 'NJH',
  "南充": 'NCW',
  "南宁": 'NNZ',
  "南昌": 'NCG',
  "南通": 'NUH',
  "南阳": 'NFF',
  "厦门": 'XMS',
  "台州": 'TEU',
  "合肥": 'HFH',
  "吉林": 'JLL',
  "吐鲁番": 'TFR',
  "呼和浩特": 'HHC',
  "咸阳": 'XYY',
  "哈密": 'HMR',
  "哈尔滨": 'HBB',
  "喀什": 'KSR',
  "嘉兴": 'JXH',
  "嘉峪关": 'JGJ',
  "大同": 'DTV',
  "大庆": 'DZX',
  "大理": 'DKM',
  "大连": 'DLT',
  "天水": 'TSJ',
  "天津": 'TJP',
  "太原": 'TYV',
  "宁波": 'NGH',
  "安顺": 'ASW',
  "宜宾": 'YKE',
  "宜昌": 'YCN',
  "宝鸡": 'BJY',
  "岳阳": 'YYQ',
  "常州": 'CZH',
  "常德": 'VGQ',
  "广州": 'GZQ',
  "库尔勒": 'KLR',
  "延安": 'YWY',
  "开封": 'KFF',
  "张掖": 'ZYJ',
  "徐州": 'XCH',
  "德阳": 'DYW',
  "惠州": 'HCQ',
  "成都": 'CDW',
  "扬州": 'YLH',
  "承德": 'CDP',
  "抚顺": 'FET',
  "拉萨": 'LSO',
  "揭阳": 'JYA',
  "新乡": 'XXF',
  "无锡": 'WGH',
  "日喀则": 'RKO',
  "昆明": 'KMM',
  "普洱": 'PEM',
  "景德镇": 'JCG',
  "曲靖": 'QJM',
  "杭州": 'HZH',
  "林芝": 'LZO',
  "柳州": 'LZZ',
  "株洲": 'ZZQ',
  "格尔木": 'GRO',
  "桂林": 'GLZ',
  "梧州": 'WZZ',
  "武汉": 'WHN',
  "汉中": 'HOY',
  "汕头": 'OTQ',
  "沈阳": 'SYT',
  "泉州": 'QYS',
  "泸州": 'LUE',
  "洛阳": 'LYF',
  "济南": 'JNK',
  "深圳": 'SZQ',
  "温州": 'RZH',
  "湛江": 'ZJZ',
  "漳州": 'ZUS',
  "潮州": 'CKQ',
  "牡丹江": 'MDB',
  "珠海": 'ZHQ',
  "盐城": 'AFH',
  "石家庄": 'SJP',
  "福州": 'FZS',
  "秦皇岛": 'QTP',
  "绍兴": 'SOH',
  "绵阳": 'MYW',
  "芜湖": 'WHH',
  "苏州": 'SZH',
  "茂名": 'MDQ',
  "莆田": 'PTS',
  "衡阳": 'HYQ',
  "襄阳": 'XFN',
  "西宁": 'XNO',
  "西安": 'XAY',
  "西昌": 'ECW',
  "贵阳": 'GIW',
  "赣州": 'GZG',
  "达州": 'RXW',
  "遵义": 'ZYE',
  "郑州": 'ZZF',
  "重庆": 'CUW',
  "金华": 'JBH',
  "银川": 'YIJ',
  "镇江": 'ZJH',
  "长春": 'CCT',
  "长沙": 'CSQ',
  "阜阳": 'FYH',
  "青岛": 'QDK',
  "鞍山": 'AST',
  "韶关": 'SNQ',
  "香格里拉": 'EUM',
  "香港": 'XJA',
  "齐齐哈尔": 'QHX',
  "龙岩": 'LYS',
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
  /** 出发/到达时刻(HH:MM;跨日由到达时刻本身表达,官方 DTO 无隔日字段) */
  depTime: string
  arrTime: string
  /** 历时(分钟) */
  durationMin: number
  /** Y=可预订 / N=不可 / 其他上游原话 */
  canWebBuy: string
  /** 余票分桶(第一方校准索引,见 SEAT_BUCKETS;值原样:数字 / 有 / 无 / --) */
  seats: Record<string, string>
  /** 查询落地页(由人选车完成预订;gotry 不碰) */
  jumpUrl?: string
}

/** 座位桶索引表(**第一方校准 2026-09-03**:逐字段取自 12306 官方前端
 * queryLeftTicket_end_js.js 的 cN(result,map) 转换函数——旧版公开常识索引
 * (19-28 段)与官方现行映射不符,首查前即纠);label=页面席别口径,未知席别
 * 保留上游字段 id 原样 */
const SEAT_BUCKETS: Array<{ index: number; field: string; label: string }> = [
  { index: 20, field: 'gg_num', label: '其他(通勤)' },
  { index: 21, field: 'gr_num', label: '高级软卧' },
  { index: 22, field: 'qt_num', label: '其他' },
  { index: 23, field: 'rw_num', label: '软卧(一等卧)' },
  { index: 24, field: 'rz_num', label: '软座' },
  { index: 25, field: 'tz_num', label: '特等座' },
  { index: 26, field: 'wz_num', label: '无座' },
  { index: 27, field: 'yb_num', label: 'yp_b(上游席别)' },
  { index: 28, field: 'yw_num', label: '硬卧(二等卧)' },
  { index: 29, field: 'yz_num', label: '硬座' },
  { index: 30, field: 'ze_num', label: '二等座' },
  { index: 31, field: 'zy_num', label: '一等座' },
  { index: 32, field: 'swz_num', label: '商务座' },
  { index: 33, field: 'srrb_num', label: '动卧' },
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
function rowToOption(row: string, stationMap: Record<string, string> | undefined, entryUrl: string): SessionTrainOption | null {
  const f = row.split('|')
  if (f.length < 34) return null
  const trainCode = (f[3] ?? '').trim()
  const depTime = (f[8] ?? '').trim()
  const arrTime = (f[9] ?? '').trim()
  if (!TRAIN_CODE_RE.test(trainCode) || !HHMM_RE.test(depTime) || !HHMM_RE.test(arrTime)) return null
  // 官方 cN 口径:站名 = data.map[电报码](map 缺失/缺键时退电报码原样,不猜名)
  const fromStation = stationMap?.[f[6] ?? ''] ?? (f[6] ?? '')
  const toStation = stationMap?.[f[7] ?? ''] ?? (f[7] ?? '')
  const seats: Record<string, string> = {}
  for (const b of SEAT_BUCKETS) {
    const v = (f[b.index] ?? '').trim()
    if (v && v !== '--') seats[b.label] = v
  }
  return {
    trainCode,
    fromStation,
    toStation,
    depTime,
    arrTime,
    durationMin: lishiToMin(f[10]),
    canWebBuy: (f[11] ?? '').trim(),
    seats,
    jumpUrl: entryUrl,
  }
}

/** 解析 leftTicket/query 响应(纯函数,fixture 测试锚点;字段索引与站名映射
 * 全部对齐 12306 官方前端 cN(result,map)——见 SEAT_BUCKETS 注释);
 * malformed 一律返空,不抛错 */
export function parseLeftTicketQuery(body: string, entryUrl: string, opts: { maxItems?: number } = {}): SessionTrainOption[] {
  let raw: { data?: { result?: unknown; map?: Record<string, string> } }
  try {
    raw = JSON.parse(body) as typeof raw
  } catch {
    return []
  }
  const rows = raw.data?.result
  if (!Array.isArray(rows)) return []
  const map = (raw.data?.map && typeof raw.data.map === 'object') ? raw.data.map : undefined
  const out: SessionTrainOption[] = []
  for (const r of rows) {
    if (typeof r !== 'string') continue
    const opt = rowToOption(r, map, entryUrl)
    if (opt) {
      out.push(opt)
      if (out.length >= (opts.maxItems ?? 30)) break
    }
  }
  return out
}
