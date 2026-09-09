/**
 * Issue #308 site-consent 反例(隔离纯函数):同一会话内,先批准 dida 站点,
 * 再调 ctrip-flight 应被识别为不同站点,重新弹卡(ask/allow 视态);当前 main
 * 行为错误:返回 'allow' 并复用 ctrip-flight 站点 grant 集,等价于把 dida
 * 静默授权到 ctrip-flight。脚本在断言失败时退出码 1。
 *
 * 独立运行:pnpm --filter @gotry/plugin exec tsx scripts/site-consent-repro.ts
 */
import { createConsentGate, type ApprovalSeam, type ConsentDecision } from '../capabilities/session-consent.ts'

const next = async (): Promise<ConsentDecision> => ({ kind: 'allow' })
const agent = { id: 'agent-repro' } as unknown as object
let requests = 0
const seam: ApprovalSeam = {
  request: async () => { requests += 1; return 'allowed-once' },
}
const gate = createConsentGate({ access: () => 'ask', approval: () => seam })

// 1) 首次 dida:弹卡 + 通过
const r1 = await gate({ name: 'gotry_session_search', agent, callId: 'c-dida', arguments: { kind: 'dida' } }, next)
const d1 = r1.kind
// 2) 再调 ctrip-flight:应被视为另一站点 → 弹卡(requests 从 1 → 2)且 reason 标「携程机票」
const r2 = await gate({ name: 'gotry_session_search', agent, callId: 'c-ctrip', arguments: { kind: 'flight' } }, next)
const d2 = r2.kind
// 3) 拒绝 dida 后再调 ctrip-flight:不互相影响
const seamReject: ApprovalSeam = { request: async () => 'rejected' }
const gateReject = createConsentGate({ access: () => 'ask', approval: () => seamReject })
const dRej1 = (await gateReject({ name: 'gotry_session_search', agent, callId: 'c-dida', arguments: { kind: 'dida' } }, next)).kind
const dRej2 = (await gateReject({ name: 'gotry_session_search', agent, callId: 'c-ctrip', arguments: { kind: 'flight' } }, next)).kind

// 4) 未知 kind fail-closed
const dUnknown = (await gate({ name: 'gotry_session_search', agent, callId: 'c-xx', arguments: { kind: 'not-a-kind' } }, next)).kind

// 5) 同站复用(flight→flight)仍直接放行,只弹一次
const seam3: ApprovalSeam = { request: async () => { requests += 1; return 'allowed-once' } }
const gate3 = createConsentGate({ access: () => 'ask', approval: () => seam3 })
const a1 = (await gate3({ name: 'gotry_session_search', agent, callId: 'c-a1', arguments: { kind: 'flight' } }, next)).kind
const a2 = (await gate3({ name: 'gotry_session_search', agent, callId: 'c-a2', arguments: { kind: 'flight' } }, next)).kind

// 6) wrapped args({ query: { kind: 'hotel' } })必须识别为 ctrip-hotel
const seam6: ApprovalSeam = { request: async () => { requests += 1; return 'allowed-once' } }
const gate6 = createConsentGate({ access: () => 'ask', approval: () => seam6 })
const w1 = (await gate6({ name: 'gotry_session_search', agent, callId: 'c-w1', arguments: { query: { kind: 'hotel' } } }, next)).kind

const summary = { d1, d2, dRej1, dRej2, dUnknown, a1, a2, w1, requests }
console.log('REPRO:', JSON.stringify(summary))

let failed = 0
if (d1 !== 'allow') { console.error('FAIL: 首次 dida 未放行'); failed += 1 }
if (d2 !== 'allow' || requests < 2) { console.error('FAIL: ctrip-flight 未被弹卡(dida 同意后)'); failed += 1 }
if (dRej1 !== 'deny') { console.error('FAIL: dida 拒绝未 deny'); failed += 1 }
if (dRej2 !== 'deny') { console.error('FAIL: ctrip-flight 在 dida 拒绝场景下被复用'); failed += 1 }
if (dUnknown === 'allow') { console.error('FAIL: 未知 kind 直接放行'); failed += 1 }
if (a1 !== 'allow' || a2 !== 'allow') { console.error('FAIL: 同站缓存未生效'); failed += 1 }
if (w1 !== 'allow') { console.error('FAIL: wrapped args 未识别 kind'); failed += 1 }

if (failed > 0) {
  console.error(`REPRO 失败 ${failed} 项`)
  process.exit(1)
}
console.log('REPRO 全过(bug 已修)')
