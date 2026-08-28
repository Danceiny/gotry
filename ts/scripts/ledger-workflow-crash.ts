/**
 * 崩溃注入探针(ledger-tests 的子进程):创建 durable 工单 → 求解(step done 落账)
 * → 在 settle 之前 kill 自身(exit 9)——模拟「一小时后」回收进程中途崩溃。
 * 用法:npx tsx scripts/ledger-workflow-crash.ts <stateRoot> <ticketId> <countFile>
 */

import { appendFileSync } from 'node:fs'
import { collectDeepPlanning, makeJournaledSolvePort, persistAsyncTicket, type AsyncTicket } from '../src/loop.ts'
import type { TripState } from '../src/contracts.ts'
import { openLedgerIfExists } from '../src/state-ledger.ts'

const [root, id, countFile] = process.argv.slice(2)
if (!root || !id || !countFile) {
  console.error('用法:npx tsx scripts/ledger-workflow-crash.ts <stateRoot> <ticketId> <countFile>')
  process.exit(1)
}

const ticket: AsyncTicket = {
  id,
  objective: '崩溃注入:已求解未交付(settle 前被杀)',
  requestedAt: new Date().toISOString(),
  etaLabel: '秒级',
}
const state = {
  calendar: { year: 2026, assertedWeekdays: {} },
  profile: {},
  gates: [],
  wishes: [],
  spec: { segments: [] },
} as unknown as TripState
await persistAsyncTicket(ticket, state, root)

const ledger = openLedgerIfExists(root)!
const solve = makeJournaledSolvePort(
  ledger,
  id,
  async () => ({ feasible: false, unsat_core: ['crash-probe'], suggestions: [] }) as never,
  { onRealSolve: () => appendFileSync(countFile, 'solve\n') },
)
await collectDeepPlanning(state, ticket, solve)

// solve 步骤已 done 落账,交付未落——此刻崩掉
process.exit(9)
