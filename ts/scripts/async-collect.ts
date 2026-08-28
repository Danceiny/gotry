/**
 * 异步工单回收(S5 编排半段 → ADR-15 durable 恢复语义):加载持久化工单,
 * 经可日志化 solve 端口执行深度规划(done 步骤复用账本结果,不重执行),
 * 交付物落账本 + .deliverable.md 视图。可由任何后续进程执行(loopx 驱动的
 * tick、state-cli tick、人工、未来的通知系统)——「一小时后回来」跨进程成立,
 * 且崩溃恢复 exactly-once:重放不重复花钱。
 * 运行(在 ts/ 下):npx tsx scripts/async-collect.ts <ticketId> [stateRoot]
 * 环境变量 GOTRY_SOLVE_COUNT_FILE:每次真实求解追加一行(回归用计数探针)。
 */

import { appendFileSync } from 'node:fs'
import { collectDeepPlanning, loadAsyncTicket, makeJournaledSolvePort, settleAsyncTicket } from '../src/loop.ts'
import { solveUnified } from '../src/unified.ts'
import { openLedgerIfExists } from '../src/state-ledger.ts'

const ticketId = process.argv[2]
const stateRoot = process.argv[3] ?? '.'
if (!ticketId) {
  console.error('用法:npx tsx scripts/async-collect.ts <ticketId> [stateRoot](权威在账本 workflow_runs,视图在 gotry-state/async/)')
  process.exit(1)
}

const loaded = await loadAsyncTicket(ticketId, stateRoot)
if (!loaded) {
  console.error(`工单 ${ticketId} 不存在(账本 workflow_runs / gotry-state/async/${ticketId}.json)`)
  process.exit(1)
}

// 终态幂等:已 settled 的工单复诵账本交付物,零重算
const ledger = openLedgerIfExists(stateRoot)
const run = ledger?.getWorkflowRun(ticketId)
if (run?.status === 'settled' && run.deliverable) {
  console.log(`工单 ${ticketId} 已交付(账本终态,复诵不重算):\n\n${run.deliverable}`)
  process.exit(0)
}
if (!ledger) {
  console.error(`工单 ${ticketId}:stateRoot(${stateRoot})无账本——持久化先于回收,不应发生`)
  process.exit(1)
}

const solve = makeJournaledSolvePort(ledger, ticketId, solveUnified as never, {
  onRealSolve: () => {
    const f = process.env['GOTRY_SOLVE_COUNT_FILE']
    if (f) appendFileSync(f, 'solve\n')
  },
})

const { reply } = await collectDeepPlanning(loaded.state, loaded.ticket, solve)
const out = await settleAsyncTicket(ticketId, reply, stateRoot)
console.log(`交付物已落盘:${out}\n\n${reply}`)
