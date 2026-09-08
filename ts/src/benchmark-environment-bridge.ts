import { accessSync, constants, lstatSync, readFileSync, statSync } from 'node:fs'
import { getuid } from 'node:process'
import { isAbsolute } from 'node:path'
import {
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
  ToolArgsError,
  type ObjectJsonSchema,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import {
  validateTerminalOutputConfig,
  type BenchmarkBridgeProjection,
  type TerminalOutputConfig,
} from './benchmark-agent-conformance.ts'

const SCHEMA_VERSION = 'gotry_benchmark_environment_bridge_v3'
export const BENCHMARK_TOOL_RESULT_SCHEMA_VERSION = 'gotry_benchmark_tool_result_v1'
export const BENCHMARK_DOMAIN_RECOVERIES = ['none', 'retry_same', 'revise_arguments', 'choose_alternative'] as const
type BenchmarkDomainRecovery = typeof BENCHMARK_DOMAIN_RECOVERIES[number]
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]*$/
const RECOVERIES = new Set<string>(BENCHMARK_DOMAIN_RECOVERIES)
const CONFIG_KEYS = ['argv_prefix', 'cwd', 'enabled', 'executable', 'isolation', 'max_output_bytes', 'schema_version', 'terminal_output', 'timeout_ms', 'tools']
const INPUT_SCHEMA_MAX_BYTES = 16 * 1024
const INPUT_SCHEMA_MAX_DEPTH = 8
const INPUT_SCHEMA_MAX_NODES = 256
const INPUT_SCHEMA_MAX_PROPERTIES = 256
const INPUT_SCHEMA_MAX_ENUM_VALUES = 256
const INPUT_SCHEMA_MAX_DESCRIPTION_LENGTH = 512
const INPUT_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'])

export interface BenchmarkEnvironmentBridgeConfig {
  schema_version: typeof SCHEMA_VERSION
  enabled: true
  executable: string
  cwd: string
  argv_prefix: string[]
  tools: BenchmarkToolDescriptor[]
  timeout_ms: number
  max_output_bytes: number
  terminal_output: TerminalOutputConfig
  isolation: {
    mode: 'host-enforced'
    writes: 'forbidden'
    network: 'denied'
  }
}

export interface BenchmarkToolDescriptor {
  name: string
  description: string
  input_schema: ObjectJsonSchema
  output_keys: string[]
  domain_outcomes: Array<{ status: 'miss' | 'error'; code: string; recovery: BenchmarkDomainRecovery }>
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepFreezeJson<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child)
  return Object.freeze(value)
}

function existingExecutable(value: unknown): value is string {
  if (typeof value !== 'string' || !isAbsolute(value)) return false
  try {
    const stat = statSync(value)
    accessSync(value, constants.X_OK)
    return stat.isFile()
  } catch {
    return false
  }
}

function existingDirectory(value: unknown): value is string {
  if (typeof value !== 'string' || !isAbsolute(value)) return false
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}

function identifiers(value: unknown, allowEmpty = false): value is string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= 64 && new Set(value).size === value.length && value.every(
    item => typeof item === 'string' && item.length > 0 && IDENTIFIER.test(item),
  )
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function validDescription(value: unknown, required = false): boolean {
  if (value === undefined) return !required
  return typeof value === 'string'
    && (!required || value.trim().length > 0)
    && value.length <= INPUT_SCHEMA_MAX_DESCRIPTION_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function scalarMatches(type: string, value: unknown): boolean {
  if (type === 'string') return typeof value === 'string' && value.length <= 512
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value)
  if (type === 'boolean') return typeof value === 'boolean'
  return type === 'null' && value === null
}

