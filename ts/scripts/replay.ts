/**
 * S2 重放:真实对话的用户侧(压缩版)喂给循环,mock-LLM 扮演智能侧。
 * 运行(在 ts/ 下):npx tsx scripts/replay.ts
 * 验收:① 日历一次断言零反复 ② 系统先问工作窗口与已订资源(Kimi 第 6 轮才问)
 *       ③ 用户提供后 profile 填充,访谈收敛
 */

import { createMockLlm } from '../src/mock-llm.ts'
import { interviewNext, newState, runTurn } from '../src/loop.ts'
import { solveUnified } from '../src/unified.ts'
import { join } from 'node:path'

const llm = createMockLlm(join('..', 'data', 'flights_2026.json'))
let state = newState()

const userTurns = [
  '7.17周五22:40落地深圳,7.18早上去香港办银行开户&保险签约;争取7.18当天飞泰国普吉岛……8.10周一凌晨从深圳起飞,周一上班前到迪拜。请给我做机票和酒店的行程规划和推荐。',
  '我的工作时间是UTC+4的早上10点到下午7点,晚上不一定有时间(至少得带电脑保持在线)',
  '我订了酒店:The Title East Wing Rawai,7.18入住 7.23 退房',
]

const history: Array<{ role: 'user' | 'assistant'; text: string }> = []
for (const turn of userTurns) {
  const { reply } = await runTurn(state, turn, llm, [...history], ((spec: Parameters<typeof solveUnified>[0]) => { spec.skeletonHub = true; return solveUnified(spec) }) as never)
  history.push({ role: 'user', text: turn }, { role: 'assistant', text: reply })
  console.log(`\n用户> ${turn.slice(0, 50)}…`)
  console.log(`GoTry> ${reply}`)
}

console.log('\n===== 终态校验 =====')
console.log('日历断言数:', Object.keys(state.calendar.assertedWeekdays).length,
  '| 2026-07-17 =', state.calendar.assertedWeekdays['2026-07-17'])
console.log('workWindow:', state.profile.workWindow
  ? `${state.profile.workWindow.startMin / 60}:00-${state.profile.workWindow.endMin / 60}:00 UTC+${state.profile.workWindow.homeTzOffsetMin / 60}(证据:${state.profile.workWindow.evidence.slice(0, 24)}…)`
  : '缺失')
console.log('bookedResources:', state.profile.bookedResources?.map(b => b.ref).join('; ') ?? '缺失')
const { missing } = interviewNext(state)
console.log('剩余待问:', missing.length === 0 ? '无(除预算档未答,见下)' : missing.join(','))

// 终态断言——进 CI 的硬门槛:日历零反复、首轮问出工作窗口与已订资源、访谈收敛到只剩预算档
const weekday = state.calendar.assertedWeekdays['2026-07-17']
if (weekday !== 'fri') throw new Error(`FAIL: 2026-07-17 应为 fri,实为 ${weekday}`)
if (!state.profile.workWindow?.evidence) throw new Error('FAIL: workWindow 缺失或无证据')
if (!state.profile.bookedResources?.length) throw new Error('FAIL: bookedResources 缺失')
if (!(missing.length === 1 && missing[0] === 'budgetTier')) throw new Error(`FAIL: 剩余待问应为 [budgetTier],实为 [${missing.join(',')}]`)
console.log('REPLAY ASSERTS OK')

// ---- D-10 切片 C:spec↔槽位日期一致性闸 ------------------------------------------
// 两个面:① 单日期段 + 冲突槽位 → 闸拦下求解并追问,不猜、不静默采信;
// ② 多段行程(pack 全 spec)→ 槽位 v1 无逐段真值,闸必须旁路(2026-08-28 巡检
// 修正的回归:金标准六段行程曾被全段误判分歧,求解被永久拦截)。
{
  const conflictScript = [{
    when: '重新算一下',
    extraction: {
      schema_version: 'travel_slot_extraction.v1' as const,
      language: 'zh' as const,
      domains: ['requisition' as const],
      slots: { requisition: { mode: 'create', destination: '普吉岛', start_date: '2026-12-25', trip_type: 'round_trip' } },
      missing_slots: [] as string[],
    },
  }]
  const solvePort = ((spec: Parameters<typeof solveUnified>[0]) => { spec.skeletonHub = true; return solveUnified(spec) }) as never

  // ① 单日期段:分歧 → 拦截 + 追问 + 不求解
  const base = createMockLlm(join('..', 'data', 'flights_2026.json'), conflictScript)
  const singleSpecLlm: typeof base = {
    ...base,
    extractSpec: async () => ({
      segments: [{ id: 's1', role: 'choice', date: '2026-07-01', options: [{ id: 'o1', label: 'o1', move: { hub: 'SZX', services: [{ id: 'f1', depMin: 600, arrMin: 700 }], bufferMin: 60, originTransferMin: 30, destTransferMin: 30 } }] }],
    }) as never,
  }
  const state1 = structuredClone(state)
  const solveBefore = state1.solve
  const r1 = await runTurn(state1, '12月25日出发,重新算一下', singleSpecLlm, [...history], solvePort)
  if (!r1.reply.includes('日期分歧')) throw new Error(`FAIL: 单日期段分歧应被闸拦下,实际:${r1.reply.slice(0, 160)}`)
  if (r1.state.solve !== solveBefore) throw new Error('FAIL: 分歧时不应求解(spec 日期未确认)')

  // ② 多段行程:闸旁路 → 正常求解(无日期分歧文案)
  const state2 = structuredClone(state)
  const r2 = await runTurn(state2, '重新算一下', base, [...history], solvePort)
  if (r2.reply.includes('日期分歧')) throw new Error(`FAIL: 多段行程应旁路日期闸(无逐段真值不判),实际:${r2.reply.slice(0, 160)}`)
  if (!r2.state.solve) throw new Error('FAIL: 多段旁路后应正常求解')
  console.log('SPEC-SLOT DATE GATE OK(单日期段分歧拦截 + 多段旁路不误伤)')
}
