/**
 * 「下一次出发」回访摘要(roadmap M4 交付「主动回访(可关闭)」的骨架):
 * 读 wish pool + 效用 sidecar,按当前窗口条件匹配 0..1 条建议,渲染成摘要,
 * 经可插拔通道送出——通道 key 未配时骨架降级为 stdout/file,即插即用。
 *
 * 通道(环境变量,无新依赖,fetch 为 Node 18+ 全局):
 *   GOTRY_NUDGE_ENABLED=false      全局关闭(契约:可关闭;其余配置再对也直接退出)
 *   GOTRY_NUDGE_CHANNEL=stdout|file|lark   默认 stdout
 *   GOTRY_NUDGE_FILE=<path>        file 通道输出位置,默认 <stateRoot>/gotry-state/nudge-digest.md
 *   GOTRY_LARK_WEBHOOK=<url>       lark 通道 webhook(founder 侧配置即生效)
 *
 * 纪律:0..1(muted 永不召回,无命中不硬推);lark 投递失败降级 stdout 不抛
 * (回访是 sidecar 性质,永不阻塞主路径);本脚本只读状态文件。
 *
 * 运行:cd ts && npx tsx scripts/nudge-digest.ts [--days N] [--budget N] [--month M] [--state-root DIR]
 * 无参数时 days/budget 不参与评分,month 取系统当月。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pickNudgeWish, type WishPoolEntry } from '../src/wish-pool.ts'
import { projectUtility, type MemoryUtilityEvent } from '../src/memory-utility.ts'
import { buildTimeAnchor } from '../src/time-anchor.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const stateRoot = arg('--state-root') ?? '.'
const stateDir = join(stateRoot, 'gotry-state')

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

function readEvents(): MemoryUtilityEvent[] {
  try {
    return readFileSync(join(stateDir, 'memory-utility.jsonl'), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as MemoryUtilityEvent)
  } catch {
    return []
  }
}

if (process.env['GOTRY_NUDGE_ENABLED'] === 'false') {
  console.log('回访已关闭(GOTRY_NUDGE_ENABLED=false)——可关闭契约,正常退出')
  process.exit(0)
}

const pool = readJson<WishPoolEntry[]>(join(stateDir, 'wish-pool.json'), [])
const anchor = buildTimeAnchor(new Date())
const ctx = {
  days: arg('--days') ? Number(arg('--days')) : undefined,
  budgetCny: arg('--budget') ? Number(arg('--budget')) : undefined,
  month: arg('--month') ? Number(arg('--month')) : new Date().getMonth() + 1,
}
const match = pickNudgeWish(pool, ctx)

const lines: string[] = [`# 「下一次出发」回访摘要(${anchor.today} ${anchor.todayWeekdayZh})`]
if (!match) {
  lines.push(`在册 ${pool.filter(p => !p.muted).length} 条憧憬,当前窗口无可成行匹配——不打扰(0..1 纪律:不硬推)。`)
} else {
  const c = (match.entry.conditions ?? {}) as { days?: number; budget_cny?: number; best_months?: number[] }
  const u = projectUtility(readEvents())[match.wishId]
  lines.push(`**${String(match.entry.name ?? match.wishId)}**(${match.hits.join(' + ')},命中 ${match.score}/3 项)`)
  lines.push(`- 成行条件: ${JSON.stringify(c)}`)
  if (match.entry.reason) lines.push(`- 当初为什么: ${String(match.entry.reason).slice(0, 160)}`)
  lines.push(`- 效用状态: ${u?.status ?? 'unknown'}(被召回 ${u?.recalled ?? 0} 次)`)
  lines.push('')
  lines.push('_想安排就说一声;不想被打扰说「mute <名字>」即可休眠,憧憬不被拒绝。_')
}
const digest = lines.join('\n')

const channel = process.env['GOTRY_NUDGE_CHANNEL'] ?? 'stdout'
if (channel === 'file') {
  const out = process.env['GOTRY_NUDGE_FILE'] ?? join(stateDir, 'nudge-digest.md')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, digest + '\n', 'utf-8')
  console.log(`摘要已写入 ${out}`)
} else if (channel === 'lark') {
  const webhook = process.env['GOTRY_LARK_WEBHOOK']
  if (!webhook) {
    console.log('lark 通道未配置(GOTRY_LARK_WEBHOOK 缺失)——降级 stdout,即插即用等 key:')
    console.log(digest)
  } else {
    try {
      const resp = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text: digest } }),
      })
      console.log(`lark 投递 HTTP ${resp.status}`)
      if (!resp.ok) console.log(digest) // 失败降级 stdout,不丢摘要
    } catch (e) {
      console.log(`lark 投递失败(${(e as Error).message})——降级 stdout:`)
      console.log(digest)
    }
  }
} else {
  console.log(digest)
}
