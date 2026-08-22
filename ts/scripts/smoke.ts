/**
 * 冒烟:不启动完整 dsh 运行时,验证插件注册 + execute + 桥接 + Python 引擎全链路。
 * 运行(在 ts/ 下):npx tsx scripts/smoke.ts
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

interface ToolLike {
  name: string
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

async function main() {
  const registered: ToolLike[] = []
  const ctx = {
    tools: { register: (t: unknown) => registered.push(t as ToolLike) },
  } as unknown as Context

  apply(ctx, {
    pythonBin: '../.venv/bin/python',
    pythonPath: '../py',
    stateRoot: '.',
    timeoutMs: 30_000,
  })

  console.log(`registered tools: ${registered.map(t => t.name).join(', ')}`)

  const byName = (n: string) => {
    const t = registered.find(t => t.name === n)
    if (!t) throw new Error(`tool ${n} not registered`)
    return t
  }

  // 1) 动机画像:evidence 缺失必须被拒绝(P0 反幻觉红线)
  const motivation = byName('gotry_motivation_save')
  try {
    await motivation.execute({ profile: { weights: { escape_rest: 0.7 } } }, null)
    throw new Error('FAIL: profile without evidence should have been rejected')
  } catch (e) {
    console.log(`motivation without evidence rejected: ${(e as Error).message.slice(0, 60)}...`)
  }
  const saved = await motivation.execute({
    profile: {
      weights: { escape_rest: 0.7, curiosity: 0.3 },
      evidence: ['用户原话:想去湖边什么都不干(洱海照片)'],
      hard: { wake_not_before: '06:30', min_arrival_energy_pct: 40 },
    },
  }, null)
  console.log(`motivation saved -> ${JSON.stringify(saved).slice(0, 80)}...`)

  // 2) 可行性引擎:洱海金标准用例,经桥接跑 Python Z3
  const payload = JSON.parse(await readFile(join('..', 'data', 'golden_erhai.json'), 'utf-8'))
  const feasibility = byName('gotry_feasibility_check')
  const result = await feasibility.execute({ payload }, null) as {
    recommended: string | null
    answer_md: string
    latency_ms: number
  }
  console.log(`\nfeasibility: recommended=${result.recommended}, bridge latency=${result.latency_ms}ms\n`)
  console.log(result.answer_md)

  // 3) wish pool:把不可行的憧憬连同成行条件放入「下一次出发」
  const wish = byName('gotry_wish_pool_add')
  const dali = (JSON.parse(JSON.stringify(payload.verdicts ?? [])) as unknown[])
  void dali
  const added = await wish.execute({
    entry: {
      name: '大理·洱海',
      reason: '2 天窗口装不下(冲突:duration)',
      conditions: { days: 5, budget_cny: 4950, best_months: [3, 4, 5, 9, 10, 11] },
    },
  }, null)
  console.log(`\nwish pool -> ${JSON.stringify(added)}`)

  if (result.recommended !== 'qiandao') throw new Error('FAIL: expected qiandao recommended')
  console.log('\nSMOKE OK')
}

main().catch((e) => { console.error(e); process.exit(1) })
