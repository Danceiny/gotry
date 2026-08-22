/**
 * 真实重放(S4 验收入口):有 DEEPSEEK_API_KEY 走真 LLM,无则明确回退 mock。
 * 运行(在 ts/ 下):npx tsx scripts/replay-real.ts
 * S4 验收:同一开场白,真实对话质量 ≥ mock 重放(Kimi 复盘的验收标准)。
 */

import { join } from 'node:path'
import { createMockLlm } from '../src/mock-llm.ts'
import { createDeepSeekLlm } from '../src/dsh-llm.ts'
import { newState, runTurn } from '../src/loop.ts'
import { solveUnified } from '../src/unified.ts'
import type { LlmPort } from '../src/loop.ts'

const useReal = Boolean(process.env['DEEPSEEK_API_KEY'])
const llm: LlmPort = useReal ? createDeepSeekLlm() : createMockLlm(join('..', 'data', 'flights_2026.json'))
console.log(useReal ? '=== 真 LLM 模式(DeepSeek)===' : '=== 无 DEEPSEEK_API_KEY,回退 mock(ADR-8)===\n')

const state = newState()
const history: Array<{ role: 'user' | 'assistant'; text: string }> = []
const turns = [
  '7.17周五22:40落地深圳,7.18早上去香港办银行开户&保险签约;争取7.18当天飞泰国普吉岛……8.10周一凌晨从深圳起飞,周一上班前到迪拜。请给我做机票和酒店的行程规划和推荐。',
  '我的工作时间是UTC+4的早上10点到下午7点',
  '我订了酒店:The Title East Wing Rawai,7.18入住 7.23 退房',
]
for (const t of turns) {
  const { reply } = await runTurn(state, t, llm, [...history], solveUnified as never)
  history.push({ role: 'user', text: t }, { role: 'assistant', text: reply })
  console.log(`\n用户> ${t.slice(0, 46)}…\nGoTry> ${reply}`)
}