function validInputSchema(value: unknown): value is ObjectJsonSchema {
  if (!plainObject(value)) return false
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return false
  }
  if (Buffer.byteLength(serialized, 'utf8') > INPUT_SCHEMA_MAX_BYTES) return false

  const pending: Array<{ node: Record<string, unknown>; depth: number }> = [{ node: value, depth: 0 }]
  const seen = new Set<object>()
  let nodes = 0
  let properties = 0
  let enumValues = 0
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!
    if (seen.has(node) || ++nodes > INPUT_SCHEMA_MAX_NODES || depth > INPUT_SCHEMA_MAX_DEPTH) return false
    seen.add(node)
    if (!INPUT_SCHEMA_TYPES.has(String(node.type)) || !validDescription(node.description)) return false

    if (node.type === 'object') {
      if (!exactKeys(node, ['type', 'description', 'properties', 'required', 'additionalProperties'])
        || !plainObject(node.properties)
        || !Array.isArray(node.required)
        || node.additionalProperties !== false) return false
      const propertyEntries = Object.entries(node.properties)
      properties += propertyEntries.length
      if (properties > INPUT_SCHEMA_MAX_PROPERTIES || propertyEntries.some(([key, child]) => !IDENTIFIER.test(key) || !plainObject(child))) return false
      const required = node.required
      if (required.length > propertyEntries.length
        || new Set(required).size !== required.length
        || required.some(key => typeof key !== 'string' || !Object.hasOwn(node.properties as Record<string, unknown>, key))) return false
      for (const [, child] of propertyEntries) pending.push({ node: child as Record<string, unknown>, depth: depth + 1 })
      continue
    }

    if (node.type === 'array') {
      if (!exactKeys(node, ['type', 'description', 'items']) || !plainObject(node.items)) return false
      pending.push({ node: node.items, depth: depth + 1 })
      continue
    }

    if (!exactKeys(node, ['type', 'description', 'enum', 'const'])
      || (Object.hasOwn(node, 'enum') && Object.hasOwn(node, 'const'))) return false
    if (Object.hasOwn(node, 'const') && !scalarMatches(String(node.type), node.const)) return false
    if (Object.hasOwn(node, 'enum')) {
      if (!Array.isArray(node.enum) || node.enum.length === 0 || node.enum.length > 64) return false
      enumValues += node.enum.length
      if (enumValues > INPUT_SCHEMA_MAX_ENUM_VALUES
        || new Set(node.enum).size !== node.enum.length
        || node.enum.some(item => !scalarMatches(String(node.type), item))) return false
    }
  }
  return value.type === 'object'
}

function toolDescriptors(value: unknown): value is BenchmarkToolDescriptor[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return false
  const names = new Set<string>()
  return value.every(item => {
    if (!plainObject(item)) return false
    const keys = Object.keys(item).sort()
    const required = ['description', 'domain_outcomes', 'input_schema', 'name']
    if (JSON.stringify(keys) !== JSON.stringify([...required, 'output_keys'].sort())) return false
    if (typeof item.name !== 'string' || !IDENTIFIER.test(item.name) || names.has(item.name)) return false
    names.add(item.name)
    if (!validDescription(item.description, true) || !validInputSchema(item.input_schema)) return false
    if (!Array.isArray(item.domain_outcomes) || item.domain_outcomes.length > 64) return false
    const outcomeKeys = new Set<string>()
    if (!item.domain_outcomes.every(outcome => plainObject(outcome)
      && JSON.stringify(Object.keys(outcome).sort()) === JSON.stringify(['code', 'recovery', 'status'])
      && (outcome.status === 'miss' || outcome.status === 'error')
      && typeof outcome.code === 'string' && IDENTIFIER.test(outcome.code)
      && typeof outcome.recovery === 'string' && RECOVERIES.has(outcome.recovery)
      && !outcomeKeys.has(outcome.code)
      && (outcomeKeys.add(outcome.code), true))) return false
    return identifiers(item.output_keys)
  })
}

// These are passed as direct argv entries (never through a shell), so options
// such as "-m" and dotted module names are valid. Keep the prefix bounded and
// reject line/control separators that could make diagnostics ambiguous.
function argvPrefix(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every(
    item => typeof item === 'string'
      && item.length > 0
      && item.length <= 256
      && !item.includes('\0')
      && !item.includes('\r')
      && !item.includes('\n'),
  )
}

function exactIsolation(value: unknown): value is BenchmarkEnvironmentBridgeConfig['isolation'] {
  if (!plainObject(value)) return false
  const keys = Object.keys(value).sort()
  return JSON.stringify(keys) === JSON.stringify(['mode', 'network', 'writes'])
    && value.mode === 'host-enforced'
    && value.writes === 'forbidden'
    && value.network === 'denied'
}

function validBound(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maximum
}

