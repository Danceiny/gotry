/**
 * action-cache 本地自愈层(RFC user-session-data-rfc.md §3.2 / §2.3;Stagehand 云端缓存的本地化):
 *
 * 目的:会话检索的查询模式高度重复(同站点同类型搜索),首跑用 LLM/规则定位,后续走
 * 缓存的确定性载荷零成本重放;站点改版 → DOM 指纹失配 → miss → 重新定位并回写。
 *
 * 设计原则(Stagehand「错误的缓存点击比慢更糟」的被动失效):
 *   - key = site + action + 参数模板(%from%/%to%/%date% 变量化,同型查询共享条目);
 *   - 每条目绑 domFingerprint(快照/接口形状的 sha256 指纹);lookup 时现场指纹与条目不符 = miss(即使 key 命中);
 *   - miss 即回写(记录新定位),过期(默认 48h)与容量(每 site 默认 50 条,LRU)被动淘汰;
 *   - 纯函数 + JSON 文件持久化(隔离 stateRoot;损坏文件按空缓存处理,永不抛错)。
 *
 * P2 切片:模块+确定性测试先行;消费方(P2 美团适配器/a11y 兜底)下一切片接线。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ActionCacheEntry {
  /** site:action:参数化模板 key,如 ctrip-flight:search:%from%->%to%:%date% */
  key: string
  /** 建条目时的 DOM/接口形状指纹;lookup 现场指纹必须一致才命中 */
  domFingerprint: string
  /** 确定性重放载荷(消费方自定义:URL 模板/selector 序列/解析器名) */
  locator: Record<string, string>
  createdAt: string
  lastHitAt: string
  hits: number
}

export interface ActionCacheOptions {
  /** 条目 TTL ms,默认 48h(对齐 Stagehand) */
  ttlMs?: number
  /** 每站点条目上限(LRU 淘汰),默认 50 */
  maxEntriesPerSite?: number
  /** 覆盖「现在」(测试注入) */
  now?: () => Date
}

/** 把具体查询参数变量化为模板 key:日期→%date%,from/to 语义序在前,其余参数按字典序尾随 */
export function templateKey(site: string, action: string, params: Record<string, string>): string {
  const val = (k: string): string => (k === 'date' ? '%date%' : (params[k] ?? '').trim())
  const head = ['from', 'to', 'date'].filter((k) => k in params).map(val)
  const tail = Object.keys(params).filter((k) => !['from', 'to', 'date'].includes(k)).sort().map(val)
  return `${site}:${action}:${[...head, ...tail].join('|')}`
}

/** 指纹:快照/接口形状文本 → sha256 前 16 位(微改版即失配——宁可 miss 不可错点) */
export function fingerprint(shapeText: string): string {
  return createHash('sha256').update(shapeText).digest('hex').slice(0, 16)
}

export class ActionCache {
  private entries = new Map<string, ActionCacheEntry>()
  private loaded = false
  private readonly ttlMs: number
  private readonly maxPerSite: number
  private readonly now: () => Date

  constructor(private readonly filePath: string, opts: ActionCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 48 * 3600_000
    this.maxPerSite = opts.maxEntriesPerSite ?? 50
    this.now = opts.now ?? (() => new Date())
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (existsSync(this.filePath)) {
        const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as ActionCacheEntry[]
        for (const e of raw) {
          if (e?.key && e.domFingerprint && e.locator) this.entries.set(e.key, e)
        }
      }
    } catch { /* 损坏文件按空缓存处理 */ }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = this.filePath + '.tmp'
      writeFileSync(tmp, JSON.stringify([...this.entries.values()], null, 0), 'utf8')
      writeFileSync(this.filePath, readFileSync(tmp, 'utf8'), 'utf8')
      try { require('node:fs').rmSync(tmp) } catch { /* best effort */ }
    } catch { /* 持久化失败不阻塞内存路径 */ }
  }

  /** 站点前缀条目数(LRU 淘汰用) */
  private siteEntries(site: string): ActionCacheEntry[] {
    return [...this.entries.values()].filter((e) => e.key.startsWith(site + ':'))
  }

  /** 命中三条件:key 存在 + 未过期 + 指纹一致;命中计 hits 并惰性落盘 */
  lookup(key: string, domFingerprint: string, site: string): ActionCacheEntry | null {
    this.load()
    const e = this.entries.get(key)
    if (!e) return null
    if (this.now().getTime() - Date.parse(e.lastHitAt || e.createdAt) > this.ttlMs) {
      this.entries.delete(key)
      this.persist()
      return null
    }
    if (e.domFingerprint !== domFingerprint) return null // 改版:被动失效,等 record 回写
    e.hits += 1
    e.lastHitAt = this.now().toISOString()
    this.persist()
    void site
    return e
  }

  /** miss 后回写(重新定位的产物);同 key 覆盖;超容 LRU 淘汰最旧 */
  record(key: string, domFingerprint: string, locator: Record<string, string>, site: string): ActionCacheEntry {
    this.load()
    const ts = this.now().toISOString()
    const prev = this.entries.get(key)
    this.entries.set(key, {
      key, domFingerprint, locator,
      createdAt: prev?.createdAt ?? ts,
      lastHitAt: ts,
      hits: prev?.hits ?? 0,
    })
    const siteList = this.siteEntries(site)
    if (siteList.length > this.maxPerSite) {
      const victim = siteList.sort((a, b) => Date.parse(a.lastHitAt) - Date.parse(b.lastHitAt))[0]
      if (victim) this.entries.delete(victim.key)
    }
    this.persist()
    return this.entries.get(key)!
  }

  invalidate(key: string): void {
    this.load()
    this.entries.delete(key)
    this.persist()
  }

  size(site?: string): number {
    this.load()
    return site ? this.siteEntries(site).length : this.entries.size
  }
}

/** 便捷入口:隔离 stateRoot 下的缓存文件路径 */
export function actionCachePath(stateRoot: string): string {
  return join(stateRoot, 'session-action-cache.json')
}
