/**
 * Inert external-event adapter contract for issue #432, parent #82.
 *
 * Scope: project a serialized W2A `w2a/0.1` core envelope into bounded,
 * typed metadata. This module is pure and deterministic: no IO, no Date.now,
 * no network, no process spawning, no runtime registration, and no state writes.
 *
 * Upstream reference: machinepulse-ai/world2agent
 * 7e5fc4d441699993b8f1ef7d3b9776065b7a93e0
 * `schema/0.1/schema.ts`, `schema/0.1/schema.json`, and
 * `docs/signal-format.md`.
 */

export const SUPPORTED_SCHEMA_VERSION = 'w2a/0.1' as const
export type SupportedSchemaVersion = typeof SUPPORTED_SCHEMA_VERSION

export const ABSOLUTE_MAX_BYTES = 64 * 1024

export interface AllowedSourceTuple {
  sensorId: string
  package: string
  sensorVersion: string
  sourceType: string
}

export interface IngestOptions {
  enabled?: boolean
  allowedSources?: readonly AllowedSourceTuple[]
  maxBytes?: number
}

export interface InertMetadata {
  trust: 'untrusted'
  schemaVersion: SupportedSchemaVersion
  signalId: string
  emittedAt: number
  occurredAt: number
  sensorId: string
  sourceType: string
  package: string
  sensorVersion: string
  eventType: string
}

export type RejectionReason =
  | 'disabled-by-default'
  | 'invalid-options'
  | 'empty-allowlist'
  | 'input-not-a-string'
  | 'input-too-large'
  | 'malformed-json'
  | 'unsupported-schema-version'
  | 'missing-required-field'
  | 'malformed-uuid'
  | 'malformed-timestamp'
  | 'malformed-event-type'
  | 'malformed-summary'
  | 'tuple-not-allowed'
  | 'malformed-options-tuple'

export interface IngestRejected {
  ok: false
  kind: 'rejected'
  reason: RejectionReason
  detail: string
  inputBytes: number
}

export interface IngestAccepted {
  ok: true
  kind: 'ingested'
  metadata: InertMetadata
  inputBytes: number
}

export type IngestResult = IngestAccepted | IngestRejected

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EVENT_TYPE_RE = /^[^.\s]+\.[^.\s]+\.[^.\s]+$/u
const MAX_DATE_EPOCH_MS = 8.64e15