function validate(value: unknown): value is BenchmarkEnvironmentBridgeConfig {
  const configKeys = plainObject(value) ? Object.keys(value).sort() : []
  const baseKeys = [...CONFIG_KEYS].sort()
  if (!plainObject(value)
    || JSON.stringify(configKeys) !== JSON.stringify(baseKeys)
    || value.schema_version !== SCHEMA_VERSION
    || value.enabled !== true
    || !existingExecutable(value.executable)
    || !existingDirectory(value.cwd)
    || !argvPrefix(value.argv_prefix)
    || !toolDescriptors(value.tools)
    || !validBound(value.timeout_ms, 120_000)
    || !validBound(value.max_output_bytes, 10 * 1024 * 1024)
    || !validateTerminalOutputConfig(value.terminal_output)
    || !exactIsolation(value.isolation)
    ) return false
  return true
}

/** Read and validate an owner-local bridge config without exposing its contents. */
export function loadBenchmarkEnvironmentConfig(path: string): BenchmarkEnvironmentBridgeConfig | null {
  try {
    if (!isAbsolute(path)) return null
    const metadata = lstatSync(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) return null
    if (typeof getuid !== 'function' || metadata.uid !== getuid()) return null
    if ((metadata.mode & 0o022) !== 0) return null
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return validate(parsed) ? deepFreezeJson(parsed) : null
  } catch {
    return null
  }
}

type Register = (tool: ToolDefinition) => void
interface CollectedText {
  readFrom(offset: number): { text: string; nextOffset: number; lossy?: boolean }
}

interface SubprocessHandle {
  /** DSH reports -1 when process creation itself failed. */
  readonly pid: number
  collected: { stdout: CollectedText; stderr: CollectedText }
  done: Promise<{ exitCode: number | null; signal?: string | null }>
  terminate?: () => void
}

export interface BenchmarkSubprocessService {
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: {
      stdin: 'ignore'
      stdout: { maxBytes: number }
      stderr: { maxBytes: number }
    }
    graceMs: number
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
  }): SubprocessHandle
}

function structuredObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text.trim())
    return plainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function jsonObject(value: unknown): Record<string, never> {
  return JSON.parse(JSON.stringify(value)) as Record<string, never>
}

const FORBIDDEN_OUTPUT_KEY_FRAGMENTS = [
  'answer', 'expected', 'gold', 'groundtruth', 'hiddenquery', 'label',
  'loadermetadata', 'oracle', 'reference', 'reward', 'score',
]

export const BRIDGE_ERROR_CONTRACT: Record<string, { recoverable: boolean; remedy: string }> = Object.freeze({
  invalid_action: { recoverable: true, remedy: 'action 只允许 tools、call 或 errors' },
  disallowed_tool: { recoverable: true, remedy: '先 action=tools 列出 allowed_tools 清单,再从清单内选工具' },
  invalid_arguments: { recoverable: true, remedy: 'arguments 必须是可序列化 JSON 对象(≤64KB、深度≤12);收窄后重试' },
  timed_out: { recoverable: true, remedy: '上游超时;可原样重试一次或换其他工具' },
  output_truncated: { recoverable: true, remedy: '输出超出上限;让被调工具收窄查询范围后重试' },
  invalid_json: { recoverable: true, remedy: '上游输出不是合法 JSON;重试一次或换工具' },
  invalid_output: { recoverable: true, remedy: '上游输出结构不符;重试或换工具' },
  runner_failed: { recoverable: true, remedy: '上游进程非零退出;可重试一次,持续失败换工具' },
  spawn_failed: { recoverable: false, remedy: '可执行文件不可用——环境问题,调用方不可恢复' },
  forbidden_output: { recoverable: false, remedy: '输出含未授权键(策略边界)——不可恢复,换工具或放弃' },
})

function inspectOutput(value: unknown): 'ok' | 'forbidden_key' | 'structure_limit' {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    if (++nodes > 10_000 || current.depth > 24) return 'structure_limit'
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 })
      continue
    }
    if (!plainObject(current.value)) continue
    for (const [key, child] of Object.entries(current.value)) {
      if (!/^[\x20-\x7E]+$/.test(key)) return 'forbidden_key'
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (FORBIDDEN_OUTPUT_KEY_FRAGMENTS.some(fragment => normalized.includes(fragment))) return 'forbidden_key'
      pending.push({ value: child, depth: current.depth + 1 })
    }
  }
  return 'ok'
}

