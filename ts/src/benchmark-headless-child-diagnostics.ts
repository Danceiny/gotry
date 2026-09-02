/** Stable, redacted diagnostics carried on the benchmark-only control pipe. */

import { writeSync } from 'node:fs'

export const BENCHMARK_CHILD_DIAGNOSTIC_SCHEMA = 'gotry_benchmark_child_diagnostic_v1' as const
export const BENCHMARK_CHILD_DIAGNOSTIC_FD_ENV = 'GOTRY_BENCHMARK_DIAGNOSTIC_FD' as const
export const BENCHMARK_CHILD_DIAGNOSTIC_MAX_BYTES = 4 * 1024

export type BenchmarkChildFailureCode =
  | 'child_output_truncated'
  | 'child_signaled'
  | 'child_lifecycle_failure'
  | 'child_conformance_failure'
  | 'child_bridge_timed_out'
  | 'child_bridge_runner_failed'
  | 'child_bridge_spawn_failed'
  | 'child_bridge_output_truncated'
  | 'child_bridge_failure'
  | 'child_terminal_invalid'
  | 'child_nonzero_exit'
  | 'child_spawn_failure'
  | 'child_model_auth'
  | 'child_model_capacity'
  | 'child_model_server'
  | 'child_model_transport'
  | 'child_model_stream'
  | 'child_model_request'
  | 'child_runtime_error'
  | 'child_blocked'
  | 'child_max_tokens'
  | 'child_aborted'
  | 'child_interrupted'

const FAILURE_CODES = new Set<BenchmarkChildFailureCode>([
  'child_output_truncated',
  'child_signaled',
  'child_lifecycle_failure',
  'child_conformance_failure',
  'child_bridge_timed_out',
  'child_bridge_runner_failed',
  'child_bridge_spawn_failed',
  'child_bridge_output_truncated',
  'child_bridge_failure',
  'child_terminal_invalid',
  'child_nonzero_exit',
  'child_spawn_failure',
  'child_model_auth',
  'child_model_capacity',
  'child_model_server',
  'child_model_transport',
  'child_model_stream',
  'child_model_request',
  'child_runtime_error',
  'child_blocked',
  'child_max_tokens',
  'child_aborted',
  'child_interrupted',
])

export interface BenchmarkChildFailureInput {
  readonly code?: number | null
  readonly signal?: string | null
  readonly diagnostic?: string
  readonly outputTruncated?: boolean
}

type DiagnosticCode = BenchmarkChildFailureCode | undefined

