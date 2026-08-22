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
  const { reply } = await runTurn(state, turn, llm, [...history], solveUnified as never)
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