function inspectAllowedOutput(value: unknown, allowedKeys: string[]): boolean {
  const allowed = new Set(allowedKeys)
  const pending: Array<{ value: unknown; depth: number; coveredByDeclaredKey: boolean }> = [{ value, depth: 0, coveredByDeclaredKey: false }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    if (++nodes > 10_000 || current.depth > 24) return false
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1, coveredByDeclaredKey: current.coveredByDeclaredKey })
      continue
    }
    if (!plainObject(current.value)) {
      if (!current.coveredByDeclaredKey) return false
      continue
    }
    for (const [key, child] of Object.entries(current.value)) {
      if (!allowed.has(key)) return false
      pending.push({ value: child, depth: current.depth + 1, coveredByDeclaredKey: true })
    }
  }
  return true
}

function serializedArguments(value: Record<string, unknown>): { json: string; reason?: never } | { json?: never; reason: string } {
  const seen = new Set<object>()
  let nodes = 0
  let keys = 0
  const inspect = (current: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 12) return false
    if (current && typeof current === 'object') {
      if (seen.has(current)) return false
      seen.add(current)
      if (Array.isArray(current)) return current.every(item => inspect(item, depth + 1))
      return Object.entries(current).every(([key, child]) => {
        if (++keys > 10_000) return false
        return inspect(key, depth + 1) && inspect(child, depth + 1)
      })
    }
    return true
  }
  if (!inspect(value, 0)) return { reason: 'serialization_limit' }
  try {
    const json = JSON.stringify(value)
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > 65_536) return { reason: 'serialization_limit' }
    return { json }
  } catch {
    return { reason: 'serialization_limit' }
  }
}