export function ingestExternalEvent(raw: unknown, options: IngestOptions = {}): IngestResult {
  const cfg = validateOptions(options)
  if ('rejected' in cfg) return reject(cfg.rejected.reason, cfg.rejected.detail)

  if (cfg.enabled !== true) {
    return reject('disabled-by-default', 'options.enabled must be explicitly true')
  }
  if (cfg.allowedSources.length === 0) {
    return reject('empty-allowlist', 'allowedSources must contain at least one exact tuple')
  }

  if (typeof raw !== 'string') {
    return reject('input-not-a-string', 'raw must be a serialized JSON string')
  }

  const inputBytes = Buffer.byteLength(raw, 'utf8')
  if (inputBytes > cfg.maxBytes) {
    return reject('input-too-large', 'serialized envelope exceeds maxBytes', inputBytes)
  }

  let envelope: unknown
  try {
    envelope = JSON.parse(raw)
  } catch {
    return reject('malformed-json', 'serialized envelope is not valid JSON', inputBytes)
  }

  if (!isRecord(envelope)) {
    return reject('missing-required-field', 'envelope must be a JSON object', inputBytes)
  }

  if (envelope.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    return reject('unsupported-schema-version', 'schema_version must be w2a/0.1', inputBytes)
  }

  if (typeof envelope.signal_id !== 'string' || !UUID_RE.test(envelope.signal_id)) {
    return reject('malformed-uuid', 'signal_id must be a UUID-shaped string', inputBytes)
  }

  if (!isValidEpochMs(envelope.emitted_at)) {
    return reject('malformed-timestamp', 'emitted_at must be a non-negative integer epoch ms in Date range', inputBytes)
  }

  if (!isRecord(envelope.source)) {
    return reject('missing-required-field', 'source must be a JSON object', inputBytes)
  }

  const source = envelope.source
  const sensorId = readNonEmptyString(source.sensor_id)
  const packageName = readNonEmptyString(source.package)
  const sensorVersion = readNonEmptyString(source.sensor_version)
  const sourceType = readNonEmptyString(source.source_type)
  const userIdentity = readNonEmptyString(source.user_identity)
  if (sensorId === null || packageName === null || sensorVersion === null || sourceType === null || userIdentity === null) {
    return reject(
      'missing-required-field',
      'source.{sensor_id,package,sensor_version,source_type,user_identity} must be non-empty strings',
      inputBytes,
    )
  }

  if (!isRecord(envelope.event)) {
    return reject('missing-required-field', 'event must be a JSON object', inputBytes)
  }

  const event = envelope.event
  const eventType = readNonEmptyString(event.type)
  if (eventType === null || !EVENT_TYPE_RE.test(eventType)) {
    return reject('malformed-event-type', 'event.type must be a domain.entity.action string with three non-empty dot-separated segments', inputBytes)
  }
  if (!isValidEpochMs(event.occurred_at)) {
    return reject('malformed-timestamp', 'event.occurred_at must be a non-negative integer epoch ms in Date range', inputBytes)
  }
  if (typeof event.summary !== 'string' || event.summary.length < 20) {
    return reject('malformed-summary', 'event.summary must be at least 20 characters and is never returned', inputBytes)
  }

  const tupleAllowed = cfg.allowedSources.some((tuple) =>
    tuple.sensorId === sensorId &&
    tuple.package === packageName &&
    tuple.sensorVersion === sensorVersion &&
    tuple.sourceType === sourceType,
  )
  if (!tupleAllowed) {
    return reject('tuple-not-allowed', 'source tuple is not in caller allowlist', inputBytes)
  }

  return {
    ok: true,
    kind: 'ingested',
    inputBytes,
    metadata: {
      trust: 'untrusted',
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      signalId: envelope.signal_id,
      emittedAt: envelope.emitted_at,
      occurredAt: event.occurred_at,
      sensorId,
      sourceType,
      package: packageName,
      sensorVersion,
      eventType,
    },
  }
}

function reject(reason: RejectionReason, detail: string, inputBytes = 0): IngestRejected {
  return { ok: false, kind: 'rejected', reason, detail, inputBytes }
}

interface ValidatedOptions {
  enabled: boolean
  allowedSources: readonly AllowedSourceTuple[]
  maxBytes: number
}

function validateOptions(options: IngestOptions): { rejected: { reason: RejectionReason; detail: string } } | ValidatedOptions {
  if (!isRecord(options)) {
    return { rejected: { reason: 'invalid-options', detail: 'options must be a plain object' } }
  }

  const enabled = options.enabled === true
  const maxBytes = options.maxBytes ?? ABSOLUTE_MAX_BYTES
  if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || !Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > ABSOLUTE_MAX_BYTES) {
    return { rejected: { reason: 'invalid-options', detail: `maxBytes must be an integer in [1, ${ABSOLUTE_MAX_BYTES}]` } }
  }

  const rawAllowedSources = options.allowedSources ?? []
  if (!Array.isArray(rawAllowedSources)) {
    return { rejected: { reason: 'invalid-options', detail: 'allowedSources must be an array' } }
  }

  const allowedSources: AllowedSourceTuple[] = []
  for (const tuple of rawAllowedSources) {
    if (!isRecord(tuple)) {
      return { rejected: { reason: 'malformed-options-tuple', detail: 'allowedSources entry must be an object' } }
    }
    const sensorId = readNonEmptyString(tuple.sensorId)
    const packageName = readNonEmptyString(tuple.package)
    const sensorVersion = readNonEmptyString(tuple.sensorVersion)
    const sourceType = readNonEmptyString(tuple.sourceType)
    if (sensorId === null || packageName === null || sensorVersion === null || sourceType === null) {
      return { rejected: { reason: 'malformed-options-tuple', detail: 'tuple fields must be non-empty strings' } }
    }
    allowedSources.push({ sensorId, package: packageName, sensorVersion, sourceType })
  }

  return { enabled, allowedSources, maxBytes }
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidEpochMs(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_DATE_EPOCH_MS
}
