/**
 * 后台深度规划工单收集器(ADR-24 v2 收集闭环;async-collect 的 turn-handoff 对位)。
 *
 * 「一小时后回来看看」的后台半段:加载 open 工单 → 以 GOTRY_HANDOFF_CHILD=1
 * 派生 headless 规划会话(唯一出口 converge,不回递归)→ 捕获最终答复为
 * 交付物 → settleTurnHandoffTicket 结算(交付物 .deliverable.md + 工单状态
 * 原子更新)。终态幂等:已 settled/failed 的工单复诵交付物与终态 JSON,零
 * 重算、零再花。最后一行固定输出 gotry_turn_handoff_terminal.v1 JSON;
 * succeeded exit 0,failed exit 2。
 *
 * 运行(在 ts/ 下):
 *   npx tsx scripts/turn-handoff-collect.ts <ticketId> [stateRoot]
 *   npx tsx scripts/turn-handoff-collect.ts --all [stateRoot]
 * 环境变量:
 *   GOTRY_HANDOFF_PLANNER_BIN      规划器二进制(默认 <repo>/bin/gotry-inner.js)
 *   GOTRY_HANDOFF_PLANNER_TIMEOUT_MS 规划器硬上限(默认 900_000)
 *
 * v1 诚实边界:工单只携带用户原文,规划会话是全新上下文(fresh cwd/DSH_HOME)
 * ——原会话中已读的工作区文件/日历结论不随单迁移,由规划器按需重取。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listTurnHandoffTickets,
  settleTurnHandoffTicket,
  TURN_HANDOFF_SCHEMA,
  type TurnHandoffTicket,
} from '../src/turn-deadline.ts'

const TURN_HANDOFF_TERMINAL_SCHEMA = 'gotry_turn_handoff_terminal.v1' as const
const ROOT = join(import.meta.dirname, '..', '..')

interface TerminalOutcome {
  schema: typeof TURN_HANDOFF_TERMINAL_SCHEMA
  ticket_id: string
  status: 'succeeded' | 'failed'
  deliverable_path?: string
  error?: string
}

function emitTerminal(outcome: TerminalOutcome): never {
  console.log(JSON.stringify(outcome))
  process.exit(outcome.status === 'succeeded' ? 0 : 2)
}

function loadTicket(stateRoot: string, ticketId: string): TurnHandoffTicket | null {
  try {
    const path = join(stateRoot === '.' ? process.cwd() : stateRoot, 'gotry-state', 'turn-handoffs', `${ticketId}.json`)
    const ticket = JSON.parse(readFileSync(path, 'utf-8')) as TurnHandoffTicket
    return ticket?.schema === TURN_HANDOFF_SCHEMA ? ticket : null
  } catch {
    return null
  }
}

function replay(ticket: TurnHandoffTicket, stateRoot: string): never {
  const dir = join(stateRoot === '.' ? process.cwd() : stateRoot, 'gotry-state', 'turn-handoffs')
  emitTerminal({
    schema: TURN_HANDOFF_TERMINAL_SCHEMA,
    ticket_id: ticket.id,
    status: ticket.status === 'settled' ? 'succeeded' : 'failed',
    ...(ticket.deliverableFile ? { deliverable_path: join(dir, ticket.deliverableFile) } : {}),
    ...(ticket.error ? { error: ticket.error } : {}),
  })
}

async function runPlanner(ticket: TurnHandoffTicket): Promise<{ ok: boolean; output: string; error?: string }> {
  const plannerBin = process.env.GOTRY_HANDOFF_PLANNER_BIN ?? join(ROOT, 'bin', 'gotry-inner.js')
  if (!existsSync(plannerBin)) {
    return { ok: false, output: '', error: `planner binary unavailable: ${plannerBin}` }
  }
  const timeoutMs = Number.parseInt(process.env.GOTRY_HANDOFF_PLANNER_TIMEOUT_MS ?? '', 10) || 900_000
  const dshHome = mkdtempSync(join(tmpdir(), 'gotry-handoff-child-dsh-'))
  const childCwd = mkdtempSync(join(tmpdir(), 'gotry-handoff-child-cwd-'))
  try {
    const childEnv: NodeJS.ProcessEnv = { ...process.env }
    childEnv.DSH_HOME = dshHome
    // 递归防护(核心):子会话唯一出口 converge + 长 leash;同时清掉父进程的
    // 数值 pin 与工单根,子会话不得再 handoff、也不受测试阈值影响。
    childEnv.GOTRY_HANDOFF_CHILD = '1'
    delete childEnv.GOTRY_TURN_DEADLINE_SOFT_MS
    delete childEnv.GOTRY_TURN_DEADLINE_HARD_MS
    delete childEnv.GOTRY_TURN_HANDOFF_ROOT
    // .js/.mjs/.cjs 经当前 node 派生(测试假 planner 无执行位也成立);
    // 其余(gotry-inner.js 之外的 .bin shim、全局命令)直接执行。
    const isJsScript = /\.(js|mjs|cjs)$/.test(plannerBin)
    const child = isJsScript
      ? spawn(process.execPath, [plannerBin, ticket.userMessage], { cwd: childCwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(plannerBin, [ticket.userMessage], { cwd: childCwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    const code = await new Promise<number | null>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null) }, timeoutMs)
      child.once('exit', c => { clearTimeout(timer); resolve(c) })
    })
    if (code === null) return { ok: false, output: '', error: `planner timed out after ${timeoutMs}ms` }
    if (code !== 0) return { ok: false, output: '', error: `planner exited ${code}: ${output.trim().slice(-300)}` }
    const deliverable = output.trim()
    if (!deliverable) return { ok: false, output: '', error: 'planner produced empty output' }
    return { ok: true, output: deliverable }
  } finally {
    await new Promise<void>(resolve => setTimeout(resolve, 200))
    rmSync(dshHome, { recursive: true, force: true })
    rmSync(childCwd, { recursive: true, force: true })
  }
}

async function collectOne(stateRoot: string, ticketId: string): Promise<void> {
  const ticket = loadTicket(stateRoot, ticketId)
  if (!ticket) {
    console.error(`工单 ${ticketId} 不存在(${stateRoot}/gotry-state/turn-handoffs/)`)
    process.exit(1)
  }
  if (ticket.status !== 'open') {
    console.error(`工单 ${ticketId} 已是终态 ${ticket.status},复诵不重算:`)
    replay(ticket, stateRoot)
  }
  const result = await runPlanner(ticket)
  const deliverable = result.ok
    ? `# 后台深度规划交付:${ticket.objective.slice(0, 60)}\n(工单 ${ticket.id},原请求 ${ticket.requestedAt})\n\n${result.output}`
    : `# 后台深度规划失败:${ticket.objective.slice(0, 60)}\n(工单 ${ticket.id},原请求 ${ticket.requestedAt})\n\n未产出交付物:${result.error ?? '未知原因'}。这趟规划没有完成——请重新发起,失败原因如上,无部分结果可交付。`
  const { deliverablePath } = await settleTurnHandoffTicket(
    stateRoot, ticket, result.ok ? 'settled' : 'failed', deliverable, result.ok ? undefined : result.error,
  )
  console.error(`工单 ${ticket.id} ${result.ok ? '已交付' : '失败'}:${deliverablePath}`)
  emitTerminal({
    schema: TURN_HANDOFF_TERMINAL_SCHEMA,
    ticket_id: ticket.id,
    status: result.ok ? 'succeeded' : 'failed',
    ...(result.ok
      ? { deliverable_path: deliverablePath }
      : { error: result.error ?? 'unknown' }),
  })
}

async function collectAll(stateRoot: string): Promise<void> {
  const open = (await listTurnHandoffTickets(stateRoot)).filter(t => t.status === 'open')
  if (open.length === 0) {
    console.error('无待回收的后台规划工单(open=0)')
    process.exit(0)
  }
  let failed = 0
  for (const view of open) {
    const ticket = loadTicket(stateRoot, view.id)
    if (!ticket || ticket.status !== 'open') continue
    const result = await runPlanner(ticket)
    const deliverable = result.ok
      ? `# 后台深度规划交付:${ticket.objective.slice(0, 60)}\n(工单 ${ticket.id},原请求 ${ticket.requestedAt})\n\n${result.output}`
      : `# 后台深度规划失败:${ticket.objective.slice(0, 60)}\n(工单 ${ticket.id},原请求 ${ticket.requestedAt})\n\n未产出交付物:${result.error ?? '未知原因'}。这趟规划没有完成——请重新发起,失败原因如上,无部分结果可交付。`
    const { deliverablePath } = await settleTurnHandoffTicket(
      stateRoot, ticket, result.ok ? 'settled' : 'failed', deliverable, result.ok ? undefined : result.error,
    )
    console.error(`工单 ${ticket.id} ${result.ok ? '已交付' : '失败'}:${deliverablePath}`)
    if (!result.ok) failed += 1
  }
  console.log(JSON.stringify({
    schema: TURN_HANDOFF_TERMINAL_SCHEMA,
    ticket_id: `--all(${open.length})`,
    status: failed === 0 ? 'succeeded' : 'failed',
    error: failed === 0 ? undefined : `${failed}/${open.length} 张工单回收失败`,
  }))
  process.exit(failed === 0 ? 0 : 2)
}

const [target, stateRootArg] = process.argv.slice(2)
const stateRoot = stateRootArg ?? '.'
if (target === '--all') {
  await collectAll(stateRoot)
} else if (target) {
  await collectOne(stateRoot, target)
} else {
  console.error('用法:npx tsx scripts/turn-handoff-collect.ts <ticketId|--all> [stateRoot]')
  process.exit(1)
}