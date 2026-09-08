/** Provider-neutral execution and terminal contract for benchmark agents. */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  classifyBenchmarkTurnEnd,
  createBenchmarkDiagnosticArbiter,
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
const BENCHMARK_TOOL_RESULT_SCHEMA_VERSION = 'gotry_benchmark_tool_result_v1'
const BENCHMARK_DOMAIN_RECOVERIES = new Set(['none', 'retry_same', 'revise_arguments', 'choose_alternative'])

// Round 12(issue #215):terminal body schema 是「无数据值的 closed 结构合同」——
// 只允许结构关键字(type/properties/required/additionalProperties/items),enum/
// const/example/default 等可夹带数据值的注解面一律禁止,对象必须 additionalProperties:
// false,大小/深度/节点数有界。校验语义 fail-closed:不补键、不删多余键、不转类型。
const TERMINAL_BODY_SCHEMA_MAX_BYTES = 16 * 1024
const TERMINAL_BODY_SCHEMA_MAX_DEPTH = 8
const TERMINAL_BODY_SCHEMA_MAX_NODES = 256
const TERMINAL_BODY_SCHEMA_MAX_PROPERTIES = 256
const TERMINAL_BODY_SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])
const TERMINAL_BODY_VALUE_MAX_NODES = 10_000
const TERMINAL_BODY_VALUE_MAX_DEPTH = 24

/** Structural-only, closed JSON schema for the terminal body (no data-bearing keywords). */
export type TerminalBodySchema = {
  type: 'object'
  properties: Record<string, TerminalBodySchema>
  required: string[]
  additionalProperties: false
} | {
  type: 'array'
  items: TerminalBodySchema
} | {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'null'
}

export interface TerminalOutputConfig {
  tag: string
  max_bytes: number
  body_schema: TerminalBodySchema
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
  domainOutcomeStep?: number
  lastBridgeResponseStep?: number
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
  return JSON.stringify(keys) === JSON.stringify(['body_schema', 'max_bytes', 'tag'])
    && typeof value.tag === 'string'
    && IDENTIFIER.test(value.tag)
    && typeof value.max_bytes === 'number'
    && Number.isInteger(value.max_bytes)
    && value.max_bytes >= 1
    && value.max_bytes <= MAX_TERMINAL_BYTES
    && validateTerminalBodySchema(value.body_schema)
}

/** Accept only the closed structural dialect: exact keyword sets per node, bounded size. */
export function validateTerminalBodySchema(value: unknown): value is TerminalBodySchema {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return false
  }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > TERMINAL_BODY_SCHEMA_MAX_BYTES) return false
  const pending: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }]
  const seen = new Set<object>()
  let nodes = 0
  let properties = 0
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!
    if (!plainObject(node) || seen.has(node) || ++nodes > TERMINAL_BODY_SCHEMA_MAX_NODES || depth > TERMINAL_BODY_SCHEMA_MAX_DEPTH) return false
    seen.add(node)
    const type = node.type
    if (type === 'object') {
      if (!exactKeys(node, ['type', 'properties', 'required', 'additionalProperties'])
        || !plainObject(node.properties)
        || !Array.isArray(node.required)
        || node.additionalProperties !== false) return false
      const entries = Object.entries(node.properties)
      properties += entries.length
      if (properties > TERMINAL_BODY_SCHEMA_MAX_PROPERTIES
        || entries.some(([key, child]) => key.length === 0 || key.length > 64 || !plainObject(child))) return false
      if (node.required.length > entries.length
        || new Set(node.required).size !== node.required.length
        || node.required.some(key => typeof key !== 'string' || !Object.hasOwn(node.properties as Record<string, unknown>, key))) return false
      for (const [, child] of entries) pending.push({ node: child, depth: depth + 1 })
      continue
    }
    if (type === 'array') {
      if (!exactKeys(node, ['type', 'items']) || !plainObject(node.items)) return false
      pending.push({ node: node.items, depth: depth + 1 })
      continue
    }
    if (typeof type !== 'string' || !TERMINAL_BODY_SCALAR_TYPES.has(type) || !exactKeys(node, ['type'])) return false
  }
  return plainObject(value) && value.type === 'object'
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

