/** Deterministic proof that the smoke/full-suite live gate makes zero transport calls. */
import { gatedSessionFlightSearch, offlineSessionFlightResult, sessionLiveEnabled } from '../capabilities/session-search.ts'

let calls = 0
const query = { from: '上海', to: '丽江', date: '2026-10-01' }
if (sessionLiveEnabled({ GOTRY_SESSION_LIVE: '0' })) throw new Error('GOTRY_SESSION_LIVE=0 must be offline')
if (sessionLiveEnabled({ GOTRY_SESSION_LIVE: undefined })) throw new Error('unset GOTRY_SESSION_LIVE must be offline')
const offline = await gatedSessionFlightSearch(query, async () => {
  calls += 1
  throw new Error('live transport must not be called')
}, { GOTRY_SESSION_LIVE: '0' })
if (calls !== 0) throw new Error(`offline gate invoked live transport ${calls} time(s)`)
if (offline.verdict !== 'error' || offline.ok || !offline.error?.includes('GOTRY_SESSION_LIVE=1') || !offline.evidence.includes('live transport not invoked')) {
  throw new Error(`offline result is not explicit: ${JSON.stringify(offline)}`)
}
const direct = offlineSessionFlightResult()
if (direct.verdict !== 'error' || direct.ok || !direct.evidence.includes('offline')) throw new Error('offline helper contract drifted')
console.log('SMOKE SESSION GATE: GOTRY_SESSION_LIVE!=1 makes zero live calls and returns explicit offline error')
