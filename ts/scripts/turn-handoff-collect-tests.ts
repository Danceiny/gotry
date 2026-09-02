/**
 * turn-handoff 收集器闭环测试(ADR-24 v2 收集半段)。
 * 假 planner(node 脚本)驱动:成功/失败/空输出/幂等复诵零重算/--all/
 * 缺单;并断言递归防护真的传进了子进程(GOTRY_HANDOFF_CHILD=1 且父进程
 * 的数值 pin/工单根被清除)。全程隔离 stateRoot,不触真实 gotry-state。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listTurnHandoffTickets, settleTurnHandoffTicket, writeTurnHandoffTicket } from '../src/turn-deadline.ts'

const TS_DIR = join(import.meta.dirname, '..')
const TSX = join(TS_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs')

function runCollector(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  // 用 execFileSync 的同步抓取替代 spawn 手工聚合,行为等价且断言更直接。
  try {
    const stdout = execFileSync(process.execPath, [TSX, 'scripts/turn-handoff-collect.ts', ...args], {
      cwd: TS_DIR,
      env: { ...process.env, ...env },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? null, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

const root = mkdtempSync(join(tmpdir(), 'gotry-handoff-collect-'))
const planners = mkdtempSync(join(tmpdir(), 'gotry-handoff-planners-'))
const plannerCalls = join(planners, 'calls.log')

// ok:记录调用环境(递归防护证据)→ 输出交付物
const okPlanner = join(planners, 'ok.mjs')
writeFileSync(okPlanner, `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(plannerCalls)}, [
  'call child=' + process.env.GOTRY_HANDOFF_CHILD,
  'pin=' + (process.env.GOTRY_TURN_DEADLINE_SOFT_MS ?? 'CLEARED'),
  'root=' + (process.env.GOTRY_TURN_HANDOFF_ROOT ?? 'CLEARED'),
  'msg=' + process.argv[2]?.slice(0, 12),
].join(' | ') + '\\n')
console.log('# 规划结果\\n方案A:9.26 DXB→CAN,10.3 衡阳婚礼,10.5 返程')
`)
const failPlanner = join(planners, 'fail.mjs')
writeFileSync(failPlanner, `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(plannerCalls)}, 'call fail\\n')
process.exit(3)
`)
const emptyPlanner = join(planners, 'empty.mjs')
writeFileSync(emptyPlanner, `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(plannerCalls)}, 'call empty\\n')
`)

const calls = () => (existsSync(plannerCalls) ? readFileSync(plannerCalls, 'utf-8').trim().split('\n') : [])

try {
  // 1) 缺单 → exit 1
  assert.equal(runCollector(['th-missing', root]).status, 1)

  // 2) 成功回收:planner 恰跑一次,工单 settled,交付物含方案,终态 JSON
  const t1 = await writeTurnHandoffTicket(root, '帮我规划10.3衡阳婚礼十几天行程')
  {
    const r = runCollector([t1.id, root], { GOTRY_HANDOFF_PLANNER_BIN: okPlanner })
    assert.equal(r.status, 0, `stderr=${r.stderr}`)
    const terminal = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>
    assert.equal(terminal['schema'], 'gotry_turn_handoff_terminal.v1')
    assert.equal(terminal['status'], 'succeeded')
    assert.ok(String(terminal['deliverable_path']).includes(`${t1.id}.deliverable.md`))
  }
  const t1After = JSON.parse(readFileSync(join(root, 'gotry-state', 'turn-handoffs', `${t1.id}.json`), 'utf8')) as Record<string, unknown>
  assert.equal(t1After['status'], 'settled')
  assert.ok(t1After['settledAt'])
  const deliverable1 = readFileSync(join(root, 'gotry-state', 'turn-handoffs', `${t1.id}.deliverable.md`), 'utf8')
  assert.ok(deliverable1.includes('方案A') && deliverable1.includes(t1.id))

  // 3) 幂等复诵:重跑 exit 0,同交付物,planner 零重算
  {
    const before = calls().length
    const r = runCollector([t1.id, root], { GOTRY_HANDOFF_PLANNER_BIN: okPlanner })
    assert.equal(r.status, 0)
    const terminal = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>
    assert.equal(terminal['status'], 'succeeded')
    assert.equal(calls().length, before, 'settled ticket must not re-run the planner')
  }

  // 4) 递归防护证据:ok planner 记录的子环境
  {
    const last = [...calls()].reverse().find(l => l.includes('child='))
    assert.ok(last, 'planner ran')
    assert.ok(last!.includes('child=1'), `GOTRY_HANDOFF_CHILD must be 1: ${last}`)
    assert.ok(last!.includes('pin=CLEARED'), `parent deadline pins must be cleared: ${last}`)
    assert.ok(last!.includes('root=CLEARED'), `parent handoff root must be cleared: ${last}`)
    assert.ok(last!.includes('msg=帮我规划10.3衡阳婚礼'), 'planner receives the verbatim user ask')
  }

  // 5) 失败回收:exit 2,工单 failed + error,交付物是诚实失败说明
  const t2 = await writeTurnHandoffTicket(root, '另一趟失败的规划')
  {
    const r = runCollector([t2.id, root], { GOTRY_HANDOFF_PLANNER_BIN: failPlanner })
    assert.equal(r.status, 2)
    const terminal = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>
    assert.equal(terminal['status'], 'failed')
    assert.ok(String(terminal['error']).startsWith('planner exited 3'), `error shape: ${terminal['error']}`)
  }
  const t2After = JSON.parse(readFileSync(join(root, 'gotry-state', 'turn-handoffs', `${t2.id}.json`), 'utf8')) as Record<string, unknown>
  assert.equal(t2After['status'], 'failed')
  assert.ok(String(t2After['error']).startsWith('planner exited 3'))
  const deliverable2 = readFileSync(join(root, 'gotry-state', 'turn-handoffs', `${t2.id}.deliverable.md`), 'utf8')
  assert.ok(deliverable2.includes('没有完成') && deliverable2.includes('planner exited 3'), 'honest failure note')
  // 失败复诵:exit 2,零重算
  {
    const before = calls().length
    assert.equal(runCollector([t2.id, root], { GOTRY_HANDOFF_PLANNER_BIN: failPlanner }).status, 2)
    assert.equal(calls().length, before)
  }

  // 6) 空输出 → failed
  const t3 = await writeTurnHandoffTicket(root, '空输出的规划')
  {
    const r = runCollector([t3.id, root], { GOTRY_HANDOFF_PLANNER_BIN: emptyPlanner })
    assert.equal(r.status, 2)
    const terminal = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>
    assert.equal(terminal['error'], 'planner produced empty output')
  }

  // 7) --all:只收 open(t4/t5),已终态的 t1/t2/t3 零重算
  const t4 = await writeTurnHandoffTicket(root, '批量规划一')
  const t5 = await writeTurnHandoffTicket(root, '批量规划二')
  {
    const before = calls().length
    const r = runCollector(['--all', root], { GOTRY_HANDOFF_PLANNER_BIN: okPlanner })
    assert.equal(r.status, 0, `stderr=${r.stderr}`)
    const terminal = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>
    assert.equal(terminal['status'], 'succeeded')
    assert.equal(calls().length, before + 2, 'exactly the two open tickets collected')
  }
  // 8) --all 无 open → exit 0
  assert.equal(runCollector(['--all', root], { GOTRY_HANDOFF_PLANNER_BIN: okPlanner }).status, 0)

  // 9) 复访视图:倒序 + settled 摘录 + failed 错误
  {
    const views = await listTurnHandoffTickets(root)
    assert.equal(views.length, 5)
    assert.equal(views[0].id, t5.id, 'newest first')
    const settled = views.find(v => v.id === t1.id)!
    assert.equal(settled.status, 'settled')
    assert.ok(settled.deliverableExcerpt?.includes('方案A'))
    const failed = views.find(v => v.id === t2.id)!
    assert.equal(failed.status, 'failed')
    assert.ok(failed.error?.startsWith('planner exited 3'))
  }

  console.log('turn handoff collector tests: OK (settle/fail/empty/idempotent replay/--all/recursion guard env/revisit views)')
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(planners, { recursive: true, force: true })
}

// settleTurnHandoffTicket 直接契约(不经 collector):原子写 + 字段完整
{
  const r = mkdtempSync(join(tmpdir(), 'gotry-handoff-settle-'))
  const t = await writeTurnHandoffTicket(r, '直调结算')
  const { deliverablePath } = await settleTurnHandoffTicket(r, t, 'settled', '交付内容')
  assert.ok(existsSync(deliverablePath))
  const views = await listTurnHandoffTickets(r)
  assert.equal(views[0].deliverableExcerpt, '交付内容')
  rmSync(r, { recursive: true, force: true })
}