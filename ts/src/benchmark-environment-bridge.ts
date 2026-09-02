import { accessSync, constants, lstatSync, readFileSync, statSync } from 'node:fs'
import { getuid } from 'node:process'
import { isAbsolute } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  validateTerminalOutputConfig,
  type BenchmarkBridgeProjection,
  type TerminalOutputConfig,
} from './benchmark-agent-conformance.ts'

const SCHEMA_VERSION = 'gotry_benchmark_environment_bridge_v2'
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]*$/
const CONFIG_KEYS = ['allowed_tools', 'argv_prefix', 'cwd', 'enabled', 'executable', 'isolation', 'max_output_bytes', 'schema_version', 'terminal_output', 'timeout_ms']
const OPTIONAL_CONFIG_KEYS = ['allowed_output_keys']

export interface BenchmarkEnvironmentBridgeConfig {
  schema_version: typeof SCHEMA_VERSION
  enabled: true
  executable: string
  cwd: string
  argv_prefix: string[]
  allowed_tools: string[]
  allowed_output_keys?: Record<string, string[]>
  timeout_ms: number
  max_output_bytes: number
  terminal_output: TerminalOutputConfig
  isolation: {
    mode: 'host-enforced'
    writes: 'forbidden'
    network: 'denied'
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function identifiers(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 64 && new Set(value).size === value.length && value.every(
    item => typeof item === 'string' && item.length > 0 && IDENTIFIER.test(item),
  )
}

function allowedOutputKeys(value: unknown, allowedTools: string[]): value is Record<string, string[]> {
  if (!plainObject(value)) return false
  const keys = Object.keys(value)
  return keys.length > 0 && keys.length <= 64
    && keys.every(tool => allowedTools.includes(tool) && identifiers(value[tool]))
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
  const extendedKeys = [...CONFIG_KEYS, ...OPTIONAL_CONFIG_KEYS].sort()
  if (!plainObject(value)
    || ![baseKeys, extendedKeys].some(keys => JSON.stringify(configKeys) === JSON.stringify(keys))
    || value.schema_version !== SCHEMA_VERSION
    || value.enabled !== true
    || !existingExecutable(value.executable)
    || !existingDirectory(value.cwd)
    || !argvPrefix(value.argv_prefix)
    || !identifiers(value.allowed_tools)
    || !validBound(value.timeout_ms, 120_000)
    || !validBound(value.max_output_bytes, 10 * 1024 * 1024)
    || !validateTerminalOutputConfig(value.terminal_output)
    || !exactIsolation(value.isolation)
    || (Object.hasOwn(value, 'allowed_output_keys') && !allowedOutputKeys(value.allowed_output_keys, value.allowed_tools))) return false
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
    return validate(parsed) ? parsed : null
  } catch {
    return null
  }
}

type Register = (tool: ReturnType<typeof defineTool>) => void
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
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    if (++nodes > 10_000 || current.depth > 24) return false
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 })
      continue
    }
    if (!plainObject(current.value)) continue
    for (const [key, child] of Object.entries(current.value)) {
      if (!allowed.has(key)) return false
      pending.push({ value: child, depth: current.depth + 1 })
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

  register(defineTool({
    name: 'gotry_benchmark_environment',
    description: 'When a prompt asks to run agent_env.cli, use action=call here with the mapped tool; arbitrary shell is not exposed.',
    parameters: {
      query: {
        type: 'json',
        required: true,
        description: '{ action: "tools" | "call", tool?: string, arguments?: object }',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { query?: unknown }): Promise<Record<string, never>> {
      const query = plainObject(args?.query) ? args.query : {}
      if (query.action === 'tools') return jsonObject({ ok: true, tools: bridge.allowed_tools })
      if (query.action !== 'call') return jsonObject({ ok: false, error: 'invalid_action' })
      if (typeof query.tool !== 'string' || !bridge.allowed_tools.includes(query.tool)) {
        return jsonObject({ ok: false, error: 'disallowed_tool' })
      }
      if (query.arguments !== undefined && !plainObject(query.arguments)) {
        return jsonObject({ ok: false, error: 'invalid_arguments' })
      }
      const callArguments = query.arguments === undefined ? {} : query.arguments
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
          argv: [bridge.executable, ...bridge.argv_prefix, 'call', query.tool, serialized.json!],
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
        const visibleResult = parsed.result ?? parsed
        if (!plainObject(visibleResult) && !Array.isArray(visibleResult)) return jsonObject({ ok: false, error: 'invalid_output' })
        const outputKeys = bridge.allowed_output_keys && Object.hasOwn(bridge.allowed_output_keys, query.tool)
          ? bridge.allowed_output_keys[query.tool]
          : undefined
        if (outputKeys && !inspectAllowedOutput(visibleResult, outputKeys)) return jsonObject({ ok: false, error: 'forbidden_output' })
        return jsonObject({ ok: true, result: visibleResult })
      } catch {
        if (controller.signal.aborted) return jsonObject({ ok: false, error: 'timed_out' })
        return jsonObject({ ok: false, error: !handle || handle.pid === -1 ? 'spawn_failed' : 'runner_failed' })
      } finally {
        clearTimeout(timer)
      }
    },
  }))
  return Object.freeze({
    toolName: 'gotry_benchmark_environment',
    allowedTools: Object.freeze([...bridge.allowed_tools]),
    terminal: Object.freeze({ ...bridge.terminal_output }),
  })
}
