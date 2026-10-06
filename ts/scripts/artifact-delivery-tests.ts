/** Successful bounded renders produce native delivery events; failures and escaped paths never do. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const moduleUrl = new URL('../src/artifact-delivery.ts', import.meta.url).href
const delivery = await import(moduleUrl).catch(() => undefined)
assert.equal(typeof delivery?.registerArtifactDeliveries, 'function', 'bounded render tools must publish native file deliveries')
const root = mkdtempSync(join(tmpdir(), 'gotry-artifact-delivery-'))
try {
  const path = join(root, 'trip.html')
  writeFileSync(path, '<h1>Trip</h1>')
  let observe: (exec: any, result: any) => void = () => { throw new Error('observer absent') }
  const events: Array<{ name: string; value: any }> = []
  const session = { header: { cwd: root }, view: () => ({ getSnapshot: () => ({ openTurnStartSeq: 1, lastTurn: 7 }) }),
    append: (name: string, value: any) => events.push({ name, value }) }
  delivery!.registerArtifactDeliveries({ get: () => ({ stateOf: () => ({ openTurnStartSeq: 1, lastTurn: 7 }) }),
    on: (name: string, fn: typeof observe) => { assert.equal(name, 'tools/result'); observe = fn } })
  const exec = { name: 'gotry_itinerary_render', callId: 'render-1', agent: { session }, signal: new AbortController().signal }
  observe(exec, { isError: false, value: { ok: true, path } })
  assert.deepEqual(events, [{ name: 'deliverables/presented', value: { turn: 7, callId: 'render-1', files: [{ path, description: 'GoTry itinerary' }] } }])
  for (const value of [{ ok: false, path }, { ok: true, path: join(root, 'missing.html') }, { ok: true, path: join(root, '..', 'private.html') }]) observe(exec, { isError: false, value })
  observe({ ...exec, name: 'gotry_artifacts_read' }, { isError: false, value: { ok: true, path } })
  observe(exec, { isError: true, value: { ok: true, path } })
  assert.equal(events.length, 1)
  console.log('GoTry native artifact deliveries: real bounded render only PASS')
} finally { rmSync(root, { recursive: true, force: true }) }
