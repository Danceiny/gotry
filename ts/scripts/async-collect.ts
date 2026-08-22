/**
 * 异步工单回收(S5 编排半段):加载持久化工单,执行深度规划,交付物落盘。
 * 可由任何后续进程执行(loopx 驱动的 tick、人工、未来的通知系统)——
 * 「一小时后回来」从此跨进程成立。
 * 运行(在 ts/ 下):npx tsx scripts/async-collect.ts <ticketId>
 */

import { loadAsyncTicket, settleAsyncTicket, collectDeepPlanning } from '../src/loop.ts'
import { solveUnified } from '../src/unified.ts'

const ticketId = process.argv[2]
if (!ticketId) {
  console.error('用法:npx tsx scripts/async-collect.ts <ticketId>(工单在 gotry-state/async/)')
  process.exit(1)
}

const loaded = await loadAsyncTicket(ticketId)
if (!loaded) {
  console.error(`工单 ${ticketId} 不存在(gotry-state/async/${ticketId}.json)`)
  process.exit(1)
}

const { reply } = await collectDeepPlanning(loaded.state, loaded.ticket, solveUnified as never)
const out = await settleAsyncTicket(ticketId, reply)
console.log(`交付物已落盘:ts/${out}\n\n${reply}`)
