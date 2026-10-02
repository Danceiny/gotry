/**
 * 桥作业账本(批次 A「桥作业账本化」,2026-10-01):extension-bridge 易失控制状态
 * (队列/在飞/节律/客户端注册)的 SQLite 持久面,独立 db 文件
 * `<stateRoot>/gotry-state/bridge.db`——**绝不触碰** state-ledger.ts 与内核清单钉住文件
 * (ts/data/kernel-manifest.json);桥账本与产品状态账本物理分库,互不迁移。
 *
 * 修掉的真缺陷:
 *   ① gotry-backend 重启丢在飞作业——claimed 作业随进程蒸发,回包到了也无人认领;
 *     账本 + recoverOnBoot(见 extension-bridge.createBridgeJobQueue)让重启后
 *     queued 重排、claimed 未超时复活、claimed 已超时结算 unresolved 并记节律冷却。
 *   ② 未知 jobId 回包 200 静默丢弃——扩展真跑了的作业结果无痕消失;
 *     现在 404 {ok:false,error:'unknown-job'} 且孤儿回包落 bridge_jobs(status='unresolved',
 *     result_json 保留)供对账。
 *
 * 批次 B(2026-10-01,事件上行端点):bridge_events 表——扩展 workspace 事件
 * (活动上下文,非权威事实)经 POST /v1/session/bridge/events 上行落账;
 * idem_key 部分唯一索引(WHERE NOT NULL)让重试幂等:同 key 重发不重复落行。
 *
 * 红线继承:本账本只存**控制状态**(job 元数据/回包/节律/客户端能力清单/事件流水),
 * 协议面不存在 cookie 值字段(extension-tests §38 红线断言),账本亦零凭据落库。
 *
 * 引擎:better-sqlite3(既有依赖,零新增);WAL + busy_timeout,同仓 readFileSync
 * 风格的同步 API。时间戳一律 epoch 毫秒(INTEGER),与 timeout_at 比较同单位。
 */

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { BridgeJobStore, ExtensionJob, ExtensionJobKind } from './extension-bridge.ts'

/** 站点节律冷却(毫秒):与 capabilities/session-search.ts 的 MIN_INTERVAL_MS 同口径 30s;导出仅测试/文档锚点 */
export const BRIDGE_SITE_COOLDOWN_MS = 30_000

export type BridgeJobStatus = 'queued' | 'claimed' | 'resolved' | 'unresolved' | 'void'

/** bridge_jobs 行(列名与建表一一对应;测试/对账读口径) */
export interface BridgeJobRow {
  id: string
  kind: string
  site: string
  payload_json: string
  status: BridgeJobStatus
  claimed_by_client: string | null
  claimed_origin: string | null
  claimed_at: number | null
  timeout_at: number | null
  result_json: string | null
  attempts: number
  created_at: number
  updated_at: number
}

/** recoverOnBoot 输入:未终态(queued/claimed)作业的最小投影 */
export interface BridgePendingJob {
  id: string
  kind: string
  site: string
  payload_json: string
  status: 'queued' | 'claimed'
  claimed_by_client: string | null
  claimed_origin: string | null
  timeout_at: number | null
  attempts: number
}

export interface BridgeClientRow {
  client_id: string
  origin: string
  capabilities_json: string
  last_seen_at: number
  login_sites_json: string
}

export interface BridgePacingRow {
  site: string
  last_hit_at: number
  cooldown_until: number
}

/** bridge_events 行(批次 B;列名与建表一一对应,测试/对账读口径) */
export interface BridgeEventRow {
  seq: number
  ts: number
  client_id: string
  kind: string
  site: string | null
  subject: string
  payload_json: string
  idem_key: string | null
}

/** 事件上行写入输入(会话模块按批次逐条投递;idem_key 可空 = 不参与幂等去重) */
export interface BridgeEventInput {
  client_id: string
  kind: string
  site: string | null
  subject: string
  payload_json: string
  idem_key: string | null
}

/** stateRoot 可相对可绝对(与 state-ledger.stateDirOf 同款解析) */
function stateDirOf(stateRoot: string): string {
  const root = isAbsolute(stateRoot) ? stateRoot : join(process.cwd(), stateRoot)
  return join(root, 'gotry-state')
}

export function bridgeLedgerDbPath(stateRoot: string): string {
  return join(stateDirOf(stateRoot), 'bridge.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bridge_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  site TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','claimed','resolved','unresolved','void')),
  claimed_by_client TEXT,
  claimed_origin TEXT,
  claimed_at INTEGER,
  timeout_at INTEGER,
  result_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bridge_jobs_status ON bridge_jobs(status);

