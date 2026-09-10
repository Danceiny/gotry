/**
 * tz-resolver(v1):IANA 时区权威路径的统一模型输入(Issue #343)。
 *
 * 设计动机:
 * - `ts/src/unified.ts` 既往消费 `tz_offset_min / origin_tz_offset_min / home_tz_offset_min` 数值,
 *   无法表达 DST/历史/未来规则。中国出境首发已跨区(Asia/Shanghai ↔ Asia/Tokyo),
 *   同一班次在不同时点 offset 不同,数值口径不可持续。
 * - 此模块只做 IANA zone + 当地日期 → 确定性 offset(分)。无网络无新依赖;
 *   Node24 内置 `Intl.DateTimeFormat` 已足够,并由其构造结果作为 zone authority。
 * - 不存在的"DST 跳过"墙时(spring forward gap)与"两次出现"的"DST 重复"墙时
 *   (fall back overlap)必须**显式拒绝**,不允许静默选边——这是 §acceptance 第 2 条。
 * - 结果不依赖 `Date.now`、机器时区或外部 IO;formatter 仅作 module-local cache,同一输入必给同一输出。
 *
 * 不变量:
 * - `offsetMin` 单位 = 分,正值 = 东向 UTC(Asia/Tokyo = +540)。
 * - 输入校验失败返回结构化失败;调用方显式决定是否拒绝。
 * - unknown zone / gap / overlap 用同名 `string` 字段区分(returned object 形态);
 *   调用方负责转 typed error。
 */

/**
 * 以同一份 formatter cache 作为 zone authority。
 * `Intl.supportedValuesOf` 不是完整 authority(例如 `US/Pacific` 等 alias 可能不列出),
 * 而 `Intl.DateTimeFormat` 会接受合法 alias 并拒绝 `Foo/Bar`。
 */
export function isKnownZoneLoose(zone: string): boolean {
  try {
    wallFormatter(zone)
    return true
  } catch {
    return false
  }
}

export type ResolveFailure =
  | { kind: 'unknown_zone'; zone: string }
  | { kind: 'malformed_input'; zone: string; reason: string }
  | { kind: 'gap_nonexistent'; zone: string; ymd: string; hhmm: string }
  | { kind: 'overlap_ambiguous'; zone: string; ymd: string; hhmm: string }

export interface ResolveSuccess {
  ok: true
  /** 正值 = 东向 UTC(分) */
  offsetMin: number
  /** UTC instant(epoch ms)对应此 wall time */
  utcMs: number
}

export type ResolveResult = ResolveSuccess | ({ ok: false } & ResolveFailure)

interface WallParts { year: number; month: number; day: number; hour: number; minute: number }

// 每个 zone 缓存一份 Intl.DateTimeFormat(root 要求:不要为每条候选 instant 重造)。
// Node 的 DateTimeFormat 本身不可缓存结果(因 ms 输入不同),但实例可重用(无外部 IO)。
const FMT_CACHE: Map<string, Intl.DateTimeFormat> = new Map()

function wallFormatter(zone: string): Intl.DateTimeFormat {
  let f = FMT_CACHE.get(zone)
  if (f) return f
  f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  })
  FMT_CACHE.set(zone, f)
  return f
}

/** UTC instant → 该 zone 的墙时分量。导出用于 workWindowBlocks 把 depUtcMs 投影到 home zone。 */
export function readWallParts(zone: string, ms: number): WallParts {
  const parts = wallFormatter(zone).formatToParts(new Date(ms))
  const out: Record<string, string> = {}
  for (const p of parts) out[p.type] = p.value
  // Intl en-US hour12:false 在午夜 0:00 有时给 "24";规范化回 "00"
  let hour = Number(out.hour)
  if (hour === 24) hour = 0
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour,
    minute: Number(out.minute),
  }
}

