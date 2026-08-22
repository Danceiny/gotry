/**
 * S5 架构段重放:异步深度规划的会话形态(mock,零 API key)。
 * 运行(在 ts/ 下):npx tsx scripts/replay-async.ts
 * 验收:复杂行程 → 「一小时后回来看看」→ 回访交付已验证方案 + 选择题,不失望四条 4/4。
 */

import { join } from 'node:path'
import { createMockLlm } from '../src/mock-llm.ts'
import { collectDeepPlanning, isComplex, newState, persistAsyncTicket, requestDeepPlanning, runTurn } from '../src/loop.ts'
import { solveUnified } from '../src/unified.ts'

const llm = createMockLlm(join('..', 'data', 'flights_2026.json'))
const state = newState()
const history: Array<{ role: 'user' | 'assistant'; text: string }> = []

// 前三轮与 replay 相同:brief → 工作时间 → 已订酒店
const turns = [
  '7.17周五22:40落地深圳……8.10周一凌晨从深圳起飞周一上班前到迪拜。请给我做机票和酒店的行程规划和推荐。',
  '我的工作时间是UTC+4的早上10点到下午7点',
  '我订了酒店:The Title East Wing Rawai,7.18入住 7.23 退房',
]
let lastReply = ''
for (const t of turns) {
  const { reply } = await runTurn(state, t, llm, [...history], solveUnified as never)
  history.push({ role: 'user', text: t }, { role: 'assistant', text: reply })
  lastReply = reply
}

// 第 4 轮:复杂度命中 → 切深度规划模式;工单持久化(跨进程存续,S5 编排半段)
if (!isComplex(state)) throw new Error('复杂度判据未命中,重放脚本与判据不一致')
const { reply: asyncReply, ticket } = await requestDeepPlanning(state)
const saved = await persistAsyncTicket(ticket, state)
console.log('用户> (约束齐备,行程复杂)\n')
console.log(`GoTry> ${asyncReply}\n`)
console.log(`(工单已持久化:${saved}——任意后续进程可执行回收)\n`)

// 模拟一小时(mock 期秒级)——真实形态:另一个进程/loopx tick 执行 async-collect
console.log('……(一小时后,另一个进程执行回收)……\n')
const { reply: deliverable } = await collectDeepPlanning(state, ticket, solveUnified as never)
console.log(`GoTry> ${deliverable}`)
console.log(`\n(真实形态命令:npx tsx scripts/async-collect.ts ${ticket.id})`)
