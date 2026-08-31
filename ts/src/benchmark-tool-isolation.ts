import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'

const BRIDGE_TOOL = 'gotry_benchmark_environment'
const DENIED = 'BENCHMARK_TOOL_NOT_ALLOWED'
const SURFACE_VIOLATION = 'BENCHMARK_TOOL_SURFACE_VIOLATION'

type Disposer = () => void | Promise<void>
type ScopedTools = {
  restrict?: (filter: { allow: string[] }) => unknown
  guard?: (check: (execution: { name: string; agent?: unknown; [key: string]: unknown }) => string | undefined) => unknown
  presentAs?: (mode: 'native') => unknown
}
type Agent = {
  ctx?: {
    tools?: ScopedTools
    effect?: (action: () => unknown, label?: string) => unknown
    on?: (event: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }) => unknown
  }
}
type RootTools = {
  get?: (name: string, agent?: unknown) => unknown
  schemas?: (agent?: unknown) => unknown
}
type EventBus = {
  on?: (event: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }) => unknown
  effect?: (action: () => unknown, label?: string) => unknown
}

function requireDisposer(value: unknown, capability: string): Disposer {
  if (typeof value !== 'function') throw new Error(`benchmark environment ${capability} disposer unavailable`)
  return value as Disposer
}

/** Install the benchmark bridge's fail-closed, exact-tool per-agent boundary. */
export function installBenchmarkToolIsolation(ctx: Context): void {
  const rootTools = ctx.tools as unknown as RootTools
  if (typeof rootTools.get !== 'function') throw new Error('benchmark environment root tool lookup unavailable')
  if (typeof rootTools.schemas !== 'function') throw new Error('benchmark environment root tool schemas unavailable')
  const bridgeDefinition = rootTools.get(BRIDGE_TOOL)
  if (!bridgeDefinition) throw new Error('benchmark environment bridge definition unavailable')
  const rootSchemas = rootTools.schemas()
  const expected = Array.isArray(rootSchemas)
    ? rootSchemas.filter(schema => schema && typeof schema === 'object' && (schema as { name?: unknown }).name === BRIDGE_TOOL)
    : []
  if (expected.length !== 1) throw new Error('benchmark environment bridge schema unavailable')
  const expectedSchemas = structuredClone(expected)

  const getService = (ctx as unknown as { get?: (name: string) => unknown }).get
  const agents = typeof getService === 'function'
    ? getService.call(ctx, 'agents')
    : (ctx as unknown as { agents?: unknown }).agents
  const listAgents = (agents as { list?: () => unknown[] } | undefined)?.list
  if (typeof listAgents !== 'function') throw new Error('benchmark environment agent registry unavailable')
  if (listAgents.call(agents).length > 0) throw new Error('benchmark environment isolation requires cold-start; live agents are not allowed')

  const bus = ctx as unknown as EventBus
  if (typeof bus.on !== 'function') throw new Error('benchmark environment isolation event bus unavailable')
  if (typeof bus.effect !== 'function') throw new Error('benchmark environment isolation effect unavailable')

  const active = new Map<unknown, Disposer>()
  let stopping = false
  const assertSurface = (agent: unknown, schemas: unknown = rootTools.schemas!(agent)): void => {
    if (!active.has(agent)
      || rootTools.get!(BRIDGE_TOOL, agent) !== bridgeDefinition
      || !isDeepStrictEqual(schemas, expectedSchemas)) {
      throw new Error(SURFACE_VIOLATION)
    }
  }
  const take = (agent: unknown): void | Promise<void> => {
    const dispose = active.get(agent)
    if (!dispose) return
    active.delete(agent)
    return dispose()
  }

  requireDisposer(bus.effect(function* () {
    yield requireDisposer(bus.on!('agent/created', (payload: { agent?: Agent }) => {
      if (stopping) throw new Error(SURFACE_VIOLATION)
      const agent = payload.agent
      const tools = agent?.ctx?.tools
      const agentEffect = agent?.ctx?.effect
      const agentOn = agent?.ctx?.on
      if (!agent) throw new Error('benchmark environment created agent unavailable')
      if (typeof tools?.restrict !== 'function') throw new Error('benchmark environment scoped restrict unavailable')
      if (typeof tools.guard !== 'function') throw new Error('benchmark environment scoped guard unavailable')
      if (typeof tools.presentAs !== 'function') throw new Error('benchmark environment scoped presentAs unavailable')
      if (typeof agentEffect !== 'function') throw new Error('benchmark environment scoped effect unavailable')
      if (typeof agentOn !== 'function') throw new Error('benchmark environment scoped event bus unavailable')
      if (active.has(agent)) throw new Error('benchmark environment duplicate agent isolation')

      let owned: Disposer | undefined
      owned = requireDisposer(agentEffect.call(agent.ctx, function* () {
        yield () => {
          if (active.get(agent) === owned) active.delete(agent)
        }
        yield requireDisposer(tools.guard!(execution => {
          if (stopping || execution.name !== BRIDGE_TOOL || !execution.agent) return DENIED
          return rootTools.get!(BRIDGE_TOOL, execution.agent) === bridgeDefinition ? undefined : DENIED
        }), 'scoped guard')
        yield requireDisposer(agentOn.call(agent.ctx, 'system-prompt/assemble', async (
          _assembly: unknown,
          _context: unknown,
          next?: () => Promise<unknown>,
        ) => {
          if (stopping) throw new Error(SURFACE_VIOLATION)
          if (typeof next !== 'function') throw new Error('benchmark environment scoped assembly continuation unavailable')
          const result = await next()
          if (stopping) throw new Error(SURFACE_VIOLATION)
          return result
        }, { prepend: true }), 'scoped assembly listener')
        yield requireDisposer(tools.presentAs!('native'), 'scoped presentAs')
        yield requireDisposer(tools.restrict!({ allow: [BRIDGE_TOOL] }), 'scoped restrict')
      }, 'benchmark-environment-agent-tool-isolation'), 'scoped effect')
      active.set(agent, owned)
      try {
        assertSurface(agent)
      } catch (error) {
        try {
          const pending = take(agent)
          pending?.catch(() => undefined)
        } catch {
          // Preserve the stable admission error after invoking the owned cleanup.
        }
        throw error
      }
    }), 'agent/created listener')

    yield requireDisposer(bus.on!('agent/disposed', (payload: { agent?: unknown }) => {
      if (payload.agent) return take(payload.agent)
    }), 'agent/disposed listener')

    yield requireDisposer(bus.on!('system-prompt/assemble', async (
      _assembly: unknown,
      context: { agent?: unknown; scope?: unknown } | undefined,
      next?: () => Promise<unknown>,
    ) => {
      if (typeof next !== 'function') throw new Error('benchmark environment assembly continuation unavailable')
      const result = await next()
      const agent = context?.agent
      if (!agent) return result
      if (stopping || context?.scope !== agent || !result || typeof result !== 'object') throw new Error(SURFACE_VIOLATION)
      assertSurface(agent, (result as { tools?: unknown }).tools)
      return result
    }, { prepend: true }), 'system-prompt/assemble listener')

    yield requireDisposer(bus.on!('agent/pre-step', async (
      payload: { agent?: unknown },
      next?: () => Promise<unknown>,
    ) => {
      if (typeof next !== 'function') throw new Error('benchmark environment pre-step continuation unavailable')
      const decision = await next()
      const agent = payload.agent
      if (stopping || !agent) throw new Error(SURFACE_VIOLATION)
      assertSurface(agent)
      return decision
    }, { prepend: true }), 'agent/pre-step listener')

    yield () => {
      // The agent fiber, not this plugin fiber, owns scoped effects. On HMR the
      // live agent must remain quarantined until its own disposal/process exit.
      active.clear()
    }
    yield () => { stopping = true }
  }, 'benchmark-environment-tool-isolation'), 'root effect')
}
