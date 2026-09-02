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
])

export interface BenchmarkChildFailureInput {
  readonly code?: number | null
  readonly signal?: string | null
  readonly diagnostic?: string
  readonly outputTruncated?: boolean
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
