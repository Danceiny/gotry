/** Provider-neutral execution and terminal contract for benchmark agents. */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  emitBenchmarkChildDiagnostic,
  type BenchmarkChildFailureCode,
} from './benchmark-headless-child-diagnostics.ts'

export const MAX_CONFORMANCE_RETRIES = 1 as const
export const BENCHMARK_BRIDGE_CALL_REQUIRED = 'BENCHMARK_BRIDGE_CALL_REQUIRED'
export const BENCHMARK_BRIDGE_CALL_FAILED = 'BENCHMARK_BRIDGE_CALL_FAILED'
export const BENCHMARK_BRIDGE_TIMED_OUT = 'BENCHMARK_BRIDGE_TIMED_OUT'
export const BENCHMARK_BRIDGE_RUNNER_FAILED = 'BENCHMARK_BRIDGE_RUNNER_FAILED'
export const BENCHMARK_BRIDGE_SPAWN_FAILED = 'BENCHMARK_BRIDGE_SPAWN_FAILED'
export const BENCHMARK_BRIDGE_OUTPUT_TRUNCATED = 'BENCHMARK_BRIDGE_OUTPUT_TRUNCATED'
export const BENCHMARK_TERMINAL_INVALID = 'BENCHMARK_TERMINAL_INVALID'
export const BENCHMARK_BRIDGE_RETRY_CALL_NOT_ALLOWED = 'BENCHMARK_BRIDGE_RETRY_CALL_NOT_ALLOWED'
export const BENCHMARK_CONFORMANCE_STATE_UNAVAILABLE = 'BENCHMARK_CONFORMANCE_STATE_UNAVAILABLE'

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]*$/
const MAX_TERMINAL_BYTES = 1024 * 1024

export interface TerminalOutputConfig {
  tag: string
  max_bytes: number
}

export type TerminalOutputValue =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: 'invalid_terminal_output' }

export interface BenchmarkBridgeProjection {
  readonly toolName: string
  readonly allowedTools: readonly string[]
  readonly terminal: Readonly<TerminalOutputConfig>
}

type RetryMode = 'none' | 'call' | 'terminal'

interface TurnState {
  readonly turn: number
  readonly validCallIds: Set<string>
  retryCount: number
  retryMode: RetryMode
  successfulResultStep?: number
  bridgeCallFailed: boolean
  bridgeFailureCode?: string
  retryRedispatchAttempted: boolean
  lastAssistant?: {
    step: number
    text: string
    interrupted: boolean
  }
}

export type BenchmarkConformanceDecision =
  | { kind: 'accept' }
  | { kind: 'steer'; mode: Exclude<RetryMode, 'none'> }
  | { kind: 'reject'; code: string }

