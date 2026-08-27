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
  if (typeof query === 'string' && stringKey) return { [stringKey]: query } as T
  return {} as T
}