/** Strict structural validation: exact keys, exact types, no coercion, no autofix. */
export function validateTerminalBodyValue(value: unknown, schema: TerminalBodySchema): boolean {
  const pending: Array<{ value: unknown; schema: TerminalBodySchema; depth: number }> = [{ value, schema, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    if (++nodes > TERMINAL_BODY_VALUE_MAX_NODES || current.depth > TERMINAL_BODY_VALUE_MAX_DEPTH) return false
    const { schema: node } = current
    if (node.type === 'object') {
      const record = current.value
      if (!plainObject(record)) return false
      const properties = node.properties as Record<string, TerminalBodySchema>
      for (const key of node.required) {
        if (!Object.hasOwn(record, key)) return false
      }
      for (const [key, child] of Object.entries(record)) {
        const childSchema = properties[key]
        if (!childSchema) return false
        pending.push({ value: child, schema: childSchema, depth: current.depth + 1 })
      }
      continue
    }
    if (node.type === 'array') {
      if (!Array.isArray(current.value)) return false
      for (const item of current.value) pending.push({ value: item, schema: node.items, depth: current.depth + 1 })
      continue
    }
    if (node.type === 'string') { if (typeof current.value !== 'string') return false; continue }
    if (node.type === 'boolean') { if (typeof current.value !== 'boolean') return false; continue }
    if (node.type === 'null') { if (current.value !== null) return false; continue }
    if (node.type === 'integer') { if (typeof current.value !== 'number' || !Number.isSafeInteger(current.value)) return false; continue }
    if (typeof current.value !== 'number' || !Number.isFinite(current.value)) return false
  }
  return true
}

/** Deterministic single-source structural outline projected into system prompt and correction alike. */
export function terminalSchemaOutline(schema: TerminalBodySchema): string {
  const render = (node: TerminalBodySchema, depth: number): string => {
    if (depth > TERMINAL_BODY_SCHEMA_MAX_DEPTH) return '…'
    if (node.type === 'object') {
      const properties = node.properties as Record<string, TerminalBodySchema>
      const required = new Set(node.required)
      const parts = Object.entries(properties).map(([key, child]) => `${required.has(key) ? '' : '?'}${key}:${render(child, depth + 1)}`)
      return `object{${parts.join(',')}}`
    }
    if (node.type === 'array') return `array<${render(node.items, depth + 1)}>`
    return node.type
  }
  return render(schema, 0)
}

function invalidTerminal(): TerminalOutputValue {
  return { ok: false, error: 'invalid_terminal_output' }
}

/** 剥离推理模型的思考标签对(如 MiniMax/DeepSeek 的 <think>…</think>):当代模型
 *  即便被明令「只回终态包」也会以思考块前缀输出——不剥则严格终态门对推理模型
 *  结构性失效(Round 9 治理面实测)。只剥配对的推理标签本体,其余前后缀仍 fail-closed。 */
function stripReasoningBlocks(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
}

/** Parse exactly one configured tag pair containing one JSON object. */
export function parseBenchmarkTerminal(raw: string, config: TerminalOutputConfig): TerminalOutputValue {
  if (!validateTerminalOutputConfig(config)) return invalidTerminal()
  if (Buffer.byteLength(raw, 'utf8') > config.max_bytes) return invalidTerminal()

  const trimmed = stripReasoningBlocks(raw).trim()
  const opening = `<${config.tag}>`
  const closing = `</${config.tag}>`
  if (!trimmed.startsWith(opening) || !trimmed.endsWith(closing)) return invalidTerminal()
  if (trimmed.indexOf(opening) !== trimmed.lastIndexOf(opening)
    || trimmed.indexOf(closing) !== trimmed.lastIndexOf(closing)) return invalidTerminal()
  const body = trimmed.slice(opening.length, -closing.length)
  if (body.length === 0 || body.includes('```')) return invalidTerminal()

  try {
    const value: unknown = JSON.parse(body)
    if (!plainObject(value)) return invalidTerminal()
    // Round 12(#215):同一份 closed body schema 在接受终态前 fail-closed 校验——
    // 结构不合法的终态永不进入正式计分链,不做任何 autofix。
    if (!validateTerminalBodyValue(value, config.body_schema)) return invalidTerminal()
    return { ok: true, value }
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

type BridgeResultStatus = { kind: 'result' } | { kind: 'domain' } | { kind: 'failure'; code: string }

function bridgeResultStatus(data: Record<string, unknown>, callId: string): BridgeResultStatus | undefined {
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
    const keys = Object.keys(parsed).sort().join(',')
    if (parsed.ok === true && keys === 'ok,result' && (plainObject(parsed.result) || Array.isArray(parsed.result))) return { kind: 'result' }
    if (parsed.ok === true && keys === 'ok,outcome' && plainObject(parsed.outcome)) {
      const outcomeKeys = Object.keys(parsed.outcome).sort().join(',')
      if (outcomeKeys === 'code,recovery,schema_version,status'
        && parsed.outcome.schema_version === BENCHMARK_TOOL_RESULT_SCHEMA_VERSION
        && (parsed.outcome.status === 'miss' || parsed.outcome.status === 'error')
        && typeof parsed.outcome.code === 'string'
        && IDENTIFIER.test(parsed.outcome.code)
        && typeof parsed.outcome.recovery === 'string'
        && BENCHMARK_DOMAIN_RECOVERIES.has(parsed.outcome.recovery)) return { kind: 'domain' }
      return undefined
    }
    if (parsed.ok === false && typeof parsed.error === 'string') {
      const exactFailure = parsed.error === 'runner_failed'
        ? (keys === 'error,ok' || (keys === 'error,exit_code,ok,signal'
          && (parsed.exit_code === null || (typeof parsed.exit_code === 'number' && Number.isInteger(parsed.exit_code)))
          && (parsed.signal === null || typeof parsed.signal === 'string')))
        : parsed.error === 'invalid_arguments'
          ? keys === 'error,ok,reason' && typeof parsed.reason === 'string'
          : keys === 'error,ok'
      if (!exactFailure) return undefined
      const code = parsed.error === 'timed_out'
        ? BENCHMARK_BRIDGE_TIMED_OUT
        : parsed.error === 'runner_failed'
          ? BENCHMARK_BRIDGE_RUNNER_FAILED
          : parsed.error === 'spawn_failed'
            ? BENCHMARK_BRIDGE_SPAWN_FAILED
            : parsed.error === 'output_truncated'
              ? BENCHMARK_BRIDGE_OUTPUT_TRUNCATED
            : BENCHMARK_BRIDGE_CALL_FAILED
      return { kind: 'failure', code }
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
        // Round 8(issue #100/#102):bridge 工具 typed 泛化后,模型出参为平铺形态
        const flat = args && plainObject(args) ? args : undefined
        if (flat?.action === 'call'
          && typeof flat.tool === 'string'
          && projection.allowedTools.includes(flat.tool)) {
          state.validCallIds.add(event.data.callId)
        }
        return
      }

      if (event.type === 'tool/result') {
        if (!plainObject(event.data.message) || !plainObject(event.data.message.source)) return
        const callId = event.data.message.source.callId
        if (typeof callId !== 'string' || !state.validCallIds.has(callId)) return
        const resultStatus = bridgeResultStatus(event.data, callId)
        if (typeof event.data.step === 'number') state.lastBridgeResponseStep = event.data.step
        if (resultStatus?.kind === 'result') {
          state.successfulResultStep = typeof event.data.step === 'number'
            ? event.data.step
            : state.successfulResultStep
        } else if (resultStatus?.kind === 'domain') {
          state.domainOutcomeStep = typeof event.data.step === 'number'
            ? event.data.step
            : state.domainOutcomeStep
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
      if (state.bridgeCallFailed && state.successfulResultStep === undefined) {
        return { kind: 'reject', code: state.bridgeFailureCode ?? BENCHMARK_BRIDGE_CALL_FAILED }
      }
      if (state.successfulResultStep === undefined && state.domainOutcomeStep === undefined) {
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
        && terminal.step > state.lastBridgeResponseStep!
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
    : `BENCHMARK_CONFORMANCE_TERMINAL: Reuse the existing successful tool result. Do not call any tool. Reply only <${projection.terminal.tag}> with one JSON object matching exactly ${terminalSchemaOutline(projection.terminal.body_schema)} — no extra keys, no missing keys, exact types.`
  return createUserMessage({
    content: [{ type: 'text' as const, text }],
    source: { kind: 'plugin' as const, plugin: 'gotry-benchmark-agent-conformance' },
  })
}

function systemSection(projection: BenchmarkBridgeProjection): { name: string; text: string } {
  const allowed = projection.allowedTools.join(', ')
  const outline = terminalSchemaOutline(projection.terminal.body_schema)
  return {
    name: 'benchmark:agent-conformance',
    text: [
      'Benchmark execution contract:',
      `- Translate every task instruction to use a CLI, shell, Python, or agent_env.cli into the native tool ${projection.toolName}; do not merely describe the intended command.`,
      `- Call it with exactly {"action":"call","tool":"<one of: ${allowed}>","arguments":{...}}.`,
      '- action:"tools" is discovery only and does not satisfy the required environment call.',
      `- After a successful tool result, reply only <${projection.terminal.tag}> with one JSON object matching exactly ${outline} — no extra keys, no missing keys, exact types; no prose or code fence.`,
      '- If a terminal-format correction arrives, reuse the existing result and do not call the tool again.',
    ].join('\n'),
  }
}

/** Install conformance only after the exact benchmark bridge isolation layer. */
export function installBenchmarkAgentConformance(
  ctx: Context,
  projection: BenchmarkBridgeProjection,
  diagnosticWriter: (code: BenchmarkChildFailureCode) => void = emitBenchmarkChildDiagnostic,
): void {
  const bus = ctx as unknown as EventBus
  if (typeof bus.on !== 'function') throw new Error('benchmark conformance event bus unavailable')

  const byAgent = new WeakMap<object, BenchmarkAgentConformance>()
  const bySession = new WeakMap<object, BenchmarkAgentConformance>()
  const sessionKeys = new WeakMap<object, string>()
  let sessionOrdinal = 0
  const diagnostics = createBenchmarkDiagnosticArbiter(diagnosticWriter)

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
    sessionKeys.set(agent.session, `session-${++sessionOrdinal}`)
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
    if (typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'turn/end') {
      const key = sessionKeys.get(session)
      if (key !== undefined) {
        diagnostics.offer(key, classifyBenchmarkTurnEnd((event as { data?: { reason?: unknown } }).data?.reason))
        diagnostics.flush(key)
      }
    }
  })
  bus.on('session/disposed', (session: object) => {
    const key = sessionKeys.get(session)
    if (key !== undefined) diagnostics.flush(key)
    sessionKeys.delete(session)
    bySession.delete(session)
  })
  bus.on('agent/disposed', (payload: { agent?: ScopedAgent }) => {
    const agent = payload.agent
    if (!agent || typeof agent !== 'object') return
    byAgent.delete(agent)
    if (agent.session) bySession.delete(agent.session)
  })
  bus.on('agent/turn-stopping', (payload: { agent?: ScopedAgent; session?: object; turn?: number }) => {
    const agent = payload.agent
    const session = agent?.session ?? payload.session
    const key = session && typeof session === 'object' ? sessionKeys.get(session) : undefined
    if (!agent || typeof agent !== 'object' || typeof payload.turn !== 'number') {
      if (key !== undefined) diagnostics.offer(key, 'child_conformance_failure')
      else diagnosticWriter('child_conformance_failure')
      throw new Error(BENCHMARK_CONFORMANCE_STATE_UNAVAILABLE)
    }
    const controller = byAgent.get(agent)
    if (!controller) {
      if (key !== undefined) diagnostics.offer(key, 'child_conformance_failure')
      else diagnosticWriter('child_conformance_failure')
      throw new Error(BENCHMARK_CONFORMANCE_STATE_UNAVAILABLE)
    }
    const decision = controller.stopping(payload.turn)
    if (decision.kind === 'reject') {
      if (key !== undefined) diagnostics.offer(key, benchmarkChildFailureForConformanceCode(decision.code))
      else diagnosticWriter(benchmarkChildFailureForConformanceCode(decision.code))
      throw new Error(decision.code)
    }
    if (decision.kind === 'steer') agent.steer!(correctionMessage(decision.mode, projection))
  }, { prepend: true })
}
