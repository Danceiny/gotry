/**
 * 工具调用 packet 纪律(RFC S1,loopx agent-loop-effect-interpreter 映射):
 * 每次工具交互 = effect_request(args) → interpretation(interpretArgs)→ observation(返回值)。
 *
 * envelope 是**平铺**的(house style,与 guardToolExecute 兜底同形):
 *  - 成功:{ ok: true, ...payload } —— 渲染/调用方按字段读,不受扰;
 *  - 失败:{ ok: false, summary, evidence? } —— guard 异常降级天然就是这一支。
 * Handler 是数据不是 callable:observation 必须可 JSON 序列化(跨 dsh/cordis 边界)。
 */

/** 失败分支(guardToolExecute 兜底与工具显式失败共用此形状) */
export interface ToolFailure {
  ok: false
  summary: string
  evidence?: string
}

/** 成功分支:业务载荷平铺 + ok:true 标记 */
export type GotryObservation<T extends object> = (T & { ok: true }) | ToolFailure

/**
 * 参数归一(interpretation 层):dsh 模型侧对 query 包装参数的三种形态——
 * ① 包装对象 { query: {...} } ② 裸对象(平铺字段) ③ 字符串(按主键收)。
 * 唯一归一入口;工具面不再各自猜形状。
 */
export function interpretArgs<T extends Record<string, unknown>>(args: { query?: unknown } & Record<string, unknown>, stringKey?: string): T {
  if (args.query && typeof args.query === 'object') return args.query as T
  const { query, ...rest } = args as Record<string, unknown>
  if (Object.keys(rest).length > 0) return rest as T
  if (typeof query === 'string') {
    // ⑤ JSON 字符串形态(传输层把对象参数 stringify 后塞进 query):先尝试解析回对象
    if (query.trimStart().startsWith('{')) {
      try {
        const parsed = JSON.parse(query) as Record<string, unknown>
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) return parsed as T
      } catch { /* 非合法 JSON 落到后续形态 */ }
    }
    // ④ XML 标签串形态(dsh/部分模型把 JSON 参数序列化为 <k>v</k> 串):
    //    <hotelId>900000001</hotelId><checkIn>2026-10-10</checkIn> → {hotelId,checkIn}
    //    值域先试 JSON.parse(数字/对象复原),失败留字符串;数字字符串由能力层强转兜底
    if (/^\s*<[a-zA-Z][^>]*>/.test(query)) {
      const out: Record<string, unknown> = {}
      const re = /<([a-zA-Z][a-zA-Z0-9_]*)>([\s\S]*?)<\/\1>/g
      let m: RegExpExecArray | null
      while ((m = re.exec(query)) !== null) {
        const raw = m[2].trim()
        if (raw === '') continue
        try { out[m[1]] = JSON.parse(raw) } catch { out[m[1]] = raw }
      }
      if (Object.keys(out).length > 0) return out as T
    }
    if (stringKey) return { [stringKey]: query } as T
  }
  return {} as T
}