/** Register the opt-in model-facing bridge. */
export function registerBenchmarkEnvironmentBridge(
  path: string,
  register: Register,
  subprocess?: BenchmarkSubprocessService,
): BenchmarkBridgeProjection {
  const bridge = loadBenchmarkEnvironmentConfig(path)
  if (!bridge) throw new Error('benchmark environment bridge configuration unavailable')
  if (!subprocess) throw new Error('benchmark environment bridge subprocess unavailable')

  const parameters: Record<string, unknown> = deepFreezeJson({
    type: 'object',
    description: 'Flat benchmark bridge wire: choose an action, then provide the mapped tool and its arguments.',
    properties: {
      action: { type: 'string', enum: ['tools', 'call', 'errors'], description: 'tools=列出可调工具;call=执行工具;errors=拉取错误契约' },
      tool: { type: 'string', enum: bridge.tools.map(item => item.name), description: 'action=call 时选择的冻结工具名' },
      arguments: { type: 'object', additionalProperties: true, description: 'action=call 时传给工具的参数对象' },
    },
    required: ['action'],
    additionalProperties: false,
  })
  assertSupportedJsonSchema(parameters)

  const definition: ToolDefinition = {
    name: 'gotry_benchmark_environment',
    description: 'When a prompt asks to run agent_env.cli, use action=call here with the mapped tool; arbitrary shell is not exposed.',
    parameters,
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown): Promise<Record<string, never>> {
      const violations = validateJsonSchemaValue(parameters, args, 'arguments')
      if (violations.length > 0) throw new ToolArgsError(violations)
      const query = args as Record<string, unknown>
      const tool = query.tool
      const descriptor = bridge.tools.find(item => item.name === tool)
      const keys = Object.keys(query)
      if (query.action === 'tools') {
        if (keys.length !== 1) throw new ToolArgsError(['arguments: tools action accepts no tool or arguments'])
        return jsonObject({ ok: true, tools: bridge.tools })
      }
      if (query.action === 'errors') {
        if (keys.length !== 1) throw new ToolArgsError(['arguments: errors action accepts no tool or arguments'])
        return jsonObject({ ok: true, errors: BRIDGE_ERROR_CONTRACT })
      }
      if (query.action !== 'call') {
        return jsonObject({ ok: false, error: 'invalid_action' })
      }
      if (keys.length !== 3 || !Object.hasOwn(query, 'tool') || !Object.hasOwn(query, 'arguments')) {
        throw new ToolArgsError(['arguments: call action requires exactly tool and arguments'])
      }
      if (typeof tool !== 'string' || !descriptor) {
        return jsonObject({ ok: false, error: 'disallowed_tool' })
      }
      if (!plainObject(query.arguments)) {
        return jsonObject({ ok: false, error: 'invalid_arguments' })
      }
      const callArguments = query.arguments
      const argumentViolations = validateJsonSchemaValue(descriptor.input_schema, callArguments, 'arguments')
      if (argumentViolations.length > 0) throw new ToolArgsError(argumentViolations)
      const serialized = serializedArguments(callArguments)
      if (serialized.reason) return jsonObject({ ok: false, error: 'invalid_arguments', reason: serialized.reason })
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
      }, bridge.timeout_ms)
      let handle: SubprocessHandle | undefined
      try {
        const env: NodeJS.ProcessEnv = Object.fromEntries(
          Object.keys(process.env).map(key => [key, undefined]),
        )
        for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']) {
          if (process.env[key] !== undefined) env[key] = process.env[key]!
        }
        env.PYTHONDONTWRITEBYTECODE = '1'
        env.PYTHONNOUSERSITE = '1'
        handle = subprocess.spawn({
          argv: [bridge.executable, ...bridge.argv_prefix, 'call', tool, serialized.json!],
          cwd: bridge.cwd,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: bridge.max_output_bytes },
            stderr: { maxBytes: bridge.max_output_bytes },
          },
          graceMs: Math.min(1_000, bridge.timeout_ms),
          env,
          signal: controller.signal,
        })
        const status = await handle.done
        if (controller.signal.aborted) return jsonObject({ ok: false, error: 'timed_out' })
        const stdout = handle.collected.stdout.readFrom(0)
        const stderr = handle.collected.stderr.readFrom(0)
        if (stdout.lossy || stderr.lossy) return jsonObject({ ok: false, error: 'output_truncated' })
        if (status.exitCode !== 0) {
          return jsonObject({
            ok: false,
            error: 'runner_failed',
            exit_code: status.exitCode,
            signal: status.signal ?? null,
          })
        }
        const parsed = structuredObject(stdout.text)
        if (!parsed) return jsonObject({ ok: false, error: 'invalid_json' })
        const outputInspection = inspectOutput(parsed)
        if (outputInspection === 'forbidden_key') return jsonObject({ ok: false, error: 'forbidden_output' })
        if (outputInspection === 'structure_limit') return jsonObject({ ok: false, error: 'invalid_output' })
        if (parsed.schema_version !== BENCHMARK_TOOL_RESULT_SCHEMA_VERSION || typeof parsed.status !== 'string') {
          return jsonObject({ ok: false, error: 'invalid_output' })
        }
        if (parsed.status === 'miss' || parsed.status === 'error') {
          if (typeof parsed.code !== 'string' || typeof parsed.recovery !== 'string' || !descriptor.domain_outcomes.some(outcome => outcome.status === parsed.status && outcome.code === parsed.code && outcome.recovery === parsed.recovery)) return jsonObject({ ok: false, error: 'invalid_output' })
          if (Object.keys(parsed).sort().join(',') !== 'code,recovery,schema_version,status') return jsonObject({ ok: false, error: 'invalid_output' })
          return jsonObject({ ok: true, outcome: parsed })
        }
        if (parsed.status !== 'ok' || !Object.hasOwn(parsed, 'result') || Object.keys(parsed).sort().join(',') !== 'result,schema_version,status') return jsonObject({ ok: false, error: 'invalid_output' })
        const visibleResult = parsed.result
        if (!plainObject(visibleResult) && !Array.isArray(visibleResult)) return jsonObject({ ok: false, error: 'invalid_output' })
        if (!inspectAllowedOutput(visibleResult, descriptor.output_keys)) return jsonObject({ ok: false, error: 'forbidden_output' })
        return jsonObject({ ok: true, result: visibleResult })
      } catch {
        if (controller.signal.aborted) return jsonObject({ ok: false, error: 'timed_out' })
        return jsonObject({ ok: false, error: !handle || handle.pid === -1 ? 'spawn_failed' : 'runner_failed' })
      } finally {
        clearTimeout(timer)
      }
    },
  }
  register(definition)
  return Object.freeze({
    toolName: 'gotry_benchmark_environment',
    allowedTools: Object.freeze(bridge.tools.map(item => item.name)),
    terminal: Object.freeze({ ...bridge.terminal_output }),
  })
}