/** wall 时分量 → ISO yyyy-mm-dd hh:mm 表示(供 parseFlightPackToSpecV2 work window 用)。 */
export function wallPartsToIso(p: WallParts): { ymd: string; hhmm: string } {
  return {
    ymd: `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`,
    hhmm: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`,
  }
}

function wallEqual(a: WallParts, b: WallParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute
}

/**
 * IANA zone + 当地日期 + 当地时间 → 确定性 offset(分)与对应 UTC instant。
 *
 * 失败 4 类:
 *   unknown_zone        — `Intl.DateTimeFormat` 不接受该 zone。
 *   malformed_input     — ymd / hhmm 解析失败或非法(wall 不存在的月日,如 2-30)。
 *   gap_nonexistent     — DST spring-forward 跳过该墙时(墙上 02:30 不存在)。
 *   overlap_ambiguous   — DST fall-back 重复该墙时(墙上 01:30 发生两次)。
 *
 * 实现要点:
 *   - 把 ymd/hhmm 当作 UTC 算 epoch 得到候选点 `wallAsUtcMs`;
 *   - 计算该候选点 offset 用 longOffset 解析,得到"大概"UTC;
 *   - 在 ±14h 内以 1 分步长扫描,统计能映射回同一 wall 的候选数:
 *       0 → gap;1 → 唯一;≥2 → overlap。
 *   - 唯一候选 offset 即结果。
 */
export function resolveOffsetForLocalDate(zone: string, ymd: string, hhmm: string): ResolveResult {
  if (!isKnownZoneLoose(zone)) return { ok: false, kind: 'unknown_zone', zone }

  const dateMatch = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!dateMatch) return { ok: false, kind: 'malformed_input', zone, reason: `bad date ${ymd}` }
  const timeMatch = hhmm.match(/^(\d{2}):(\d{2})$/)
  if (!timeMatch) return { ok: false, kind: 'malformed_input', zone, reason: `bad time ${hhmm}` }

  const y = Number(dateMatch[1])
  const mo = Number(dateMatch[2])
  const d = Number(dateMatch[3])
  const h = Number(timeMatch[1])
  const mi = Number(timeMatch[2])
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23 || mi < 0 || mi > 59) {
    return { ok: false, kind: 'malformed_input', zone, reason: `out-of-range ${ymd} ${hhmm}` }
  }

  const want: WallParts = { year: y, month: mo, day: d, hour: h, minute: mi }
  const wallAsUtcMs = Date.UTC(y, mo - 1, d, h, mi)

  // ±14h 1-min 步长扫描;此范围覆盖全球 ±14:00 时区(含政治区)+ DST 1-2h 偏移
  const matches: Array<{ offsetMin: number; utcMs: number }> = []
  for (let offMin = -14 * 60; offMin <= 14 * 60; offMin++) {
    // 假 wall 是 UTC,实际 UTC 与 wall 相差 offMin 分钟。
    // wall = UTC + offMin ⇒ UTC = wall - offMin。
    const ms = wallAsUtcMs - offMin * 60_000
    const local = readWallParts(zone, ms)
    if (wallEqual(local, want)) {
      matches.push({ offsetMin: offMin, utcMs: ms })
    }
  }

  if (matches.length === 0) return { ok: false, kind: 'gap_nonexistent', zone, ymd, hhmm }
  if (matches.length > 1) return { ok: false, kind: 'overlap_ambiguous', zone, ymd, hhmm }

  return { ok: true, offsetMin: matches[0].offsetMin, utcMs: matches[0].utcMs }
}

/**
 * 仅取 offset(分),不返回 utcMs;若失败给出失败描述字符串(便于 wire 到 red_flags / unsat_core)。
 *
 * `unknown != null` 语义在调用方需要的场景(差异日志)很贵,故另开轻 API;
 * 主路径应使用 `resolveOffsetForLocalDate` 的 discriminated union。
 */
export function describeResolveFailure(f: ResolveFailure): string {
  switch (f.kind) {
    case 'unknown_zone': return `unknown IANA zone: ${f.zone}`
    case 'malformed_input': return `malformed input (${f.reason}) for zone ${f.zone}`
    case 'gap_nonexistent': return `DST gap (wall time skipped) in ${f.zone} at ${f.ymd} ${f.hhmm}`
    case 'overlap_ambiguous': return `DST overlap (wall time ambiguous) in ${f.zone} at ${f.ymd} ${f.hhmm}`
  }
}