const MODEL_AUTH = new Set(['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL'])
const MODEL_CAPACITY = new Set(['QUOTA', 'RATE_LIMIT'])
const MODEL_SERVER = new Set(['SERVER'])
const MODEL_TRANSPORT = new Set(['TRANSPORT', 'TIMEOUT'])
const MODEL_STREAM = new Set(['EMPTY_RESPONSE', 'STREAM_CLOSED', 'MALFORMED_RESPONSE', 'INVALID_RESPONSE'])
const MODEL_REQUEST = new Set(['INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'NO_ADAPTER', 'UNKNOWN_MODEL', 'UNSUPPORTED_OPTION'])

/** Classify only the structured final turn/end envelope; free-form fields are ignored. */
export function classifyBenchmarkTurnEnd(reason: unknown): DiagnosticCode {
  if (!plainObject(reason) || typeof reason.kind !== 'string') return 'child_runtime_error'
  switch (reason.kind) {
    case 'completed': return undefined
    case 'blocked': return 'child_blocked'
    case 'max-tokens': return 'child_max_tokens'
    case 'aborted': return 'child_aborted'
    case 'interrupted': return 'child_interrupted'
    case 'error': {
      const error = plainObject(reason.error) ? reason.error : {}
      const code = typeof error.code === 'string' ? error.code : ''
      const status = typeof error.status === 'number' && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
        ? error.status
        : undefined
      if (MODEL_AUTH.has(code)) return 'child_model_auth'
      if (MODEL_CAPACITY.has(code)) return 'child_model_capacity'
      if (MODEL_SERVER.has(code)) return 'child_model_server'
      if (MODEL_TRANSPORT.has(code)) return 'child_model_transport'
      if (MODEL_STREAM.has(code)) return 'child_model_stream'
      if (MODEL_REQUEST.has(code)) return 'child_model_request'
      if (code === 'ABORTED') return 'child_aborted'
      if (status === 401 || status === 403) return 'child_model_auth'
      if (status === 429) return 'child_model_capacity'
      if (status !== undefined && status >= 500 && status <= 599) return 'child_model_server'
      return 'child_runtime_error'
    }
    default: return 'child_runtime_error'
  }
}

/** Per-session final arbiter. It emits one best closed enum, never its payload. */
export function createBenchmarkDiagnosticArbiter(write: (code: BenchmarkChildFailureCode) => void) {
  const pending = new Map<string, BenchmarkChildFailureCode>()
  const emitted = new Set<string>()
  const rank = (code: BenchmarkChildFailureCode): number => code.startsWith('child_bridge_') ? 4 : code === 'child_conformance_failure' ? 3 : code === 'child_runtime_error' ? 1 : 2
  return {
    offer(session: string, code: BenchmarkChildFailureCode | undefined): void {
      if (code === undefined || emitted.has(session)) return
      const previous = pending.get(session)
      if (previous === undefined || rank(code) > rank(previous)) pending.set(session, code)
    },
    flush(session: string): void {
      if (emitted.has(session)) return
      const code = pending.get(session)
      if (code === undefined) return
      emitted.add(session)
      pending.delete(session)
      write(code)
    },
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keep the newest bounded bytes so a final control record cannot be displaced by noise. */
export function appendBoundedChildDiagnostic(current: Buffer, chunk: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  if (bytes.length >= BENCHMARK_CHILD_DIAGNOSTIC_MAX_BYTES) {
    return bytes.subarray(bytes.length - BENCHMARK_CHILD_DIAGNOSTIC_MAX_BYTES)
  }
  if (current.length + bytes.length <= BENCHMARK_CHILD_DIAGNOSTIC_MAX_BYTES) {
    return Buffer.concat([current, bytes])
  }
  const keep = BENCHMARK_CHILD_DIAGNOSTIC_MAX_BYTES - bytes.length
  return Buffer.concat([current.subarray(current.length - keep), bytes])
}

export function parseBenchmarkChildDiagnostic(raw: string): BenchmarkChildFailureCode | undefined {
  const lines = raw.split('\n').map(line => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed: unknown = JSON.parse(lines[index])
      if (!plainObject(parsed)) continue
      const keys = Object.keys(parsed).sort()
      if (JSON.stringify(keys) !== JSON.stringify(['code', 'schema_version'])) continue
      if (parsed.schema_version !== BENCHMARK_CHILD_DIAGNOSTIC_SCHEMA) continue
      if (typeof parsed.code !== 'string' || !FAILURE_CODES.has(parsed.code as BenchmarkChildFailureCode)) continue
      return parsed.code as BenchmarkChildFailureCode
    } catch {
      // The control pipe is fail-closed: malformed or unrelated records are ignored.
    }
  }
  return undefined
}

/** Emit one namespaced enum record without reflecting prompts, paths, or stderr. */
export function emitBenchmarkChildDiagnostic(code: BenchmarkChildFailureCode): void {
  const fd = Number(process.env[BENCHMARK_CHILD_DIAGNOSTIC_FD_ENV])
  if (!Number.isInteger(fd) || fd < 3) return
  const record = `\n${JSON.stringify({ schema_version: BENCHMARK_CHILD_DIAGNOSTIC_SCHEMA, code })}\n`
  if (Buffer.byteLength(record, 'utf8') > BENCHMARK_CHILD_DIAGNOSTIC_MAX_BYTES) return
  try {
    writeSync(fd, record)
  } catch {
    // Diagnostics never change the conformance decision itself.
  }
}

export function classifyBenchmarkChildFailure(input: BenchmarkChildFailureInput): BenchmarkChildFailureCode {
  if (input.outputTruncated) return 'child_output_truncated'
  if (input.signal) return 'child_signaled'
  const structured = parseBenchmarkChildDiagnostic(input.diagnostic ?? '')
  if (structured) return structured
  if (input.code !== 0) return 'child_nonzero_exit'
  return 'child_lifecycle_failure'
}
