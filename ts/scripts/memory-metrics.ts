/**
 * 记忆效用指标投影(M4 北极星底座,只读):从 gotry-state 侧车文件聚合
 * 「下一次出发率」的过程指标与经验回流率基线(M4 exit 要求有基线)。
 *
 * 口径(单用户期即固定,多用户期逐用户展开,RFC §6.5 账本化兼容):
 *  - wish_total / wish_muted:在册与休眠的憧憬数
 *  - recalled_wishes / verified_wishes:被召回过 ≥1 次 / 拿到 owner 确认结果的 wish 数
 *  -回流率基线(reflux_baseline)= verified_wishes / max(recalled_wishes,1)
 *   ——「被召回的憧憬里有多少走到了可验证的现实结果」;数值本身无好坏,
 *   先有基线,样本起来后才谈目标。
 *
 * 运行:cd ts && npx tsx scripts/memory-metrics.ts [stateRoot]
 * 只读:不改任何状态文件(巡检状态纪律);无数据时优雅空态 exit 0。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectUtility, type MemoryUtilityEvent } from '../src/memory-utility.ts'

const stateRoot = process.argv[2] ?? '.'
const stateDir = join(stateRoot, 'gotry-state')

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function readJsonl(path: string): MemoryUtilityEvent[] {
  try {
    return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as MemoryUtilityEvent)
  } catch {
    return []
  }
}

const pool = readJson<Array<{ wish_id?: string; name?: string; muted?: boolean }>>(join(stateDir, 'wish-pool.json'), [])
const events = readJsonl(join(stateDir, 'memory-utility.jsonl'))
const projection = projectUtility(events)

const active = pool.filter(w => typeof w.wish_id === 'string')
const recalledWishes = Object.values(projection).filter(w => w.recalled > 0).length
const verifiedWishes = Object.values(projection).filter(w => w.verified > 0).length
const refluxBaseline = verifiedWishes / Math.max(recalledWishes, 1)

console.log('=== GoTry 记忆效用指标(M4 北极星过程面,只读) ===')
console.log(`wish pool: ${pool.length} 条在册(其中 ${pool.filter(w => w.muted).length} 条休眠,${active.length} 条有稳定 wish_id)`)
console.log(`效用事件: ${events.length} 条(recalled=${events.filter(e => e.kind === 'recalled').length}, applied=${events.filter(e => e.kind === 'applied').length}, verified=${events.filter(e => e.kind === 'verified_outcome').length})`)
for (const w of Object.values(projection)) {
  const name = pool.find(p => p.wish_id === w.wish_id)?.name ?? w.wish_id
  console.log(`  - ${name}: status=${w.status}, recalled=${w.recalled}, applied=${w.applied}, verified=${w.verified}`)
}
console.log(`经验回流率基线 = ${verifiedWishes}/${recalledWishes} = ${refluxBaseline.toFixed(2)}(verified/recalled;单用户起步期样本稀疏属预期)`)
if (pool.length === 0) console.log('(wish pool 为空——首访用户,指标从首条憧憬入池开始积累)')
