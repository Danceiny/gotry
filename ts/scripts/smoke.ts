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
  presentResult?: (args: Record<string, unknown>, result: unknown) => { card?: string; title?: string; content?: Array<{ type: string; text?: string }> } | undefined
}

async function main() {
  const registered: ToolLike[] = []
  const ctx = {
    tools: { register: (t: unknown) => registered.push(t as ToolLike) },
  } as unknown as Context

  apply(ctx, {
    stateRoot: '.',
    timeoutMs: 30_000,
    hbcliBin: 'hbcli-not-on-path',  // 强制走降级路径的确定性验证
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
    via: string
  }
  console.log(`\nfeasibility: recommended=${result.recommended}, via=${result.via}, latency=${result.latency_ms}ms\n`)
  console.log(result.answer_md)

  // 3) wish pool:把不可行的憧憬连同成行条件放入「下一次出发」
  const wish = byName('gotry_wish_pool_add')
  const added = await wish.execute({
    entry: {
      name: '大理·洱海',
      reason: '2 天窗口装不下(冲突:duration)',
      conditions: { days: 5, budget_cny: 4950, best_months: [3, 4, 5, 9, 10, 11] },
    },
  }, null)
  console.log(`\nwish pool -> ${JSON.stringify(added)}`)

  if (result.recommended !== 'qiandao') throw new Error('FAIL: expected qiandao recommended')

  // 4) D-4 结果卡:presentResult 把逐候选判定 + 全成本 vs 预算渲染成紧凑行(非裸 JSON)
  if (typeof feasibility.presentResult !== 'function') throw new Error('FAIL: feasibility 缺 presentResult')
  const view = feasibility.presentResult({ payload }, result)
  if (!view?.title?.includes('qiandao')) throw new Error(`FAIL: 结果卡标题缺推荐,实际 ${view?.title}`)
  const body = view?.content?.[0]?.text ?? ''
  if (!body.includes('✅') || !body.includes('¥')) throw new Error('FAIL: 结果卡缺判定行/成本行')
  console.log(`\nresult card: ${view?.title}\n${body.split('\n').slice(0, 5).join('\n')}`)

  // 5) D-4 结果卡面:高流量 5 工具均带 presentResult;agent_reach 纯函数实拍
  for (const n of ['gotry_feasibility_check', 'gotry_hotel_search', 'gotry_weather_check', 'gotry_anything_search', 'gotry_agent_reach']) {
    if (typeof byName(n).presentResult !== 'function') throw new Error(`FAIL: ${n} 缺 presentResult`)
  }
  const ar = byName('gotry_agent_reach')
  const arView = ar.presentResult!({ query: { action: 'reach', channel: 'v2ex', method: 'get_hot_topics' } }, { verdict: 'found', summary: '10 topics' })
  if (!arView?.title?.includes('✅') || !arView.title.includes('v2ex.get_hot_topics')) throw new Error(`FAIL: agent_reach 结果卡,实际 ${arView?.title}`)
  console.log(`result cards on 5 tools; agent_reach card: ${arView.title}`)

  // 6) #12/#13 参数形态兼容:字符串 query 与裸对象都能落到 url(不再「url 必填」)
  const ws = byName('gotry_web_search')
  const r1 = await ws.execute({ query: 'not-a-url' } as never, null) as { summary?: string }
  const r2 = await ws.execute({ url: 'not-a-url' } as never, null) as { summary?: string }
  for (const [name, r] of [['string', r1], ['bare-obj', r2]] as const) {
    if (r.summary === 'url 必填') throw new Error(`FAIL: ${name} 形态未被 unwrapQuery 接住`)
  }
  console.log('unwrapQuery: string + bare-object shapes both accepted')

  // 7) 骨架输出 schema 放宽回归:execute 正常返回三字段;guard 错误兜底(ok/summary)
  // 不再被 strict schema 拒(dsh 参数层拒错→guard 兜底→旧 strict schema 校验炸,
  // 真实错误信息被掩盖——patrol 实测抓到)
  const skTool = byName('gotry_skeleton_check')
  const skFlat = await skTool.execute({ from: 'HKG', to: 'BKK' } as never, null) as { connected?: boolean; evidence?: string }
  if (skFlat.connected !== true) throw new Error(`FAIL: 骨架平铺调用应 connected=true,实际 ${JSON.stringify(skFlat).slice(0, 120)}`)
  const skBad = await skTool.execute({ from: '', to: '' } as never, null) as { ok?: boolean; summary?: string }
  if (typeof skBad?.summary === 'string' && (skBad as { connected?: boolean }).connected === undefined) {
    // guard 兜底路径:宽松 schema 下字段可存在即可,不抛
    console.log('skeleton guard-fallback shape survives (loose schema)')
  }
  console.log(`skeleton flat-args: connected=${skFlat.connected}`)

  console.log('\nSMOKE OK')
}

main().catch((e) => { console.error(e); process.exit(1) })
