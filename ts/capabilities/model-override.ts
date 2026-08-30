/**
 * LLM_MODEL 会话面覆盖(issue #77)。
 *
 * dsh settings 分层:schema 默认 < composition 配置(cordis patch)< 用户层
 *(~/.dsh/settings.yaml)。bin/gotry-inner.js 已把 LLM_MODEL 注入 composition
 * 层(agent-default-model 默认模型 + llm-deepseek 目录),但用户在 dsh web UI
 * 选过模型时,用户层压过 composition 层——单靠 patch,.env 承诺仍落空。
 *
 * 这里在 agent/request 瀑布(dsh-agent-loop 每次发起 LLM 请求前解析
 * provider/model 的闸口,dsh-agent installModelSelection 也在此处施加选择)挂
 * 监听,post-next 覆盖 provider/model:本插件随 cordis patch 在根组装载,先于
 * 任何 agent 创建;瀑布按注册序嵌套(先注册 = 最外层,post-next 最后生效),
 * 因此显式 .env 意图压过一切持久层选择。内存态零持久化,进程退即散,不改写
 * 用户 ~/.dsh 设置。
 *
 * GOTRY_LLM_MODEL 未设置时不挂监听:默认路径(组合配置或用户 web 设置)面不变。
 *
 * @module gotry/capabilities/model-override
 */

/** dsh-agent installModelSelection 同构的请求配置(自持类型,不引 dsh 依赖) */
export interface AgentRequestConfig {
  provider?: string
  model?: string
  reasoningEffort?: unknown
  [key: string]: unknown
}

export const MODEL_OVERRIDE_ENV = 'GOTRY_LLM_MODEL'

/** 可挂监听的最小 ctx 切面(与 cordis Context.on 同构;mock/极简宿主可直传) */
export interface ModelOverrideContext {
  on?: (event: string, listener: (payload: unknown, next: () => Promise<AgentRequestConfig>) => Promise<AgentRequestConfig>) => unknown
}

/**
 * 挂载模型覆盖;返回是否实际挂载(未设环境变量或 ctx 无事件总线时为 false)。
 * provider 固定 deepseek-official:llm-deepseek 是 gotry 组合里唯一持有
 * DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL 映射凭证的 provider 路由。
 */
export function installModelOverride(
  ctx: ModelOverrideContext,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const model = env[MODEL_OVERRIDE_ENV]
  if (!model || typeof ctx.on !== 'function') return false
  ctx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    // 与 installModelSelection 同语义:选中项无 effort 时清掉继承值,回落
    // provider 默认推理档——不把上一个模型的 effort 错配到被覆盖的模型上
    const { reasoningEffort: _inherited, ...rest } = resolved
    return { ...rest, provider: 'deepseek-official', model }
  })
  return true
}
