/**
 * 账本 CLI(ADR-15 事务化状态基座的操作面;D3 决策:仓内极简命令,恢复语义
 * 已与驱动器解耦,随时可换 loopx tick):
 *   migrate [root]                      one-shot 迁移:旧 JSON/JSONL → 账本 events
 *                                       (导入前自动快照到 gotry-state/pre-ledger-backup/)
 *   export [root]                       local-only:账本 → 旧文件名视图(红线 6:可见可导出;单向,不回流)
 *   log [root] [--limit N]              事件账本尾部(append-only 审计面)
 *   stats [root]                        各面计数
 *   rebuild [root] [toSeq]              DROP 投影 → fold 重放(可截到 toSeq;账本/投影
 *                                       永不分叉的可验证性)
 *   rewind [root] <seq>                 = rebuild toSeq(投影回到历史时点;events 不动,
 *                                       rebuild 无参即回到最新)
 *   forget [root] wish|companion|motivation <id>
 *                                       物理硬删该主体全部事件 + 审计一行 + 重建投影
 *                                       (红线 6「可删除」;D5 默认物理删)
 *   tick [root]                         local-only:回收全部 pending 工单(durable 恢复语义)
 *   whatif [root] <dest.db>             local-only:VACUUM INTO 整库分叉副本(管理员 snapshot;
 *                                       不是租户 export,不触正本)
 *   pw-list [root]                      pending_writes 清单
 *   pw-request [root] <idemKey> <seam> <payloadJson>   登记待确认外部写(L2)
 *   pw-confirm [root] <idemKey> <receipt>              具名 seam 确认(L3,携 receipt)
 *   pw-compensate [root] <idemKey> <note>              saga 补偿
 *   repair-plan [root] [--mapping <file>] [--format text|json]
 *                                       只读 inventory + dry-run tenant 修复计划(#254):
 *                                       正本零写(只在临时副本上读),无显式证据映射的
 *                                       事件一律原地保留;真实 apply 在单独 owner gate 后
 *
 * 选项(可放在命令前或命令后,也可夹在位置参数之间):
 *   --state-root <root>   显式 state root;省略时按命令沿用位置参数 root 或默认 '.'。
 *   --tenant <tenant>     账本租户 scope(默认 local);这是范围参数,不是认证/授权。
 *   --limit <N>           仅 log 支持;N 必须是正整数。
 *   --mapping <file>      仅 repair-plan 支持;人工确认的证据映射 JSON 数组。
 *   --format text|json    仅 repair-plan 支持;默认 text。
 *
 * root 默认 '.';运行:cd ts && npx tsx scripts/state-cli.ts <cmd> ...
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ensureLedger, ledgerDbPath, ledgerExists, openLedgerIfExists } from '../src/state-ledger.ts'
import { formatRepairPlan, loadEvidenceMappingFile, planLedgerRepair } from '../src/ledger-repair-plan.ts'
import { collectDeepPlanning, makeJournaledSolvePort, settleAsyncTicket, type AsyncTicket } from '../src/loop.ts'
import { solveUnified } from '../src/unified.ts'
import type { TripState } from '../src/contracts.ts'

const HELP = `用法: npx tsx scripts/state-cli.ts [--state-root <root>] [--tenant <tenant>] <cmd> [args...]
命令:
  migrate [root]
  export [root]                         # local-only:导出共享 legacy 文件名视图
  log [root] [--limit N]
  stats [root]
  rebuild [root] [toSeq]
  rewind [root] <seq>
  forget [root] wish|companion|motivation <id>
  tick [root]                           # local-only:回收本地 pending 工单
  whatif [root] <dest.db>               # local-only:整库管理员 snapshot,不是租户 export
  pw-list [root]
  pw-request [root] <idemKey> <seam> <payloadJson>
  pw-confirm [root] <idemKey> <receipt>
  pw-compensate [root] <idemKey> <note>
  repair-plan [root] [--mapping <file>] [--format text|json]   # 只读 dry-run,零写
选项:
  --state-root <root>   显式 state root;保留位置参数 root 用法
  --tenant <tenant>     默认 local;仅是账本 scope,不是认证/授权
  --limit <N>           仅 log 支持,N 为正整数
  --mapping <file>      仅 repair-plan 支持,人工确认的证据映射 JSON 数组
  --format text|json    仅 repair-plan 支持,默认 text
边界:tick/export/whatif 只支持 --tenant local;非 local 会在创建目录、打开账本、求解或写文件前拒绝。
      repair-plan 全程只读:不建库、不迁移 schema、不改任何 ledger/projection。
提示:root 路径若像数字/负数或以 '-' 开头,请用 --state-root <root> 明示。`

const COMMANDS = new Set([
  'migrate',
  'export',
  'log',
  'stats',
  'rebuild',
  'rewind',
  'forget',
  'tick',
  'whatif',
  'pw-list',
  'pw-request',
  'pw-confirm',
  'pw-compensate',
  'repair-plan',
])
const OPTION_NAMES = new Set(['--state-root', '--tenant', '--limit', '--mapping', '--format'])
const LOCAL_ONLY_COMMANDS = new Set(['export', 'tick', 'whatif'])
const SUBJECTS = new Set(['wish', 'companion', 'motivation'])

type OptionName = '--state-root' | '--tenant' | '--limit' | '--mapping' | '--format'

interface ParsedCli {
  cmd?: string
  root: string
  tenant: string
  limit: number
  mapping?: string
  format: 'text' | 'json'
  positional: string[]
}

function usageError(message: string): never {
  console.error(message)
  console.error(HELP)
  process.exit(1)
}

function isOptionName(token: string): token is OptionName {
  return OPTION_NAMES.has(token)
}

function parsePositiveInteger(raw: string, label: string): number {
  if (!/^\d+$/.test(raw)) usageError(`${label} 必须是正整数:${raw}`)
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n <= 0) usageError(`${label} 必须是正整数:${raw}`)
  return n
}

function parseSequence(raw: string, label: string): number {
  if (!/^\d+$/.test(raw)) usageError(`${label} 必须是非负整数:${raw}`)
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) usageError(`${label} 超出安全整数范围:${raw}`)
  return n
}

function looksLikeNumeric(raw: string): boolean {
  return /^[+-]?(?:\d|\.\d)/.test(raw)
}

function rootAndArgs(cmd: string, positional: string[], explicitRoot?: string): { root: string; args: string[] } {
  if (explicitRoot !== undefined) return { root: explicitRoot, args: positional }

  switch (cmd) {
    case 'migrate':
    case 'export':
    case 'log':
    case 'stats':
    case 'tick':
    case 'pw-list':
    case 'repair-plan': {
      if (positional.length > 1) usageError(`${cmd} 只接受一个可选 root 位置参数`)
      return { root: positional[0] ?? '.', args: [] }
    }
    case 'rebuild':
    case 'rewind': {
      const rootIndex = positional.findIndex(p => !looksLikeNumeric(p))
      if (rootIndex < 0) return { root: '.', args: positional }
      const root = positional[rootIndex]!
      return { root, args: positional.filter((_, i) => i !== rootIndex) }
    }
    case 'forget':
    case 'whatif':
    case 'pw-request':
    case 'pw-confirm':
    case 'pw-compensate': {
      if (positional.length === 0) return { root: '.', args: [] }
      return { root: positional[0]!, args: positional.slice(1) }
    }
    default:
      return { root: '.', args: positional }
  }
}

function validateArgs(cmd: string, args: string[], limitRaw?: string, mappingRaw?: string, formatRaw?: string): { limit: number; format: 'text' | 'json' } {
  if (limitRaw !== undefined && cmd !== 'log') usageError(`${cmd} 不支持 --limit`)
  if (mappingRaw !== undefined && cmd !== 'repair-plan') usageError(`${cmd} 不支持 --mapping`)
  if (formatRaw !== undefined && cmd !== 'repair-plan') usageError(`${cmd} 不支持 --format`)
  const limit = limitRaw === undefined ? 20 : parsePositiveInteger(limitRaw, '--limit')
  if (formatRaw !== undefined && formatRaw !== 'text' && formatRaw !== 'json') usageError(`--format 只支持 text|json:${formatRaw}`)
  const format: 'text' | 'json' = formatRaw === 'json' ? 'json' : 'text'

  switch (cmd) {
    case 'migrate':
    case 'export':
    case 'log':
    case 'stats':
    case 'tick':
    case 'pw-list':
    case 'repair-plan':
      if (args.length !== 0) usageError(`${cmd} 不接受额外位置参数:${args.join(' ')}`)
      break
    case 'rebuild':
      if (args.length > 1) usageError('rebuild 最多接受一个 toSeq')
      if (args[0] !== undefined) parseSequence(args[0], 'toSeq')
      break
    case 'rewind':
      if (args.length !== 1) usageError('rewind 需要且只接受一个 seq')
      parseSequence(args[0]!, 'seq')
      break
    case 'forget':
      if (args.length !== 2) usageError('forget 需要 subject 与 id;省略 root 时请用 --state-root . 明示')
      if (!SUBJECTS.has(args[0]!)) usageError(`未知主体 ${args[0]}(wish|companion|motivation)`)
      break
    case 'whatif':
      if (args.length !== 1) usageError('whatif 需要 dest.db;省略 root 时请用 --state-root . 明示')
      break
    case 'pw-request':
      if (args.length !== 3) usageError('pw-request 需要 idemKey、seam 与 payloadJson;省略 root 时请用 --state-root . 明示')
      break
    case 'pw-confirm':
      if (args.length !== 2) usageError('pw-confirm 需要 idemKey 与 receipt;省略 root 时请用 --state-root . 明示')
      break
    case 'pw-compensate':
      if (args.length !== 2) usageError('pw-compensate 需要 idemKey 与 note;省略 root 时请用 --state-root . 明示')
      break
  }
  return { limit, format }
}

function parseCli(argv: string[]): ParsedCli {
  let cmd: string | undefined
  const positional: string[] = []
  const options = new Map<OptionName, string>()

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token.startsWith('--')) {
      if (!isOptionName(token)) usageError(`未知选项 ${token}`)
      if (options.has(token)) usageError(`重复选项 ${token}`)
      const value = argv[i + 1]
      if (value === undefined || value === '' || value.startsWith('--')) usageError(`${token} 缺少值`)
      options.set(token, value)
      i++
      continue
    }
    if (token.startsWith('-') && !looksLikeNumeric(token)) usageError(`未知选项 ${token}`)
    if (cmd === undefined) cmd = token
    else positional.push(token)
  }

  if (cmd === undefined) usageError('缺少命令')
  if (!COMMANDS.has(cmd)) return { cmd, root: '.', tenant: 'local', limit: 20, format: 'text', positional }

  const tenant = options.get('--tenant') ?? 'local'
  if (tenant.trim() === '') usageError('--tenant 缺少值')
  const explicitRoot = options.get('--state-root')
  if (explicitRoot !== undefined && explicitRoot.trim() === '') usageError('--state-root 缺少值')
  const { root, args } = rootAndArgs(cmd, positional, explicitRoot)
  const { limit, format } = validateArgs(cmd, args, options.get('--limit'), options.get('--mapping'), options.get('--format'))
  if (LOCAL_ONLY_COMMANDS.has(cmd) && tenant !== 'local') {
    usageError(`${cmd} 仅支持 --tenant local；该命令未实现租户隔离,已在创建目录、打开账本、求解或写文件前拒绝。`)
  }
  return { cmd, root, tenant, limit, mapping: options.get('--mapping'), format, positional: args }
}

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, 'utf-8')
  renameSync(tmp, path)
}

const parsed = parseCli(process.argv.slice(2))
const { cmd, root, tenant } = parsed

switch (cmd) {
  case 'migrate': {
    const before = openLedgerIfExists(root, tenant)?.countEvents() ?? 0
    const ledger = ensureLedger(root, tenant)
    const backupDir = join(root, 'gotry-state', 'pre-ledger-backup')
    console.log(`账本就绪:${ledger.dbPath}(events ${before} → ${ledger.countEvents()};存在旧文件时已快照至 ${backupDir}/)`)
    break
  }
  case 'export': {
    const ledger = ensureLedger(root, tenant)
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
    const ledger = openLedgerIfExists(root, tenant)
    if (!ledger) { console.log('(无账本——未迁移 root,旧文件形态)'); break }
    for (const e of ledger.readEvents(undefined, parsed.limit)) {
      console.log(`${String(e.seq).padStart(5)}  ${e.ts}  ${e.actor.padEnd(28)} ${e.kind.padEnd(24)} ${e.subject_id}${e.idem_key ? `  #${e.idem_key}` : ''}`)
    }
    break
  }
  case 'stats': {
    const ledger = openLedgerIfExists(root, tenant)
    if (!ledger) { console.log('(无账本——未迁移 root)'); break }
    console.log(`events=${ledger.countEvents()} wishes=${ledger.readWishPool().length} companions=${ledger.readCompanions().length} trips=${ledger.readTrips().length} utility=${ledger.readUtilityEvents().length} pendingRuns=${ledger.pendingWorkflowRuns().length} pendingWrites=${ledger.listPendingWrites().length}`)
    break
  }
  case 'rebuild':
  case 'rewind': {
    const ledger = openLedgerIfExists(root, tenant)
    if (!ledger) { console.error('无账本'); process.exit(1) }
    const toSeqRaw = parsed.positional[0]
    const toSeq = toSeqRaw === undefined ? undefined : parseSequence(toSeqRaw, 'seq')
    const r = ledger.rebuildProjections(toSeq)
    console.log(`fold 重建完成${toSeqRaw ? `(至 seq ${toSeqRaw};rebuild 无参即回最新)` : '(全量)'}:重放 ${r.events} 事件 → 愿望 ${r.wishes} / 同行人 ${r.companions}`)
    break
  }
  case 'forget': {
    const ledger = openLedgerIfExists(root, tenant)
    if (!ledger) { console.error('无账本'); process.exit(1) }
    const [subject, id] = parsed.positional
    const map: Record<string, { kinds: string[]; subjectId: string }> = {
      wish: { kinds: ['wish.imported', 'wish.added', 'wish.updated', 'memory_utility.event'], subjectId: id! },
      companion: { kinds: ['companion.imported', 'companion.saved'], subjectId: id! },
      motivation: { kinds: ['motivation.imported', 'motivation.patch'], subjectId: 'motivation' },
    }
    const spec = map[subject!]
    if (!spec) { console.error(`未知主体 ${subject}(wish|companion|motivation)`); process.exit(1) }
    const r = ledger.forgetSubject([spec])
    console.log(`已物理硬删 ${r.deleted} 条事件并重建投影(审计一行留痕;红线 6「可删除」)`)
    break
  }
  case 'tick': {
    const ledger = openLedgerIfExists(root, tenant)
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
    const ledger = openLedgerIfExists(root, tenant)
    if (!ledger) { console.error('无账本'); process.exit(1) }
    const dest = parsed.positional[0]!
    mkdirSync(dirname(dest), { recursive: true })
    ledger.forkWhatIf(dest)
    console.log(`what-if 分叉已生成:${dest}(预演在副本,正本零改动)`)
    break
  }
  case 'pw-list': {
    const ledger = openLedgerIfExists(root, tenant)
    if (!ledger) { console.log('(无账本)'); break }
    for (const w of ledger.listPendingWrites()) {
      console.log(`${w.status.padEnd(12)} ${w.idem_key}  seam=${w.seam}${w.receipt ? `  receipt=${w.receipt}` : ''}`)
    }
    break
  }
  case 'pw-request':
  case 'pw-confirm':
  case 'pw-compensate': {
    const ledger = ensureLedger(root, tenant)
    const positional = parsed.positional
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
  case 'repair-plan': {
    // 全程只读:不用 ensureLedger/openLedgerIfExists(它们会建库、迁移 v1 schema、
    // 重建投影);planLedgerRepair 把 db 复制到临时目录再只读读取,正本一次都不打开。
    if (!ledgerExists(root)) { console.error(`无账本(未迁移 root):${ledgerDbPath(root)}`); process.exit(1) }
    let mappings: unknown
    if (parsed.mapping !== undefined) {
      try {
        mappings = loadEvidenceMappingFile(parsed.mapping)
      } catch (e) {
        // fail-closed:映射不可读/非法 JSON 一律拒绝,绝不退化成「无映射照跑」
        console.error(e instanceof Error ? e.message : String(e))
        process.exit(1)
      }
    }
    const plan = planLedgerRepair({ stateRoot: root, sourceTenant: tenant, mappings })
    console.log(parsed.format === 'json' ? JSON.stringify(plan, null, 2) : formatRepairPlan(plan))
    break
  }
  default:
    console.error(cmd ? `未知命令 ${cmd}` : HELP)
    console.error(HELP)
    process.exit(1)
}
