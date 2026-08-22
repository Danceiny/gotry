/**
 * OpenFlights 骨架校验(M2 段 3,§7-1 骨架层):引擎候选集的通航性合法性校验。
 * 数据源:data/openflights-skeleton.json(OpenFlights ODbL,枢纽间 168 对)。
 * 语义:「查不到≠不可达」(骨架只含枢纽间),但「查到」= 候选集强证据。
 * 运行:cd ts && npx tsx scripts/skeleton-check.ts HKG HKT
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

interface Skeleton {
  meta: { source: string; note: string; hub_filter: string[] }
  pairs: Record<string, string[]>
}

let cached: Skeleton | null = null

async function load(): Promise<Skeleton> {
  if (!cached) {
    cached = JSON.parse(await readFile(join('..', 'data', 'openflights-skeleton.json'), 'utf-8')) as Skeleton
  }
  return cached
}

export async function checkConnectivity(a: string, b: string): Promise<{ connected: boolean; airlines?: string[]; evidence: string }> {
  const skeleton = await load()
  const key = [a.toUpperCase(), b.toUpperCase()].sort().join('-')
  const airlines = skeleton.pairs[key]
  if (airlines) {
    return { connected: true, airlines, evidence: `[骨架:openflights] ✅ ${a}↔${b} 直飞(${airlines.length}+ 航司:${airlines.join(',')})` }
  }
  const inHub = (skeleton.meta.hub_filter as string[]).includes(a.toUpperCase())
    && (skeleton.meta.hub_filter as string[]).includes(b.toUpperCase())
  return {
    connected: false,
    evidence: inHub
      ? `[骨架:openflights] ❌ ${a}↔${b} 枢纽间无直飞记录——引擎应将此候选降权或要求中转`
      : `[骨架:openflights] ○ ${a}或${b}不在枢纽集,骨架不覆盖(不作否定结论)`,
  }
}

// CLI 直跑
if (process.argv[2] && process.argv[3]) {
  console.log((await checkConnectivity(process.argv[2], process.argv[3])).evidence)
}