export interface BenchmarkAgentConformance {
  readonly retryMode: RetryMode
  readonly retryCount: number
  observe(event: unknown): void
  stopping(turn: number): BenchmarkConformanceDecision
  guardBridgeExecution(): string | undefined
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateTerminalOutputConfig(value: unknown): value is TerminalOutputConfig {
  if (!plainObject(value)) return false
  const keys = Object.keys(value).sort()
  return JSON.stringify(keys) === JSON.stringify(['max_bytes', 'tag'])
    && typeof value.tag === 'string'
    && IDENTIFIER.test(value.tag)
    && typeof value.max_bytes === 'number'
    && Number.isInteger(value.max_bytes)
    && value.max_bytes >= 1
    && value.max_bytes <= MAX_TERMINAL_BYTES
}

function invalidTerminal(): TerminalOutputValue {
  return { ok: false, error: 'invalid_terminal_output' }
}

/** Parse exactly one configured tag pair containing one JSON object. */
export function parseBenchmarkTerminal(raw: string, config: TerminalOutputConfig): TerminalOutputValue {
  if (!validateTerminalOutputConfig(config)) return invalidTerminal()
  if (Buffer.byteLength(raw, 'utf8') > config.max_bytes) return invalidTerminal()

  const trimmed = raw.trim()
  const opening = `<${config.tag}>`
  const closing = `</${config.tag}>`
  if (!trimmed.startsWith(opening) || !trimmed.endsWith(closing)) return invalidTerminal()
  if (trimmed.indexOf(opening) !== trimmed.lastIndexOf(opening)
    || trimmed.indexOf(closing) !== trimmed.lastIndexOf(closing)) return invalidTerminal()
  const body = trimmed.slice(opening.length, -closing.length)
  if (body.length === 0 || body.includes('```')) return invalidTerminal()

  try {
    const value: unknown = JSON.parse(body)
    return plainObject(value) ? { ok: true, value } : invalidTerminal()
  } catch {
    return invalidTerminal()
  }
}

/** Backward-compatible name used by the bridge contract tests. */
export const validateTerminalOutput = parseBenchmarkTerminal

function eventData(event: unknown): { type: string; data: Record<string, unknown> } | undefined {
  if (!plainObject(event) || typeof event.type !== 'string' || !plainObject(event.data)) return undefined
  return { type: event.type, data: event.data }
}

function eventTurn(data: Record<string, unknown>): number | undefined {
  return typeof data.turn === 'number' && Number.isInteger(data.turn) ? data.turn : undefined
}

function parseToolArguments(value: unknown): Record<string, unknown> | undefined {
  if (plainObject(value)) return value
  if (typeof value !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return plainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function assistantText(data: Record<string, unknown>): { text: string; interrupted: boolean } | undefined {
  if (!plainObject(data.message) || !Array.isArray(data.message.content)) return undefined
  const text = data.message.content
    .filter(block => plainObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map(block => String((block as Record<string, unknown>).text))
    .join('')
  return { text, interrupted: data.interrupted === true }
}

function bridgeResultStatus(data: Record<string, unknown>, callId: string): { ok: true } | { ok: false; code: string } | undefined {
  if (!plainObject(data.message) || !plainObject(data.message.source)) return undefined
  if (data.message.source.callId !== callId || !Array.isArray(data.message.content)) return undefined
  const block = data.message.content.find(candidate => plainObject(candidate)
    && candidate.type === 'tool-result'
    && candidate.toolCallId === callId)
  if (!plainObject(block) || block.isError === true || !Array.isArray(block.content)) return undefined
  const text = block.content
    .filter(candidate => plainObject(candidate) && candidate.type === 'text' && typeof candidate.text === 'string')
    .map(candidate => String((candidate as Record<string, unknown>).text))
    .join('')
  try {
    const parsed: unknown = JSON.parse(text)
    if (!plainObject(parsed)) return undefined
    if (parsed.ok === true) return { ok: true }
    if (parsed.ok === false && typeof parsed.error === 'string') {
      const code = parsed.error === 'timed_out'
        ? BENCHMARK_BRIDGE_TIMED_OUT
        : parsed.error === 'runner_failed'
          ? BENCHMARK_BRIDGE_RUNNER_FAILED
          : parsed.error === 'spawn_failed'
            ? BENCHMARK_BRIDGE_SPAWN_FAILED
            : parsed.error === 'output_truncated'
              ? BENCHMARK_BRIDGE_OUTPUT_TRUNCATED
            : BENCHMARK_BRIDGE_CALL_FAILED
      return { ok: false, code }
    }
    return undefined
  } catch {
    return undefined
  }
}

export function benchmarkChildFailureForConformanceCode(code: string): BenchmarkChildFailureCode {
  if (code === BENCHMARK_BRIDGE_TIMED_OUT) return 'child_bridge_timed_out'
  if (code === BENCHMARK_BRIDGE_RUNNER_FAILED) return 'child_bridge_runner_failed'
  if (code === BENCHMARK_BRIDGE_SPAWN_FAILED) return 'child_bridge_spawn_failed'
  if (code === BENCHMARK_BRIDGE_OUTPUT_TRUNCATED) return 'child_bridge_output_truncated'
  if (code === BENCHMARK_BRIDGE_CALL_FAILED) return 'child_bridge_failure'
  return 'child_conformance_failure'
}

function newTurn(turn: number): TurnState {
  return {
    turn,
    validCallIds: new Set(),
    retryCount: 0,
    retryMode: 'none',
    bridgeCallFailed: false,
    retryRedispatchAttempted: false,
  }
}

/** Deterministic controller used by both runtime wiring and offline contracts. */
export function createBenchmarkAgentConformance(projection: BenchmarkBridgeProjection): BenchmarkAgentConformance {
  let state: TurnState | undefined

  const controller: BenchmarkAgentConformance = {
    get retryMode() { return state?.retryMode ?? 'none' },
    get retryCount() { return state?.retryCount ?? 0 },

    observe(rawEvent: unknown): void {
      const event = eventData(rawEvent)
      if (!event) return
      const turn = eventTurn(event.data)

      if (event.type === 'turn/start' && turn !== undefined) {
        state = newTurn(turn)
        return
      }
      if (event.type === 'turn/end') {
        if (state && turn === state.turn) state = undefined
        return
      }
      if (!state || turn !== state.turn) return

      if (event.type === 'tool/call') {
        if (event.data.name !== projection.toolName) return
        if (state.retryMode === 'terminal') {
          state.retryRedispatchAttempted = true
          return
        }
        if (typeof event.data.callId !== 'string') return
        const args = parseToolArguments(event.data.arguments)
        const query = args && plainObject(args.query) ? args.query : undefined
        if (query?.action === 'call'
          && typeof query.tool === 'string'
          && projection.allowedTools.includes(query.tool)) {
          state.validCallIds.add(event.data.callId)
        }
        return
      }

      if (event.type === 'tool/result') {
        if (!plainObject(event.data.message) || !plainObject(event.data.message.source)) return
        const callId = event.data.message.source.callId
        if (typeof callId !== 'string' || !state.validCallIds.has(callId)) return
        const resultStatus = bridgeResultStatus(event.data, callId)
        if (resultStatus?.ok === true) {
          state.successfulResultStep = typeof event.data.step === 'number'
            ? event.data.step
            : state.successfulResultStep
        } else {
          state.bridgeCallFailed = true
          state.bridgeFailureCode = resultStatus?.code ?? BENCHMARK_BRIDGE_CALL_FAILED
        }
        return
      }

      if (event.type === 'assistant/message') {
        const assistant = assistantText(event.data)
        if (!assistant || typeof event.data.step !== 'number') return
        state.lastAssistant = { step: event.data.step, ...assistant }
      }
    },

    stopping(turn: number): BenchmarkConformanceDecision {
      if (!state || state.turn !== turn) {
        return { kind: 'reject', code: BENCHMARK_CONFORMANCE_STATE_UNAVAILABLE }
      }
      if (state.retryRedispatchAttempted) {
        return { kind: 'reject', code: BENCHMARK_BRIDGE_RETRY_CALL_NOT_ALLOWED }
      }
      if (state.successfulResultStep === undefined) {
        if (state.bridgeCallFailed) {
          return { kind: 'reject', code: state.bridgeFailureCode ?? BENCHMARK_BRIDGE_CALL_FAILED }
        }
        if (state.retryCount >= MAX_CONFORMANCE_RETRIES) {
          return { kind: 'reject', code: BENCHMARK_BRIDGE_CALL_REQUIRED }
        }
        state.retryCount += 1
        state.retryMode = 'call'
        return { kind: 'steer', mode: 'call' }
      }

      const terminal = state.lastAssistant
      const terminalIsValid = terminal !== undefined
        && !terminal.interrupted
        && terminal.step > state.successfulResultStep
        && parseBenchmarkTerminal(terminal.text, projection.terminal).ok
      if (terminalIsValid) return { kind: 'accept' }
      if (state.retryCount >= MAX_CONFORMANCE_RETRIES) {
        return { kind: 'reject', code: BENCHMARK_TERMINAL_INVALID }
      }
      state.retryCount += 1
      state.retryMode = 'terminal'
      return { kind: 'steer', mode: 'terminal' }
    },

    guardBridgeExecution(): string | undefined {
      return state?.retryMode === 'terminal'
        ? BENCHMARK_BRIDGE_RETRY_CALL_NOT_ALLOWED
        : undefined
    },
  }
  return controller
}

type Disposer = () => void | Promise<void>
type ScopedAgent = {
  id?: unknown
  session?: object
  steer?: (message: unknown) => void
  ctx?: {
    tools?: { guard?: (check: (execution: { name: string }) => string | undefined) => unknown }
    effect?: (action: () => unknown, label?: string) => unknown
    on?: (event: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }) => unknown
  }
}
type EventBus = {
  on?: (event: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }) => unknown
}

function requireDisposer(value: unknown, capability: string): Disposer {
  if (typeof value !== 'function') throw new Error(`benchmark conformance ${capability} disposer unavailable`)
  return value as Disposer
}

function correctionMessage(mode: Exclude<RetryMode, 'none'>, projection: BenchmarkBridgeProjection) {
  const text = mode === 'call'
    ? `BENCHMARK_CONFORMANCE_CALL: Execute exactly one native ${projection.toolName} action:"call" now. Describing an intended CLI, shell, or Python command does not execute it.`
    : `BENCHMARK_CONFORMANCE_TERMINAL: Reuse the existing successful tool result. Do not call any tool. Reply only <${projection.terminal.tag}>{"result":"..."}</${projection.terminal.tag}> with one JSON object.`
  return createUserMessage({
    content: [{ type: 'text' as const, text }],
    source: { kind: 'plugin' as const, plugin: 'gotry-benchmark-agent-conformance' },
  })
}

function systemSection(projection: BenchmarkBridgeProjection): { name: string; text: string } {
  const allowed = projection.allowedTools.join(', ')
  return {
    name: 'benchmark:agent-conformance',
    text: [
      'Benchmark execution contract:',
      `- Translate every task instruction to use a CLI, shell, Python, or agent_env.cli into the native tool ${projection.toolName}; do not merely describe the intended command.`,
      `- Call it with exactly {"query":{"action":"call","tool":"<one of: ${allowed}>","arguments":{...}}}.`,
      '- action:"tools" is discovery only and does not satisfy the required environment call.',
      `- After a successful tool result, reply only <${projection.terminal.tag}>{...one JSON object...}</${projection.terminal.tag}> with no prose or code fence.`,
      '- If a terminal-format correction arrives, reuse the existing result and do not call the tool again.',
    ].join('\n'),
  }
}

/** Install conformance only after the exact benchmark bridge isolation layer. */
export function installBenchmarkAgentConformance(ctx: Context, projection: BenchmarkBridgeProjection): void {
  const bus = ctx as unknown as EventBus
  if (typeof bus.on !== 'function') throw new Error('benchmark conformance event bus unavailable')

  const byAgent = new WeakMap<object, BenchmarkAgentConformance>()
  const bySession = new WeakMap<object, BenchmarkAgentConformance>()

  bus.on('agent/created', (payload: { agent?: ScopedAgent }) => {
    const agent = payload.agent
    if (!agent || typeof agent !== 'object' || !agent.session) {
      throw new Error('benchmark conformance created agent unavailable')
    }
    if (typeof agent.steer !== 'function') throw new Error('benchmark conformance steering unavailable')
    if (typeof agent.ctx?.tools?.guard !== 'function') throw new Error('benchmark conformance scoped guard unavailable')
    if (typeof agent.ctx.effect !== 'function') throw new Error('benchmark conformance scoped effect unavailable')
    if (typeof agent.ctx.on !== 'function') throw new Error('benchmark conformance scoped event bus unavailable')

    const controller = createBenchmarkAgentConformance(projection)
    byAgent.set(agent, controller)
    bySession.set(agent.session, controller)
    try {
      requireDisposer(agent.ctx.effect.call(agent.ctx, function* () {
        yield requireDisposer(agent.ctx!.tools!.guard!(execution => {
          if (execution.name !== projection.toolName) return undefined
          return controller.guardBridgeExecution()
        }), 'scoped guard')
        yield requireDisposer(agent.ctx!.on!.call(agent.ctx, 'system-prompt/assemble', async (
          _assembly: unknown,
          _context: unknown,
          next?: () => Promise<unknown>,
        ) => {
          if (typeof next !== 'function') throw new Error('benchmark conformance assembly continuation unavailable')
          const result = await next()
          if (!plainObject(result)) throw new Error('benchmark conformance assembly result unavailable')
          const sections = Array.isArray(result.sections) ? result.sections : []
          return { ...result, sections: [...sections, systemSection(projection)] }
        }, { prepend: true }), 'scoped assembly listener')
      }, 'benchmark-agent-conformance'), 'scoped effect')
    } catch (error) {
      byAgent.delete(agent)
      bySession.delete(agent.session)
      throw error
    }
  })

  bus.on('session/event', (session: object, event: unknown) => {
    bySession.get(session)?.observe(event)
  })
  bus.on('session/disposed', (session: object) => {
    bySession.delete(session)
  })
  bus.on('agent/disposed', (payload: { agent?: ScopedAgent }) => {
    const agent = payload.agent
    if (!agent || typeof agent !== 'object') return
    byAgent.delete(agent)
    if (agent.session) bySession.delete(agent.session)
  })
  bus.on('agent/turn-stopping', (payload: { agent?: ScopedAgent; turn?: number }) => {
    const agent = payload.agent
    if (!agent || typeof agent !== 'object' || typeof payload.turn !== 'number') {
      emitBenchmarkChildDiagnostic('child_conformance_failure')
      throw new Error(BENCHMARK_CONFORMANCE_STATE_UNAVAILABLE)
    }
    const controller = byAgent.get(agent)
    if (!controller) {
      emitBenchmarkChildDiagnostic('child_conformance_failure')
      throw new Error(BENCHMARK_CONFORMANCE_STATE_UNAVAILABLE)
    }
    const decision = controller.stopping(payload.turn)
    if (decision.kind === 'reject') {
      emitBenchmarkChildDiagnostic(benchmarkChildFailureForConformanceCode(decision.code))
      throw new Error(decision.code)
    }
    if (decision.kind === 'steer') agent.steer!(correctionMessage(decision.mode, projection))
  }, { prepend: true })
}