CREATE TABLE IF NOT EXISTS bridge_clients (
  client_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  last_seen_at INTEGER NOT NULL,
  login_sites_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS bridge_pacing (
  site TEXT PRIMARY KEY,
  last_hit_at INTEGER NOT NULL,
  cooldown_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bridge_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  site TEXT,
  subject TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idem_key TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS bridge_events_idem_key
  ON bridge_events(idem_key) WHERE idem_key IS NOT NULL;
`

/**
 * SQLite 落地的桥作业账本(实现 extension-bridge.BridgeJobStore 契约)。
 * 所有写方法单语句/单事务同步提交;调用方(extension-bridge)负责失败兜底
 * (write-before-submit 的 INSERT 失败 = 提交失败,fail-closed 不入队)。
 */
export class BridgeLedgerStore implements BridgeJobStore {
  readonly dbPath: string
  private readonly db: Database.Database
  private readonly now: () => number

  constructor(dbPath: string, opts: { now?: () => number } = {}) {
    this.dbPath = dbPath
    this.now = opts.now ?? Date.now
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA)
  }

  /** write-before-submit:入队前先落 queued(提交失败 = 调用方不得派发) */
  insertQueuedJob(job: ExtensionJob, timeoutAt: number): void {
    const ts = this.now()
    this.db.prepare(
      `INSERT INTO bridge_jobs (id, kind, site, payload_json, status, timeout_at, attempts, created_at, updated_at)
       VALUES (@id, @kind, @site, @payload, 'queued', @timeoutAt, 0, @ts, @ts)`,
    ).run({ id: job.jobId, kind: job.kind, site: job.site, payload: JSON.stringify(job), timeoutAt, ts })
  }

  /** 领取(/jobs 派发与 dispatchToParked 两处):claimed + 领取者 + attempts 递增 */
  markClaimed(jobId: string, claim: { origin: string; clientId?: string }): void {
    const ts = this.now()
    this.db.prepare(
      `UPDATE bridge_jobs
       SET status='claimed', claimed_by_client=@client, claimed_origin=@origin, claimed_at=@ts, attempts=attempts+1, updated_at=@ts
       WHERE id=@id`,
    ).run({ id: jobId, client: claim.clientId ?? null, origin: claim.origin, ts })
  }

  markResolved(jobId: string, result: unknown): void {
    this.db.prepare(
      `UPDATE bridge_jobs SET status='resolved', result_json=@result, updated_at=@ts WHERE id=@id`,
    ).run({ id: jobId, result: JSON.stringify(result), ts: this.now() })
  }

  markUnresolved(jobId: string, note?: { reason: string }): void {
    const result = note ? JSON.stringify({ ok: false, reason: note.reason }) : null
    this.db.prepare(
      `UPDATE bridge_jobs SET status='unresolved', result_json=@result, updated_at=@ts WHERE id=@id`,
    ).run({ id: jobId, result, ts: this.now() })
  }

  markVoid(jobId: string): void {
    this.db.prepare(`UPDATE bridge_jobs SET status='void', updated_at=@ts WHERE id=@id`).run({ id: jobId, ts: this.now() })
  }

  /**
   * 孤儿回包落库(对账面):未知 jobId 的回包内容以 status='unresolved' 保留。
   *  - 无行(纯未知/探测回包):插 kind 取回包自报(缺省 'orphan'),site='unknown';
   *  - 已 resolved:迟到回包不覆盖已决结果(幂等,首次裁决为准);
   *  - unresolved/void:补 result_json——作废/超时后扩展其实跑完了,留证供对账。
   */
  recordOrphanResult(jobId: string, result: { kind?: ExtensionJobKind }): void {
    const existing = this.getJob(jobId)
    const ts = this.now()
    const resultJson = JSON.stringify(result)
    if (!existing) {
      this.db.prepare(
        `INSERT INTO bridge_jobs (id, kind, site, payload_json, status, result_json, attempts, created_at, updated_at)
         VALUES (@id, @kind, 'unknown', '{}', 'unresolved', @result, 0, @ts, @ts)`,
      ).run({ id: jobId, kind: result.kind ?? 'orphan', result: resultJson, ts })
      return
    }
    if (existing.status === 'resolved') return
    this.db.prepare(
      `UPDATE bridge_jobs SET status='unresolved', result_json=@result, updated_at=@ts WHERE id=@id`,
    ).run({ id: jobId, result: resultJson, ts })
  }

  /** bridge_clients upsert:/jobs 轮询体(clientId + capabilities)到达即刷新,login_sites 保序合并 */
  upsertClient(clientId: string, origin: string, capabilities: readonly string[]): void {
    const ts = this.now()
    this.db.prepare(
      `INSERT INTO bridge_clients (client_id, origin, capabilities_json, last_seen_at, login_sites_json)
       VALUES (@clientId, @origin, @caps, @ts, '[]')
       ON CONFLICT(client_id) DO UPDATE SET
         origin=excluded.origin, capabilities_json=excluded.capabilities_json, last_seen_at=excluded.last_seen_at`,
    ).run({ clientId, origin, caps: JSON.stringify([...capabilities]), ts })
  }

  /** cookie-names 命中票据名(名字级)→ 该客户端在该站点持有登录态 */
  recordClientLoginSite(clientId: string, site: string): void {
    const row = this.db.prepare(`SELECT login_sites_json FROM bridge_clients WHERE client_id=?`).get(clientId) as { login_sites_json: string } | undefined
    if (!row) return
    let sites: unknown
    try { sites = JSON.parse(row.login_sites_json) } catch { sites = [] }
    const merged = new Set(Array.isArray(sites) ? sites.filter((s): s is string => typeof s === 'string') : [])
    merged.add(site)
    this.db.prepare(`UPDATE bridge_clients SET login_sites_json=@sites WHERE client_id=@clientId`).run({ clientId, sites: JSON.stringify([...merged]) })
  }

  /** 站点导航类作业提交/领取:记命中时刻并把冷却推到 now+30s(不回退既有冷却) */
  noteSiteHit(site: string): void {
    const ts = this.now()
    this.db.prepare(
      `INSERT INTO bridge_pacing (site, last_hit_at, cooldown_until) VALUES (@site, @ts, @until)
       ON CONFLICT(site) DO UPDATE SET last_hit_at=excluded.last_hit_at, cooldown_until=MAX(cooldown_until, excluded.cooldown_until)`,
    ).run({ site, ts, until: ts + BRIDGE_SITE_COOLDOWN_MS })
  }

  /** 超时结算冷却:claimed 超时的导航作业——站点可能已被打,只推冷却,不虚构 last_hit_at */
  applyCooldown(site: string): void {
    const ts = this.now()
    this.db.prepare(
      `INSERT INTO bridge_pacing (site, last_hit_at, cooldown_until) VALUES (@site, @ts, @until)
       ON CONFLICT(site) DO UPDATE SET cooldown_until=MAX(cooldown_until, excluded.cooldown_until)`,
    ).run({ site, ts, until: ts + BRIDGE_SITE_COOLDOWN_MS })
  }

  pacingOf(site: string): { lastHitAt: number; cooldownUntil: number } | null {
    const row = this.db.prepare(`SELECT last_hit_at, cooldown_until FROM bridge_pacing WHERE site=?`).get(site) as Pick<BridgePacingRow, 'last_hit_at' | 'cooldown_until'> | undefined
    return row ? { lastHitAt: row.last_hit_at, cooldownUntil: row.cooldown_until } : null
  }

  /**
   * 事件上行落账(批次 B):seq 由 AUTOINCREMENT 分配,ts 取服务端落账时刻
   * (clientTs 是扩展侧时钟,仅参与形状校验不入列——服务端时钟才是账本唯一时间轴)。
   * 幂等:idem_key 非空且已存在 → 不重复落行,返回 false(由调用方计入 rejected);
   * idem_key 为 NULL 的行不参与去重,多行共存(部分唯一索引)。
   * 同进程同步 API,check-then-insert 对本连接原子。
   */
  insertEvent(ev: BridgeEventInput): boolean {
    if (ev.idem_key !== null) {
      const dup = this.db.prepare(`SELECT 1 FROM bridge_events WHERE idem_key=?`).get(ev.idem_key)
      if (dup) return false
    }
    this.db.prepare(
      `INSERT INTO bridge_events (ts, client_id, kind, site, subject, payload_json, idem_key)
       VALUES (@ts, @clientId, @kind, @site, @subject, @payload, @idem)`,
    ).run({ ts: this.now(), clientId: ev.client_id, kind: ev.kind, site: ev.site, subject: ev.subject, payload: ev.payload_json, idem: ev.idem_key })
    return true
  }

  /** 事件流水读面(测试/对账):按 seq 升序 */
  listEvents(): BridgeEventRow[] {
    return this.db.prepare(`SELECT seq, ts, client_id, kind, site, subject, payload_json, idem_key FROM bridge_events ORDER BY seq`).all() as BridgeEventRow[]
  }

  listPendingJobs(): BridgePendingJob[] {
    return this.db.prepare(
      `SELECT id, kind, site, payload_json, status, claimed_by_client, claimed_origin, timeout_at, attempts
       FROM bridge_jobs WHERE status IN ('queued','claimed')`,
    ).all() as BridgePendingJob[]
  }

  getJob(jobId: string): BridgeJobRow | null {
    return (this.db.prepare(`SELECT * FROM bridge_jobs WHERE id=?`).get(jobId) as BridgeJobRow | undefined) ?? null
  }

  getClient(clientId: string): BridgeClientRow | null {
    return (this.db.prepare(`SELECT * FROM bridge_clients WHERE client_id=?`).get(clientId) as BridgeClientRow | undefined) ?? null
  }

  listPacing(): BridgePacingRow[] {
    return this.db.prepare(`SELECT site, last_hit_at, cooldown_until FROM bridge_pacing ORDER BY site`).all() as BridgePacingRow[]
  }

  close(): void {
    this.db.close()
  }
}

/** 打开(或创建)桥作业账本;stateRoot 目录自动落位 */
export function openBridgeLedgerStore(stateRoot: string, opts: { now?: () => number } = {}): BridgeLedgerStore {
  return new BridgeLedgerStore(bridgeLedgerDbPath(stateRoot), opts)
}
