/**
 * Issue #82 (D-31): regression matrix for `adaptSensorEnvelope`.
 * All cases deterministic; zero network; no shared state writes.
 */
import assert from 'node:assert/strict'
import {
  adaptSensorEnvelope,
  isExternalEvent,
  type ExternalEvent,
  type ExternalEventEnvelopeError,
  type SensorEnvelope,
} from '../capabilities/external-event.ts'

function good(): SensorEnvelope {
  return {
    sensor_id: 'w2a-sensor-weather-1',
    schema_version: 'w2a/1',
    emitted_at: new Date().toISOString(),
    topic: 'weather.alert.typhoon-typhoon-mawar',
    payload: { severity: 'high', region: 'JP-OKINAWA', eta_hours: 6 },
    signature: null,
  }
}

function errDetail(v: ExternalEventEnvelopeError): string {
  return `${v.kind}:${v.detail}`
}

function runAllCases(): void {
  const ok = adaptSensorEnvelope(good())
  assert.ok(isExternalEvent(ok), 'good envelope must adapt to ExternalEvent')
  assert.equal(ok.kind, 'weather', 'weather topic maps to weather kind')
  assert.equal(ok.severity, 'blocking', 'severity=high maps to blocking')
  assert.equal(ok.trustLevel, 'untrusted-sensor', 'trust is untrusted-sensor by default')
  assert.ok(Object.isFrozen(ok.sourceTopics), 'sourceTopics frozen to prevent caller mutation')

  const stale = good()
  stale.emitted_at = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const staleR = adaptSensorEnvelope(stale)
  assert.ok(!isExternalEvent(staleR), '>5min old envelope is stale')
  assert.equal((staleR as ExternalEventEnvelopeError).kind, 'stale')

  const oversize = good()
  oversize.topic = 'x'.repeat(129)
  const oSizeR = adaptSensorEnvelope(oversize)
  assert.equal((oSizeR as ExternalEventEnvelopeError).kind, 'missing-field')

  const deep = good()
  const nested: Record<string, unknown> = {}
  let cur: Record<string, unknown> = nested
  for (let i = 0; i < 5; i++) {
    const next: Record<string, unknown> = {}
    cur.next = next
    cur = next
  }
  cur.value = 1
  deep.payload = nested
  const deepR = adaptSensorEnvelope(deep)
  assert.equal((deepR as ExternalEventEnvelopeError).kind, 'oversize')

  const unknownSchema = good()
  unknownSchema.schema_version = 'w2a/2'
  const usR = adaptSensorEnvelope(unknownSchema)
  assert.equal((usR as ExternalEventEnvelopeError).kind, 'unknown-schema')

  for (const bad of [null, undefined, 'string', 42, true, [], { sensor_id: '' }]) {
    const r = adaptSensorEnvelope(bad as unknown)
    assert.ok(!isExternalEvent(r), `bad envelope (${typeof bad}) must error`)
  }

  const noSign = good()
  noSign.signature = null
  const noSignR = adaptSensorEnvelope(noSign)
  assert.ok(isExternalEvent(noSignR), 'null signature accepted')

  const multiTopic = good()
  multiTopic.topic = 'weather.alert.typhoon-typhoon-mawar'
  const r1 = adaptSensorEnvelope(multiTopic)
  assert.ok(isExternalEvent(r1))
  const trainR = adaptSensorEnvelope({ ...good(), topic: 'train.cancel.shinkansen-tokyo-osaka' })
  assert.equal(trainR.kind, 'transit', 'train.* topic maps to transit')
  const fxR = adaptSensorEnvelope({ ...good(), topic: 'fx.rate.usd-jpy' })
  assert.equal(fxR.kind, 'currency')
  const tripR = adaptSensorEnvelope({ ...good(), topic: 'trip.context.departure-gate-change' })
  assert.equal(tripR.kind, 'trip-context')
  const hotelR = adaptSensorEnvelope({ ...good(), topic: 'hotel.booking.confirmation' })
  assert.equal(hotelR.kind, 'lodging')
  const unkR = adaptSensorEnvelope({ ...good(), topic: 'random.unmapped.topic' })
  assert.equal(unkR.kind, 'unknown')

  const sevInfo = good()
  sevInfo.payload = { arbitrary: true }
  const sInfo = adaptSensorEnvelope(sevInfo) as ExternalEvent
  assert.equal(sInfo.severity, 'info', 'no severity field → info default')

  const synthesized: ExternalEvent = ok
  assert.equal(synthesized.trustLevel, 'untrusted-sensor')
  assert.equal(errDetail({ kind: 'malformed', detail: 'x' }), 'malformed:x')
}

runAllCases()
console.log('EXTERNAL EVENT TESTS: 12 cases OK (good/stale/oversize/deep/unknown-schema/bad-types/no-sig/5-kind/2-severity/pure/diagnostic)')
