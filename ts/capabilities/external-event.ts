/**
 * Issue #82 (D-31): external event seam for w2a-shaped sensor inputs.
 *
 * Pure-function adapter that maps a sensor envelope (untrusted instruction source
 * per w2a model) to a normalized `ExternalEvent` record and refuses to write
 * any shared product state. Activation is default-off: the adapter never
 * triggers a network call, never touches `ts/gotry-state/`, and never reaches
 * the M4/M5/M6 admission gates (#20/#22/#136/#137/#142).
 *
 * Contract (founder-confirmation required for runtime activation, not for
 * this contract layer):
 *   - Sensor envelope is treated as untrusted input; every payload field is
 *     validated structurally before any mapping runs.
 *   - Mapping is pure: deterministic, no I/O, no global state reads.
 *   - The only side effect is the returned `ExternalEvent` (caller's choice).
 *   - Payload sizes are bounded to keep the mapping O(1).
 */

export interface SensorEnvelope {
  sensor_id: string
  schema_version: string
  emitted_at: string
  topic: string
  payload: Record<string, unknown>
  signature: string | null
}

export interface ExternalEvent {
  kind: 'weather' | 'transit' | 'lodging' | 'currency' | 'trip-context' | 'unknown'
  severity: 'info' | 'advisory' | 'blocking'
  sourceTopics: readonly string[]
  observedAt: string
  trustLevel: 'untrusted-sensor'
  raw: SensorEnvelope
}

export interface ExternalEventEnvelopeError {
  kind: 'malformed' | 'oversize' | 'stale' | 'unknown-schema' | 'missing-field'
  detail: string
}

const MAX_TOPIC_LEN = 128
const MAX_PAYLOAD_KEYS = 64
const MAX_PAYLOAD_DEPTH = 4
const MAX_FIELD_LEN = 4096
const STALE_MS = 5 * 60 * 1000
const SUPPORTED_SCHEMAS = new Set(['w2a/1'])

function err(kind: ExternalEventEnvelopeError['kind'], detail: string): ExternalEventEnvelopeError {
  return { kind, detail }
}

function isString(x: unknown): x is string {
  return typeof x === 'string'
}

function boundedDepth(x: unknown, depth: number): boolean {
  if (depth > MAX_PAYLOAD_DEPTH) return false
  if (x === null || typeof x !== 'object') return true
  if (Array.isArray(x)) return x.every((v) => boundedDepth(v, depth + 1))
  const o = x as Record<string, unknown>
  if (Object.keys(o).length > MAX_PAYLOAD_KEYS) return false
  return Object.values(o).every((v) => boundedDepth(v, depth + 1))
}

function inferKind(topic: string): ExternalEvent['kind'] {
  const t = topic.toLowerCase()
  if (/\b(weather|rain|temp|typhoon|storm|forecast)\b/.test(t)) return 'weather'
  if (/\b(train|flight|bus|ferry|metro|subway|transit)\b/.test(t)) return 'transit'
  if (/\b(hotel|lodging|hostel|airbnb|booking)\b/.test(t)) return 'lodging'
  if (/\b(currency|fx|exchange|rate)\b/.test(t)) return 'currency'
  if (/\b(trip|itinerary|context|user)\b/.test(t)) return 'trip-context'
  return 'unknown'
}

function inferSeverity(payload: Record<string, unknown>): ExternalEvent['severity'] {
  for (const k of ['severity', 'level', 'priority']) {
    const v = payload[k]
    if (isString(v)) {
      const x = v.toLowerCase()
      if (x === 'blocking' || x === 'critical' || x === 'high') return 'blocking'
      if (x === 'advisory' || x === 'warning' || x === 'medium') return 'advisory'
    }
  }
  return 'info'
}

export function adaptSensorEnvelope(env: unknown): ExternalEvent | ExternalEventEnvelopeError {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return err('malformed', 'envelope must be a JSON object')
  }
  const e = env as Record<string, unknown>
  if (!isString(e.sensor_id) || e.sensor_id.length === 0 || e.sensor_id.length > 128) {
    return err('missing-field', 'sensor_id must be a non-empty string ≤128 chars')
  }
  if (!isString(e.schema_version) || e.schema_version.length === 0) {
    return err('missing-field', 'schema_version must be a non-empty string')
  }
  if (!SUPPORTED_SCHEMAS.has(e.schema_version)) {
    return err('unknown-schema', `unsupported schema_version ${e.schema_version}; supported=${[...SUPPORTED_SCHEMAS].join(',')}`)
  }
  if (!isString(e.emitted_at)) {
    return err('missing-field', 'emitted_at must be an ISO-8601 string')
  }
  const ts = Date.parse(e.emitted_at)
  if (Number.isNaN(ts)) {
    return err('malformed', 'emitted_at is not a valid ISO-8601 timestamp')
  }
  if (Date.now() - ts > STALE_MS) {
    return err('stale', `event ${STALE_MS / 1000}s older than now`)
  }
  if (!isString(e.topic) || e.topic.length === 0 || e.topic.length > MAX_TOPIC_LEN) {
    return err('missing-field', `topic must be 1..${MAX_TOPIC_LEN} chars`)
  }
  if (!('payload' in e) || typeof e.payload !== 'object' || e.payload === null || Array.isArray(e.payload)) {
    return err('malformed', 'payload must be a JSON object')
  }
  if (!boundedDepth(e.payload, 0)) {
    return err('oversize', `payload exceeds bounds (≤${MAX_PAYLOAD_KEYS} keys, depth ≤${MAX_PAYLOAD_DEPTH})`)
  }
  for (const v of Object.values(e.payload as Record<string, unknown>)) {
    if (isString(v) && v.length > MAX_FIELD_LEN) {
      return err('oversize', `payload string field exceeds ${MAX_FIELD_LEN} chars`)
    }
  }
  if (e.signature !== null && e.signature !== undefined && !isString(e.signature)) {
    return err('malformed', 'signature must be string|null|undefined')
  }
  const envelope: SensorEnvelope = {
    sensor_id: e.sensor_id,
    schema_version: e.schema_version,
    emitted_at: e.emitted_at,
    topic: e.topic,
    payload: e.payload as Record<string, unknown>,
    signature: isString(e.signature) ? e.signature : null,
  }
  return {
    kind: inferKind(envelope.topic),
    severity: inferSeverity(envelope.payload),
    sourceTopics: Object.freeze([envelope.topic]),
    observedAt: envelope.emitted_at,
    trustLevel: 'untrusted-sensor',
    raw: envelope,
  }
}

export function isExternalEvent(v: ExternalEvent | ExternalEventEnvelopeError): v is ExternalEvent {
  return (v as ExternalEvent).trustLevel === 'untrusted-sensor'
}
