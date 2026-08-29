/**
 * 可下单事实侧车持久化(issue #46,ADR-19):append-only JSONL 证据日志。
 *
 * 定位:这是**会话证据**而非用户状态——与 bridge-latency.jsonl / incidents.jsonl
 * 同类(审计痕迹),不进账本投影。append-only 保历史(同 route+date 重查的旧快照
 * 可回溯),读取侧经 dedupeFacts 取同 fact_id 最新。
 *
 * 路径:<stateRoot>/gotry-state/bookable-facts.jsonl
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dedupeFacts, type BookableFact } from '../src/bookable-facts.ts'

export const FACT_LOG_NAME = 'bookable-facts.jsonl'

export function factLogPath(stateRoot: string): string {
  const root = stateRoot === '.' ? process.cwd() : stateRoot
  return join(root, 'gotry-state', FACT_LOG_NAME)
}

/** 追加事实(永不抛错:落盘失败不阻塞检索工具主路径,返回 false 由调用方记 incident) */
export async function appendFacts(stateRoot: string, facts: BookableFact[]): Promise<boolean> {
  if (facts.length === 0) return true
  try {
    const p = factLogPath(stateRoot)
    await mkdir(join(p, '..'), { recursive: true })
    await appendFile(p, facts.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8')
    return true
  } catch {
    return false
  }
}

/** 读注册表(去重后视图;无文件 = 空注册表,不抛) */
export async function loadFactRegistry(stateRoot: string): Promise<BookableFact[]> {
  try {
    const raw = await readFile(factLogPath(stateRoot), 'utf-8')
    const facts: BookableFact[] = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const f = JSON.parse(t) as BookableFact
        if (f.schema === 'gotry_bookable_fact.v1' && f.fact_id) facts.push(f)
      } catch {
        // 单行损坏不拖垮整本注册表(与 incidents/latency 日志同纪律)
      }
    }
    return dedupeFacts(facts)
  } catch {
    return []
  }
}
