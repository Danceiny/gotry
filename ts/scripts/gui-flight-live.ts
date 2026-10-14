/**
 * GUI 车道 live 验证入口(GOTRY_GUI_LIVE=1 显式 opt-in;默认 SKIP 不开窗口——
 * 与 session-tests 的 GOTRY_SESSION_LIVE 测试纪律同构)。
 * 匿名只读:gotry 自己的隔离 Chrome 窗口驱动携程 PC 表单,不登录、不下单。
 */
import { sessionFlightGuiSearch } from '../capabilities/session-search.ts'

const roll = new Date(Date.now() + 30 * 24 * 3600 * 1000)
const dep = `${roll.getFullYear()}-${String(roll.getMonth() + 1).padStart(2, '0')}-${String(roll.getDate()).padStart(2, '0')}`
const rollBack = new Date(Date.now() + 34 * 24 * 3600 * 1000)
const back = `${rollBack.getFullYear()}-${String(rollBack.getMonth() + 1).padStart(2, '0')}-${String(rollBack.getDate()).padStart(2, '0')}`

if (process.env.GOTRY_GUI_LIVE !== '1') {
  console.log('SKIP - GOTRY_GUI_LIVE!=1(GUI 车道 live 验证未开;离线契约见 session-tests §L)')
  process.exit(0)
}

console.log(`live #1 单程 上海→丽江 ${dep}`)
const r1 = await sessionFlightGuiSearch({ from: '上海', to: '丽江', date: dep, timeoutMs: 120_000 })
console.log(JSON.stringify({ ok: r1.ok, verdict: r1.verdict, options: r1.options?.length, evidence: r1.evidence, error: r1.error?.slice(0, 900) }, null, 2))
if (r1.verdict === 'hit') console.log('  首条:', JSON.stringify(r1.options?.[0]))

if (process.argv[2] === 'oneway') process.exit(0)
console.log(`live #2 往返 香港→迪拜 ${dep} / ${back}(等 31s 节律)`)
await new Promise(r => setTimeout(r, 31_000))
const r2 = await sessionFlightGuiSearch({ from: '香港', to: '迪拜', date: dep, backDate: back, timeoutMs: 120_000 })
console.log(JSON.stringify({ ok: r2.ok, verdict: r2.verdict, options: r2.options?.length, evidence: r2.evidence, error: r2.error?.slice(0, 900) }, null, 2))
if (r2.verdict === 'hit') console.log('  首条:', JSON.stringify(r2.options?.[0]))
