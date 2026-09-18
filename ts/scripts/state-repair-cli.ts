/**
 * state-ledger 数据修复 CLI(issue #254 控制面)。owner-local 工具。
 *
 * 子命令:
 *   inventory <stateRoot>                       只读 inventory(JSON 报告,零写入)
 *   plan <stateRoot> <mapping.json>             只读迁移计划(变更/冲突/错误)
 *   execute <stateRoot> <mapping.json>          受限执行(自动 backup+journal;幂等)
 *   rollback <stateRoot> <backupDir>            从校验过的 backup 恢复
 *
 * 纪律:默认拒绝把 `ts/dsh-runtime`(founder 真实产品数据)作为操作对象——
 * 真实数据的 execute 是单独的 owner gate,必须显式传 --i-understand-founder-data。
 * 输出恒为单个 JSON 对象;inventory/plan 天然 dry-run(只读连接)。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { executeRepair, inventoryRepair, planRepair, rollbackRepair, type RepairMapping } from '../src/state-repair.ts'

function fail(msg: string): never {
  console.log(JSON.stringify({ ok: false, error: msg }))
  process.exit(1)
}

const [, , cmd, stateRootArg, mappingPath] = process.argv
const executeFlag = process.argv.includes('--execute')
const founderDataFlag = process.argv.includes('--i-understand-founder-data')

if (!cmd || !stateRootArg) fail('usage: state-repair-cli.ts <inventory|plan|execute|rollback> <stateRoot> [mapping.json] [--execute] [--i-understand-founder-data]')
const stateRoot = resolve(stateRootArg)

// founder 真实产品数据守卫:路径含 dsh-runtime 即视为 owner 数据
if (stateRoot.includes('dsh-runtime') && !founderDataFlag) {
  fail('refusing to operate on founder runtime state without --i-understand-founder-data (real repair is a separate owner gate)')
}

try {
  if (cmd === 'inventory') {
    if (executeFlag) fail('inventory is read-only; --execute is not applicable')
    console.log(JSON.stringify({ ok: true, inventory: inventoryRepair(stateRoot) }))
  } else if (cmd === 'plan') {
    if (!mappingPath) fail('plan requires mapping.json')
    if (executeFlag) fail('plan is read-only; --execute is not applicable')
    const mapping = JSON.parse(readFileSync(resolve(mappingPath), 'utf8')) as RepairMapping
    console.log(JSON.stringify({ ok: true, plan: planRepair(stateRoot, mapping) }))
  } else if (cmd === 'execute') {
    if (!mappingPath) fail('execute requires mapping.json')
    if (!executeFlag) fail('execute is a gated action: pass --execute after reviewing the plan (real-data repair is a separate owner gate)')
    const mapping = JSON.parse(readFileSync(resolve(mappingPath), 'utf8')) as RepairMapping
    console.log(JSON.stringify({ ok: true, result: executeRepair(stateRoot, mapping) }))
  } else if (cmd === 'rollback') {
    if (!mappingPath) fail('rollback requires backupDir')
    if (executeFlag) fail('rollback is a direct restore; --execute is not applicable')
    console.log(JSON.stringify({ ok: true, result: rollbackRepair(stateRoot, resolve(mappingPath)) }))
  } else {
    fail(`unknown command: ${cmd}`)
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e))
}
