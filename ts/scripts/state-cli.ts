/**
 * 账本 CLI(ADR-15 事务化状态基座的操作面;D3 决策:仓内极简命令,恢复语义
 * 已与驱动器解耦,随时可换 loopx tick):
 *   migrate [root]                      one-shot 迁移:旧 JSON/JSONL → 账本 events
 *                                       (导入前自动快照到 gotry-state/pre-ledger-backup/)
 *   export [root]                       账本 → 旧文件名视图(红线 6:可见可导出;单向,不回流)
 *   log [root] [--limit N]              事件账本尾部(append-only 审计面)
 *   stats [root]                        各面计数
 *   rebuild [root] [toSeq]              DROP 投影 → fold 重放(可截到 toSeq;账本/投影
 *                                       永不分叉的可验证性)
 *   rewind [root] <seq>                 = rebuild toSeq(投影回到历史时点;events 不动,
 *                                       rebuild 无参即回到最新)
 *   forget [root] wish|companion|motivation <id>
 *                                       物理硬删该主体全部事件 + 审计一行 + 重建投影
 *                                       (红线 6「可删除」;D5 默认物理删)
 *   tick [root]                         回收全部 pending 工单(durable 恢复语义)
 *   whatif [root] <dest.db>             VACUUM INTO 分叉副本(WriteGate what-if 预演,不触正本)
 *   pw-list [root]                      pending_writes 清单
 *   pw-request [root] <idemKey> <seam> <payloadJson>   登记待确认外部写(L2)
 *   pw-confirm [root] <idemKey> <receipt>              具名 seam 确认(L3,携 receipt)
 *   pw-compensate [root] <idemKey> <note>              saga 补偿
 * root 默认 '.';运行:cd ts && npx tsx scripts/state-cli.ts <cmd> ...
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensureLedger, openLedgerIfExists } from '../src/state-ledger.ts'
import { collectDeepPlanning, makeJournaledSolvePort, settleAsyncTicket, type AsyncTicket } from '../src/loop.ts'
import { solveUnified } from '../src/unified.ts'
import type { TripState } from '../src/contracts.ts'

const [cmd, ...rest] = process.argv.slice(2)

function rootOf(args: string[]): string {
  const i = args.indexOf('--state-root')
  if (i >= 0 && args[i + 1]) return args[i + 1]
  const first = args.find(a => !a.startsWith('--') && !/^[\d]+$/.test(a))
  return first ?? '.'
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf-8')
  renameSync(tmp, path)
}

const HELP = '用法见文件头注释(npx tsx scripts/state-cli.ts <cmd> [root] ...)'

switch (cmd) {
  case 'migrate': {
    const root = rootOf(rest)
    const before = openLedgerIfExists(root)?.countEvents() ?? 0
    const ledger = ensureLedger(root)
    const backupDir = join(root, 'gotry-state', 'pre-ledger-backup')
    console.log(`账本就绪:${ledger.dbPath}(events ${before} → ${ledger.countEvents()};存在旧文件时已快照至 ${backupDir}/)`)
    break
  }
  case 'export': {
    const root = rootOf(rest)
    const ledger = ensureLedger(root)
    const dir = join(root === '.' ? process.cwd() : root, 'gotry-state')
    mkdirSync(dir, { recursive: true })
    const motivation = ledger.readMotivation()
    if (motivation) atomicWrite(join(dir, 'motivation-profile.json'), JSON.stringify(motivation, null, 2))
    const pool = ledger.readWishPool()
    if (pool.length) atomicWrite(join(dir, 'wish-pool.json'), JSON.stringify(pool, null, 2))
    const companions = ledger.readCompanions()
    if (companions.length) atomicWrite(join(dir, 'companions.json'), JSON.stringify(companions, null, 2))
    const utility = ledger.readUtilityEvents()
    if (utility.length) atomicWrite(join(dir, 'memory-utility.jsonl'), utility.map(e => JSON.stringify(e)).join('\n') + '\n')
    const trips = ledger.readTrips()
    if (trips.length) atomicWrite(join(dir, 'trips.jsonl'), trips.map(e => JSON.stringify(e)).join('\n') + '\n')
    console.log(`视图已导出(单向,DB→文件;红线 6):${dir}/`)
    break
  }
  case 'log': {
    const root = rootOf(rest)
    const limit = Number(arg('--limit', '20'))
    const ledger = openLedgerIfExists(root)
    if (!ledger) { console.log('(无账本——未迁移 root,旧文件形态)'); break }
    for (const e of ledger.readEvents(undefined, limit)) {
      console.log(`${String(e.seq).padStart(5)}  ${e.ts}  ${e.actor.padEnd(28)} ${e.kind.padEnd(24)} ${e.subject_id}${e.idem_key ? `  #${e.idem_key}` : ''}`)
    }
    break
  }
  case 'stats': {
    const root = rootOf(rest)
    const ledger = openLedgerIfExists(root)
    if (!ledger) { console.log('(无账本——未迁移 root)'); break }
    console.log(`events=${ledger.countEvents()} wishes=${ledger.readWishPool().length} companions=${ledger.readCompanions().length} trips=${ledger.readTrips().length} utility=${ledger.readUtilityEvents().length} pendingRuns=${ledger.pendingWorkflowRuns().length} pendingWrites=${ledger.listPendingWrites().length}`)
    break
  }
  case 'rebuild':
  case 'rewind': {
    const root = rootOf(rest)
    const ledger = openLedgerIfExists(root)
    if (!ledger) { console.error('无账本'); process.exit(1) }
    const toSeqRaw = rest.find(a => /^\d+$/.test(a))
    const r = ledger.rebuildProjections(toSeqRaw ? Number(toSeqRaw) : undefined)
    console.log(`fold 重建完成${toSeqRaw ? `(至 seq ${toSeqRaw};rebuild 无参即回最新)` : '(全量)'}:重放 ${r.events} 事件 → 愿望 ${r.wishes} / 同行人 ${r.companions}`)
    break
  }
  case 'forget': {
    const root = rootOf(rest)
    const ledger = openLedgerIfExists(root)
    if (!ledger) { console.error('无账本'); process.exit(1) }
    const subject = rest.find(a => !a.startsWith('--') && a !== root)
    const id = rest[rest.indexOf(subject!) + 1]
    if (!subject || id === undefined) { console.error(HELP); process.exit(1) }
    const map: Record<string, { kinds: string[]; subjectId: string }> = {
      wish: { kinds: ['wish.imported', 'wish.added', 'wish.updated', 'memory_utility.event'], subjectId: id },
      companion: { kinds: ['companion.imported', 'companion.saved'], subjectId: id },
      motivation: { kinds: ['motivation.imported', 'motivation.patch'], subjectId: 'motivation' },
    }
    const spec = map[subject]
    if (!spec) { console.error(`未知主体 ${subject}(wish|companion|motivation)`); process.exit(1) }
    const r = ledger.forgetSubject([spec])
    console.log(`已物理硬删 ${r.deleted} 条事件并重建投影(审计一行留痕;红线 6「可删除」)`)
    break
  }
  case 'tick': {
    const root = rootOf(rest)
    const ledger = openLedgerIfExists(root)
    if (!ledger) { console.log('(无账本,无待办)'); break }
    const pending = ledger.pendingWorkflowRuns()
    if (pending.length === 0) { console.log('(无 pending 工单)'); break }
    for (const p of pending) {
      const run = ledger.getWorkflowRun(p.id)!
      const ticket = JSON.parse(run.ticket_json) as AsyncTicket
      const state = JSON.parse(run.state_json) as TripState
      const solve = makeJournaledSolvePort(ledger, p.id, solveUnified as never)
      const { reply } = await collectDeepPlanning(state, ticket, solve)
      await settleAsyncTicket(p.id, reply, root)
      console.log(`工单 ${p.id} 已回收(durable 恢复语义:done 步骤零重执行)`)
    }
    break
  }
  case 'whatif': {
    const root = rootOf(rest)
    const ledger = openLedgerIfExists(root)
    if (!ledger) { console.error('无账本'); process.exit(1) }
    const dest = rest.find(a => a !== root && !a.startsWith('--'))
    if (!dest) { console.error(HELP); process.exit(1) }
    mkdirSync(dirname(dest), { recursive: true })
    ledger.forkWhatIf(dest)
    console.log(`what-if 分叉已生成:${dest}(预演在副本,正本零改动)`)
    break
  }
  case 'pw-list': {
    const root = rootOf(rest)
    const ledger = openLedgerIfExists(root)
    if (!ledger) { console.log('(无账本)'); break }
    for (const w of ledger.listPendingWrites()) {
      console.log(`${w.status.padEnd(12)} ${w.idem_key}  seam=${w.seam}${w.receipt ? `  receipt=${w.receipt}` : ''}`)
    }
    break
  }
  case 'pw-request':
  case 'pw-confirm':
  case 'pw-compensate': {
    const root = rootOf(rest)
    const ledger = ensureLedger(root)
    const positional = rest.filter(a => a !== root && !a.startsWith('--'))
    if (positional.length < (cmd === 'pw-request' ? 3 : 2)) { console.error(HELP); process.exit(1) }
    if (cmd === 'pw-request') {
      const r = ledger.requestPendingWrite({ idemKey: positional[0]!, seam: positional[1]!, payload: JSON.parse(positional[2]!) as unknown })
      console.log(`登记:${JSON.stringify(r)}(L2:只登记不执行)`)
    } else if (cmd === 'pw-confirm') {
      const r = ledger.confirmPendingWrite(positional[0]!, positional[1]!)
      console.log(`确认:${JSON.stringify(r)}`)
    } else {
      const r = ledger.compensatePendingWrite(positional[0]!, positional[1]!)
      console.log(`补偿:${JSON.stringify(r)}`)
    }
    break
  }
  default:
    console.error(cmd ? `未知命令 ${cmd}` : HELP)
    console.error(HELP)
    process.exit(1)
}
