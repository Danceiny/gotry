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
 * AaaS A2(#674,威胁 S-5):组织维度。作业/客户端/节律/事件各行都属于恰好一个组织
 * (`organization` 列,缺省 `local` = 今天的单车道);客户端主键 (organization, client_id)、
 * 节律主键 (organization, site)、事件幂等唯一索引 (organization, idem_key);
 * 按作业 id 的更新与查询一律再带组织条件。组织永远是调用方(队列按自己的条目、
 * 接缝解出的调用者)传入的参数,**绝不来自回包体或请求头**;每个方法先用
 * assertOrganizationId 校验,非法组织在碰库之前就被拒。旧库(无组织列)在打开时原地迁移,
 * 既有行归 `local`,迁移是单向的(迁移后旧版本二进制的节律/客户端写会失败)。
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
import { assertOrganizationId } from '../../src/tenant-state/ids.ts'
import type { BridgeJobStore, ExtensionJob, ExtensionJobResult } from './extension-bridge.ts'

/** 站点节律冷却(毫秒):与 capabilities/session-search.ts 的 MIN_INTERVAL_MS 同口径 30s;导出仅测试/文档锚点 */
export const BRIDGE_SITE_COOLDOWN_MS = 30_000

export type BridgeJobStatus = 'queued' | 'claimed' | 'resolved' | 'unresolved' | 'void'

/** bridge_jobs 行(列名与建表一一对应;测试/对账读口径) */
export interface BridgeJobRow {
  id: string
  organization: string
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

/** recoverOnBoot 输入:未终态(queued/claimed)作业的最小投影(含所属组织,恢复时按行还原) */
export interface BridgePendingJob {
  id: string
  organization: string
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
  organization: string
  client_id: string
  origin: string
  capabilities_json: string
  last_seen_at: number
  login_sites_json: string
}

export interface BridgePacingRow {
  organization: string
  site: string
  last_hit_at: number
  cooldown_until: number
}

/** bridge_events 行(批次 B;列名与建表一一对应,测试/对账读口径) */
export interface BridgeEventRow {
  seq: number
  organization: string
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

// 主键含组织的两张表:建表与「旧库重建」共用同一份列定义,两处不会漂移
const CLIENTS_COLUMNS = `(
  organization TEXT NOT NULL DEFAULT 'local',
  client_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  last_seen_at INTEGER NOT NULL,
  login_sites_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (organization, client_id)
)`

const PACING_COLUMNS = `(
  organization TEXT NOT NULL DEFAULT 'local',
  site TEXT NOT NULL,
  last_hit_at INTEGER NOT NULL,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (organization, site)
)`

const TABLES = `
CREATE TABLE IF NOT EXISTS bridge_jobs (
  id TEXT PRIMARY KEY,
  organization TEXT NOT NULL DEFAULT 'local',
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

CREATE TABLE IF NOT EXISTS bridge_clients ${CLIENTS_COLUMNS};

CREATE TABLE IF NOT EXISTS bridge_pacing ${PACING_COLUMNS};

CREATE TABLE IF NOT EXISTS bridge_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  organization TEXT NOT NULL DEFAULT 'local',
  ts INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  site TEXT,
  subject TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idem_key TEXT
);
`

// 索引在迁移之后建:旧库的 bridge_events 在迁移前还没有 organization 列
const INDEXES = `
CREATE INDEX IF NOT EXISTS bridge_jobs_status ON bridge_jobs(status);
CREATE UNIQUE INDEX IF NOT EXISTS bridge_events_org_idem_key
  ON bridge_events(organization, idem_key) WHERE idem_key IS NOT NULL;
`

const ORGANIZATION_TABLES = ['bridge_jobs', 'bridge_clients', 'bridge_pacing', 'bridge_events'] as const

function hasOrganizationColumn(db: Database.Database, table: string): boolean {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some((column) => column.name === 'organization')
}

/**
 * 旧库(组织维度之前)原地迁移:jobs/events 加列,clients/pacing 因主键含组织而重建;
 * 既有行一律归 `local`。整段在一个 IMMEDIATE 事务里,拿到写锁后重新判定哪些表还需要迁移
 * (并发打开同一个库的另一连接可能已迁完),所以幂等且无半迁移状态。
 */
function migrateOrganizationDimension(db: Database.Database): void {
  const pending = (): string[] => ORGANIZATION_TABLES.filter((table) => !hasOrganizationColumn(db, table))
  if (pending().length > 0) migrateTables(db, pending)
  // An older binary recreates its single-column unique index on idem_key every time it opens the file, so a file that went
  // new, old, new has nothing left to migrate and still holds it: one organization's key would block another's. Drop it on
  // every open (a no-op when absent).
  if (hasIndex(db, 'bridge_events_idem_key')) db.transaction(() => { db.exec('DROP INDEX IF EXISTS bridge_events_idem_key') }).immediate()
}

function hasIndex(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name) !== undefined
}

function migrateTables(db: Database.Database, pending: () => string[]): void {
  db.transaction(() => {
    for (const table of pending()) {
      if (table === 'bridge_jobs' || table === 'bridge_events') {
        db.exec(`ALTER TABLE ${table} ADD COLUMN organization TEXT NOT NULL DEFAULT 'local'`)
        continue
      }
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}__legacy`)
      if (table === 'bridge_clients') {
        db.exec(`CREATE TABLE bridge_clients ${CLIENTS_COLUMNS}`)
        db.exec(`INSERT INTO bridge_clients (organization, client_id, origin, capabilities_json, last_seen_at, login_sites_json)
          SELECT 'local', client_id, origin, capabilities_json, last_seen_at, login_sites_json FROM bridge_clients__legacy`)
      } else {
        db.exec(`CREATE TABLE bridge_pacing ${PACING_COLUMNS}`)
        db.exec(`INSERT INTO bridge_pacing (organization, site, last_hit_at, cooldown_until)
          SELECT 'local', site, last_hit_at, cooldown_until FROM bridge_pacing__legacy`)
      }
      db.exec(`DROP TABLE ${table}__legacy`)
    }
    // 旧的按 idem_key 单列唯一索引会让两个组织的同名幂等键互相拒绝,换成 (organization, idem_key)
    db.exec('DROP INDEX IF EXISTS bridge_events_idem_key')
  }).immediate()
}

/**
 * SQLite 落地的桥作业账本(实现 extension-bridge.BridgeJobStore 契约)。
 * 所有写方法单语句/单事务同步提交;调用方(extension-bridge)负责失败兜底
 * (write-before-submit 的 INSERT 失败 = 提交失败,fail-closed 不入队)。
 * 组织是每个方法的第一个参数且必填:漏传是编译错误,不是静默落进 `local`。
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
    // Opening a legacy file needs the write lock once (migration, index changes). A rolling deploy can have the old process
    // writing through it, so the open waits longer than a normal write does and then drops back.
    this.db.pragma('busy_timeout = 30000')
    this.db.exec(TABLES)
    migrateOrganizationDimension(this.db)
    this.db.exec(INDEXES)
    this.db.pragma('busy_timeout = 5000')
  }

  /** write-before-submit:入队前先落 queued(提交失败 = 调用方不得派发) */
  insertQueuedJob(organization: string, job: ExtensionJob, timeoutAt: number): void {
    const org = assertOrganizationId(organization)
    const ts = this.now()
    this.db.prepare(
      `INSERT INTO bridge_jobs (id, organization, kind, site, payload_json, status, timeout_at, attempts, created_at, updated_at)
       VALUES (@id, @organization, @kind, @site, @payload, 'queued', @timeoutAt, 0, @ts, @ts)`,
    ).run({ id: job.jobId, organization: org, kind: job.kind, site: job.site, payload: JSON.stringify(job), timeoutAt, ts })
  }

  /** 领取(/jobs 派发与 dispatchToParked 两处):claimed + 领取者 + attempts 递增 */
  markClaimed(organization: string, jobId: string, claim: { origin: string; clientId?: string }): void {
    const org = assertOrganizationId(organization)
    const ts = this.now()
    this.db.prepare(
      `UPDATE bridge_jobs
       SET status='claimed', claimed_by_client=@client, claimed_origin=@origin, claimed_at=@ts, attempts=attempts+1, updated_at=@ts
       WHERE id=@id AND organization=@organization`,
    ).run({ id: jobId, organization: org, client: claim.clientId ?? null, origin: claim.origin, ts })
  }

  markResolved(organization: string, jobId: string, result: unknown): void {
    const org = assertOrganizationId(organization)
    this.db.prepare(
      `UPDATE bridge_jobs SET status='resolved', result_json=@result, updated_at=@ts WHERE id=@id AND organization=@organization`,
    ).run({ id: jobId, organization: org, result: JSON.stringify(result), ts: this.now() })
  }

  markUnresolved(organization: string, jobId: string, note?: { reason: string }): void {
    const org = assertOrganizationId(organization)
    const result = note ? JSON.stringify({ ok: false, reason: note.reason }) : null
    this.db.prepare(
      `UPDATE bridge_jobs SET status='unresolved', result_json=@result, updated_at=@ts WHERE id=@id AND organization=@organization`,
    ).run({ id: jobId, organization: org, result, ts: this.now() })
  }

  markVoid(organization: string, jobId: string): void {
    const org = assertOrganizationId(organization)
    this.db.prepare(
      `UPDATE bridge_jobs SET status='void', updated_at=@ts WHERE id=@id AND organization=@organization`,
    ).run({ id: jobId, organization: org, ts: this.now() })
  }

  /**
   * 孤儿回包落库(对账面):未知 jobId 的回包内容以 status='unresolved' 保留。
   *  - 无行(纯未知/探测回包):插 kind 取回包自报(缺省 'orphan'),site='unknown',归调用方组织;
   *  - 已 resolved:迟到回包不覆盖已决结果(幂等,首次裁决为准);
   *  - unresolved/void:补 result_json——作废/超时后扩展其实跑完了,留证供对账;
   *  - 该 jobId 已属于**另一个组织**:拒绝(抛错,零写入)。队列在调用前就按组织拦下并答
   *    与未知作业完全一样的 404,这里是第二道防线。
   */
  recordOrphanResult(organization: string, jobId: string, result: ExtensionJobResult): void {
    const org = assertOrganizationId(organization)
    const existing = this.db.prepare(`SELECT organization, status FROM bridge_jobs WHERE id=@id`).get({ id: jobId }) as { organization: string; status: BridgeJobStatus } | undefined
    const ts = this.now()
    const resultJson = JSON.stringify(result)
    if (!existing) {
      this.db.prepare(
        `INSERT INTO bridge_jobs (id, organization, kind, site, payload_json, status, result_json, attempts, created_at, updated_at)
         VALUES (@id, @organization, @kind, 'unknown', '{}', 'unresolved', @result, 0, @ts, @ts)`,
      ).run({ id: jobId, organization: org, kind: result.kind ?? 'orphan', result: resultJson, ts })
      return
    }
    if (existing.organization !== org) throw new Error('bridge-job-organization-mismatch')
    if (existing.status === 'resolved') return
    this.db.prepare(
      `UPDATE bridge_jobs SET status='unresolved', result_json=@result, updated_at=@ts WHERE id=@id AND organization=@organization`,
    ).run({ id: jobId, organization: org, result: resultJson, ts })
  }

  /** bridge_clients upsert:/jobs 轮询体(clientId + capabilities)到达即刷新,login_sites 保序合并 */
  upsertClient(organization: string, clientId: string, origin: string, capabilities: readonly string[]): void {
    const org = assertOrganizationId(organization)
    const ts = this.now()
    this.db.prepare(
      `INSERT INTO bridge_clients (organization, client_id, origin, capabilities_json, last_seen_at, login_sites_json)
       VALUES (@organization, @clientId, @origin, @caps, @ts, '[]')
       ON CONFLICT(organization, client_id) DO UPDATE SET
         origin=excluded.origin, capabilities_json=excluded.capabilities_json, last_seen_at=excluded.last_seen_at`,
    ).run({ organization: org, clientId, origin, caps: JSON.stringify([...capabilities]), ts })
  }

  /** cookie-names 命中票据名(名字级)→ 该客户端在该站点持有登录态 */
  recordClientLoginSite(organization: string, clientId: string, site: string): void {
    const org = assertOrganizationId(organization)
    const row = this.db.prepare(`SELECT login_sites_json FROM bridge_clients WHERE organization=@organization AND client_id=@clientId`).get({ organization: org, clientId }) as { login_sites_json: string } | undefined
    if (!row) return
    let sites: unknown
    try { sites = JSON.parse(row.login_sites_json) } catch { sites = [] }
    const merged = new Set(Array.isArray(sites) ? sites.filter((s): s is string => typeof s === 'string') : [])
    merged.add(site)
    this.db.prepare(`UPDATE bridge_clients SET login_sites_json=@sites WHERE organization=@organization AND client_id=@clientId`).run({ organization: org, clientId, sites: JSON.stringify([...merged]) })
  }

  /** 站点导航类作业提交/领取:记命中时刻并把冷却推到 now+30s(不回退既有冷却);节律按 组织+站点 */
  noteSiteHit(organization: string, site: string): void {
    const org = assertOrganizationId(organization)
    const ts = this.now()
    this.db.prepare(
      `INSERT INTO bridge_pacing (organization, site, last_hit_at, cooldown_until) VALUES (@organization, @site, @ts, @until)
       ON CONFLICT(organization, site) DO UPDATE SET last_hit_at=excluded.last_hit_at, cooldown_until=MAX(cooldown_until, excluded.cooldown_until)`,
    ).run({ organization: org, site, ts, until: ts + BRIDGE_SITE_COOLDOWN_MS })
  }

  /** 超时结算冷却:claimed 超时的导航作业——站点可能已被打,只推冷却,不虚构 last_hit_at */
  applyCooldown(organization: string, site: string): void {
    const org = assertOrganizationId(organization)
    const ts = this.now()
    this.db.prepare(
      `INSERT INTO bridge_pacing (organization, site, last_hit_at, cooldown_until) VALUES (@organization, @site, @ts, @until)
       ON CONFLICT(organization, site) DO UPDATE SET cooldown_until=MAX(cooldown_until, excluded.cooldown_until)`,
    ).run({ organization: org, site, ts, until: ts + BRIDGE_SITE_COOLDOWN_MS })
  }

  pacingOf(organization: string, site: string): { lastHitAt: number; cooldownUntil: number } | null {
    const org = assertOrganizationId(organization)
    const row = this.db.prepare(`SELECT last_hit_at, cooldown_until FROM bridge_pacing WHERE organization=@organization AND site=@site`).get({ organization: org, site }) as Pick<BridgePacingRow, 'last_hit_at' | 'cooldown_until'> | undefined
    return row ? { lastHitAt: row.last_hit_at, cooldownUntil: row.cooldown_until } : null
  }

  /**
   * 事件上行落账(批次 B):seq 由 AUTOINCREMENT 分配,ts 取服务端落账时刻
   * (clientTs 是扩展侧时钟,仅参与形状校验不入列——服务端时钟才是账本唯一时间轴)。
   * 幂等:idem_key 非空且**同组织**已存在 → 不重复落行,返回 false(由调用方计入 rejected);
   * 不同组织可以复用同一个 idem_key,互不去重。idem_key 为 NULL 的行不参与去重,多行共存
   * (部分唯一索引)。同进程同步 API,check-then-insert 对本连接原子。
   */
  insertEvent(organization: string, ev: BridgeEventInput): boolean {
    const org = assertOrganizationId(organization)
    if (ev.idem_key !== null) {
      const dup = this.db.prepare(`SELECT 1 FROM bridge_events WHERE organization=@organization AND idem_key=@idem`).get({ organization: org, idem: ev.idem_key })
      if (dup) return false
    }
    this.db.prepare(
      `INSERT INTO bridge_events (organization, ts, client_id, kind, site, subject, payload_json, idem_key)
       VALUES (@organization, @ts, @clientId, @kind, @site, @subject, @payload, @idem)`,
    ).run({ organization: org, ts: this.now(), clientId: ev.client_id, kind: ev.kind, site: ev.site, subject: ev.subject, payload: ev.payload_json, idem: ev.idem_key })
    return true
  }

  /** 事件流水读面(测试/对账):某组织的行,按 seq 升序 */
  listEvents(organization: string): BridgeEventRow[] {
    const org = assertOrganizationId(organization)
    return this.db.prepare(`SELECT seq, organization, ts, client_id, kind, site, subject, payload_json, idem_key FROM bridge_events WHERE organization=@organization ORDER BY seq`).all({ organization: org }) as BridgeEventRow[]
  }

  /** 全部组织的未终态作业(开机恢复按行还原所属组织) */
  listPendingJobs(): BridgePendingJob[] {
    return this.db.prepare(
      `SELECT id, organization, kind, site, payload_json, status, claimed_by_client, claimed_origin, timeout_at, attempts
       FROM bridge_jobs WHERE status IN ('queued','claimed')`,
    ).all() as BridgePendingJob[]
  }

  /** 按 jobId 读行(任何组织;测试/对账口径,行里带 organization)。调用方有组织时用 getJobForOrganization */
  getJob(jobId: string): BridgeJobRow | null {
    return (this.db.prepare(`SELECT * FROM bridge_jobs WHERE id=?`).get(jobId) as BridgeJobRow | undefined) ?? null
  }

  getJobForOrganization(organization: string, jobId: string): BridgeJobRow | null {
    const org = assertOrganizationId(organization)
    return (this.db.prepare(`SELECT * FROM bridge_jobs WHERE id=@id AND organization=@organization`).get({ id: jobId, organization: org }) as BridgeJobRow | undefined) ?? null
  }

  /** 该 jobId 属于哪个组织(账本里没有这行 = null);队列用它认出「别的组织的作业」 */
  organizationOfJob(jobId: string): string | null {
    const row = this.db.prepare(`SELECT organization FROM bridge_jobs WHERE id=?`).get(jobId) as { organization: string } | undefined
    return row ? row.organization : null
  }

  getClient(organization: string, clientId: string): BridgeClientRow | null {
    const org = assertOrganizationId(organization)
    return (this.db.prepare(`SELECT * FROM bridge_clients WHERE organization=@organization AND client_id=@clientId`).get({ organization: org, clientId }) as BridgeClientRow | undefined) ?? null
  }

  listPacing(organization: string): BridgePacingRow[] {
    const org = assertOrganizationId(organization)
    return this.db.prepare(`SELECT organization, site, last_hit_at, cooldown_until FROM bridge_pacing WHERE organization=@organization ORDER BY site`).all({ organization: org }) as BridgePacingRow[]
  }

  close(): void {
    this.db.close()
  }
}

/** 打开(或创建)桥作业账本;stateRoot 目录自动落位 */
export function openBridgeLedgerStore(stateRoot: string, opts: { now?: () => number } = {}): BridgeLedgerStore {
  return new BridgeLedgerStore(bridgeLedgerDbPath(stateRoot), opts)
}
