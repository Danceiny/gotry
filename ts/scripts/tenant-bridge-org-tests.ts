/**
 * Bridge organization dimension (AaaS A2, docs/rfc/aaas-rfc.md §4.4 and §8.3; threats S-5, S-9, S-11).
 *
 * Offline and deterministic: isolated mkdtemp state roots, loopback HTTP servers on temporary ports, a fake
 * extension that is just `fetch`, no network, no real supplier, no credentials, and the founder's runtime
 * state root is never opened. A bridge job, claim, result, event, pacing entry and client registration belong
 * to exactly one organization; the organization comes from the mounting host (the seam), never from a body,
 * a header or a payload.
 *
 *   L  ledger: the organization column and keys, in-place migration of a legacy file, store-level scoping,
 *      validation before the database is touched
 *   Q  queue: matching requires organization equality (queued and parked, identical site / origin / client
 *      id), a foreign result answers like an unknown job and writes nothing, heartbeats and stats per
 *      organization, the caller organization is never read from the request, recovery keeps organizations
 *   M  session-search module: `callerOrganization` and `admission` hooks, per-organization pacing, lock and
 *      events, end to end through the backend kernel
 *   S  schema scan: no bridge column can hold a cookie value (threat S-9)
 *   D  the default organization `local` keeps today's single lane
 *
 * Run: cd ts && npx tsx scripts/tenant-bridge-org-tests.ts
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import Database from 'better-sqlite3'

import {
  BRIDGE_DEFAULT_ORGANIZATION,
  EXTENSION_ORIGIN,
  createBridgeJobQueue,
  type BridgeJobQueue,
  type BridgeJobStore,
  type ExtensionJob,
  type ExtensionJobResult,
  type SessionJobHandle,
} from '../capabilities/session/extension-bridge.ts'
import { BridgeLedgerStore, bridgeLedgerDbPath, openBridgeLedgerStore, type BridgeJobRow } from '../capabilities/session/bridge-ledger.ts'
import { closeBackend, createBackendServer, type BackendServerHandle } from '../src/backend/kernel.ts'
import { startSessionSearchModule, type SessionAdmissionDecision } from '../src/backend/modules/session-search.ts'
import { __resetRateLimiterForTest } from '../capabilities/session-search.ts'
import { InvalidTenantIdError } from '../src/tenant-state/errors.ts'

const ACME = 'acme'
const RIVAL = 'rival'
const LOCAL = BRIDGE_DEFAULT_ORGANIZATION
const BASE = '/v1/session/bridge'
const SITE = 'dida-portal'
const BAD_ORGANIZATIONS: unknown[] = ['', 'ACME', 'Acme', '../acme', 'acme/rival', 'a'.repeat(64), '-acme', 'acme\n', 'ac me', 'acme\u0000', 42, null, {}]

let passed = 0
async function check(label: string, assertion: () => void | Promise<void>): Promise<void> {
  await assertion()
  passed += 1
  console.log(`  ok - ${label}`)
}

const roots: string[] = []
function tmpRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `gotry-bridge-org-${label}-`))
  roots.push(root)
  return root
}

const searchJob = (site = SITE): Omit<ExtensionJob, 'jobId'> => ({ kind: 'search', site, url: 'https://portal.dida.com/find' })

// ---- a store that records which methods the queue calls, for "refused before any store call" ----------------

const WRITE_METHODS = new Set(['insertQueuedJob', 'markClaimed', 'markResolved', 'markUnresolved', 'markVoid', 'recordOrphanResult', 'upsertClient', 'recordClientLoginSite', 'noteSiteHit', 'applyCooldown'])

class SpyStore implements BridgeJobStore {
  readonly calls: string[] = []
  private readonly inner: BridgeLedgerStore

  constructor(inner: BridgeLedgerStore) {
    this.inner = inner
  }

  private log(method: string, organization?: string): void {
    this.calls.push(organization === undefined ? method : `${method}:${organization}`)
  }

  writes(): string[] {
    return this.calls.filter((call) => WRITE_METHODS.has(call.split(':')[0]))
  }

  insertQueuedJob(organization: string, job: ExtensionJob, timeoutAt: number): void { this.log('insertQueuedJob', organization); this.inner.insertQueuedJob(organization, job, timeoutAt) }
  markClaimed(organization: string, jobId: string, claim: { origin: string; clientId?: string }): void { this.log('markClaimed', organization); this.inner.markClaimed(organization, jobId, claim) }
  markResolved(organization: string, jobId: string, result: ExtensionJobResult): void { this.log('markResolved', organization); this.inner.markResolved(organization, jobId, result) }
  markUnresolved(organization: string, jobId: string, note?: { reason: string }): void { this.log('markUnresolved', organization); this.inner.markUnresolved(organization, jobId, note) }
  markVoid(organization: string, jobId: string): void { this.log('markVoid', organization); this.inner.markVoid(organization, jobId) }
  recordOrphanResult(organization: string, jobId: string, result: ExtensionJobResult): void { this.log('recordOrphanResult', organization); this.inner.recordOrphanResult(organization, jobId, result) }
  upsertClient(organization: string, clientId: string, origin: string, capabilities: readonly string[]): void { this.log('upsertClient', organization); this.inner.upsertClient(organization, clientId, origin, capabilities) }
  recordClientLoginSite(organization: string, clientId: string, site: string): void { this.log('recordClientLoginSite', organization); this.inner.recordClientLoginSite(organization, clientId, site) }
  noteSiteHit(organization: string, site: string): void { this.log('noteSiteHit', organization); this.inner.noteSiteHit(organization, site) }
  applyCooldown(organization: string, site: string): void { this.log('applyCooldown', organization); this.inner.applyCooldown(organization, site) }
  pacingOf(organization: string, site: string): { lastHitAt: number; cooldownUntil: number } | null { this.log('pacingOf', organization); return this.inner.pacingOf(organization, site) }
  organizationOfJob(jobId: string): string | null { this.log('organizationOfJob'); return this.inner.organizationOfJob(jobId) }
  listPendingJobs(): ReturnType<BridgeJobStore['listPendingJobs']> { this.log('listPendingJobs'); return this.inner.listPendingJobs() }
}

// ---- loopback HTTP faces: the test's stand-in for the mounting host --------------------------------------------

interface Mounted {
  readonly port: number
  /** Switch the organization this face hands to the queue (the host's "authenticated caller"). */
  as(organization: unknown): void
}

interface Fixture {
  readonly root: string
  readonly store: BridgeLedgerStore
  readonly spy: SpyStore
  readonly queue: BridgeJobQueue
  /** A face of the queue for the given organization; `undefined` mounts it without any caller (the legacy lane). */
  serve(organization?: unknown): Promise<Mounted>
  done(): Promise<void>
}

async function fixture(label: string): Promise<Fixture> {
  const root = tmpRoot(label)
  const store = openBridgeLedgerStore(root)
  const spy = new SpyStore(store)
  const queue = createBridgeJobQueue({ store: spy })
  const servers: Array<{ close(): void; closeAllConnections?: () => void }> = []
  return {
    root,
    store,
    spy,
    queue,
    async serve(organization?: unknown): Promise<Mounted> {
      let current = organization
      const server = createServer((req, res) => {
        queue.handleMountedRequest(req, res, current === undefined ? undefined : { organization: current as string })
      })
      server.on('connection', (socket) => socket.unref())
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      server.unref()
      servers.push(server)
      return { port: (server.address() as { port: number }).port, as: (next: unknown) => { current = next } }
    },
    async done(): Promise<void> {
      for (const server of servers) {
        server.closeAllConnections?.()
        server.close()
      }
      await queue.close()
      store.close()
    },
  }
}

function headersFor(extra: Record<string, string> = {}, origin: string | null = EXTENSION_ORIGIN): Record<string, string> {
  return { 'content-type': 'application/json', ...(origin === null ? {} : { origin }), ...extra }
}

/** The fake extension's long poll. Parked polls only end when the test aborts them or a job arrives. */
async function poll(face: Mounted, body: Record<string, unknown> = {}, opts: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<{ job: ExtensionJob | null }> {
  const response = await fetch(`http://127.0.0.1:${face.port}${BASE}/jobs`, {
    method: 'POST',
    headers: headersFor(opts.headers),
    body: JSON.stringify({ extensionVersion: 'tenant-bridge-org-tests', ...body }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  assert.equal(response.status, 200)
  return (await response.json()) as { job: ExtensionJob | null }
}

async function postResult(face: Mounted, jobId: string, result: Record<string, unknown>, clientId?: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${face.port}${BASE}/results?jobId=${encodeURIComponent(jobId)}`, {
    method: 'POST',
    headers: headersFor(clientId ? { 'x-gotry-client-id': clientId } : {}),
    body: JSON.stringify(result),
  })
  return { status: response.status, body: await response.json() }
}

/** Any request that carries the trusted extension Origin refreshes that organization's heartbeat. */
async function heartbeat(face: Mounted): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${face.port}${BASE}/status`, { headers: headersFor({}, EXTENSION_ORIGIN) })
  assert.equal(response.status, 200)
  return (await response.json()) as Record<string, unknown>
}

async function until(condition: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for: ${label}`)
}

/** Resolves `pending` when the promise has not settled within `ms`: the way to assert "nothing was delivered". */
async function staysPending(promise: Promise<unknown>, ms = 150): Promise<boolean> {
  return (await Promise.race([promise.then(() => false, () => false), sleep(ms).then(() => true)])) as boolean
}

function jobRows(root: string): BridgeJobRow[] {
  const raw = new Database(bridgeLedgerDbPath(root), { readonly: true })
  try {
    return raw.prepare('SELECT * FROM bridge_jobs ORDER BY created_at, id').all() as BridgeJobRow[]
  } finally {
    raw.close()
  }
}

const LEGACY_DDL = `
CREATE TABLE bridge_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, site TEXT NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','claimed','resolved','unresolved','void')), claimed_by_client TEXT,
  claimed_origin TEXT, claimed_at INTEGER, timeout_at INTEGER, result_json TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX bridge_jobs_status ON bridge_jobs(status);
CREATE TABLE bridge_clients (client_id TEXT PRIMARY KEY, origin TEXT NOT NULL, capabilities_json TEXT NOT NULL DEFAULT '[]',
  last_seen_at INTEGER NOT NULL, login_sites_json TEXT NOT NULL DEFAULT '[]');
CREATE TABLE bridge_pacing (site TEXT PRIMARY KEY, last_hit_at INTEGER NOT NULL, cooldown_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE bridge_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, client_id TEXT NOT NULL, kind TEXT NOT NULL,
  site TEXT, subject TEXT NOT NULL, payload_json TEXT NOT NULL, idem_key TEXT);
CREATE UNIQUE INDEX bridge_events_idem_key ON bridge_events(idem_key) WHERE idem_key IS NOT NULL;
`

async function main(): Promise<void> {
  console.log('§95 bridge organization dimension (offline)')

  /* ---------- L: ledger ---------- */

  await check('L1 every bridge table carries organization (default local); keys include it; no leftover single-column idem index', () => {
    const root = tmpRoot('l1')
    openBridgeLedgerStore(root).close()
    const raw = new Database(bridgeLedgerDbPath(root), { readonly: true })
    try {
      const info = (table: string): Array<{ name: string; notnull: number; dflt_value: string | null; pk: number }> => raw.prepare(`PRAGMA table_info(${table})`).all() as never
      for (const table of ['bridge_jobs', 'bridge_clients', 'bridge_pacing', 'bridge_events']) {
        const column = info(table).find((c) => c.name === 'organization')
        assert.ok(column, `${table} has an organization column`)
        assert.equal(column.notnull, 1, `${table}.organization is NOT NULL`)
        assert.equal(column.dflt_value, "'local'", `${table}.organization defaults to local`)
      }
      const primaryKey = (table: string): string[] => info(table).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
      assert.deepEqual(primaryKey('bridge_clients'), ['organization', 'client_id'])
      assert.deepEqual(primaryKey('bridge_pacing'), ['organization', 'site'])
      assert.deepEqual(primaryKey('bridge_jobs'), ['id'], 'a job id stays globally unique')
      const indexes = raw.prepare('PRAGMA index_list(bridge_events)').all() as Array<{ name: string; unique: number; partial: number }>
      assert.ok(!indexes.some((i) => i.name === 'bridge_events_idem_key'), 'the single-column idem index is gone')
      const idem = indexes.find((i) => i.name === 'bridge_events_org_idem_key')
      assert.ok(idem && idem.unique === 1 && idem.partial === 1, 'a partial unique index on (organization, idem_key)')
      assert.deepEqual((raw.prepare('PRAGMA index_info(bridge_events_org_idem_key)').all() as Array<{ name: string }>).map((c) => c.name), ['organization', 'idem_key'])
    } finally {
      raw.close()
    }
  })

  await check('L2 two organizations never share pacing, client rows, event idempotency keys or event lists', () => {
    const root = tmpRoot('l2')
    const store = openBridgeLedgerStore(root)
    try {
      store.noteSiteHit(ACME, SITE)
      assert.ok(store.pacingOf(ACME, SITE))
      assert.equal(store.pacingOf(RIVAL, SITE), null, 'a hit by acme is not a hit by rival')
      assert.equal(store.pacingOf(LOCAL, SITE), null)
      store.applyCooldown(RIVAL, 'train-12306')
      assert.deepEqual(store.listPacing(ACME).map((r) => r.site), [SITE])
      assert.deepEqual(store.listPacing(RIVAL).map((r) => r.site), ['train-12306'])

      const client = randomUUID()
      store.upsertClient(ACME, client, 'chrome-extension://aaaa', ['dida-portal'])
      store.upsertClient(RIVAL, client, 'chrome-extension://bbbb', ['train-12306'])
      assert.equal(store.getClient(ACME, client)?.origin, 'chrome-extension://aaaa', 'the same client id is two rows')
      assert.equal(store.getClient(RIVAL, client)?.origin, 'chrome-extension://bbbb')
      assert.equal(store.getClient(LOCAL, client), null)
      store.recordClientLoginSite(ACME, client, SITE)
      assert.deepEqual(JSON.parse(store.getClient(ACME, client)!.login_sites_json), [SITE])
      assert.deepEqual(JSON.parse(store.getClient(RIVAL, client)!.login_sites_json), [], 'a login site noted for acme is not noted for rival')

      const event = { client_id: client, kind: 'workspace', site: null, subject: 's', payload_json: '{}', idem_key: 'same-key' }
      assert.equal(store.insertEvent(ACME, event), true)
      assert.equal(store.insertEvent(RIVAL, event), true, 'another organization may reuse an idempotency key')
      assert.equal(store.insertEvent(ACME, event), false, 'one organization cannot')
      assert.equal(store.listEvents(ACME).length, 1)
      assert.equal(store.listEvents(RIVAL).length, 1)
      assert.equal(store.listEvents(LOCAL).length, 0)
      assert.ok(store.listEvents(ACME).every((row) => row.organization === ACME))
    } finally {
      store.close()
    }
  })

  await check('L3 a job id is scoped to its organization: foreign updates change nothing, foreign reads see nothing, a foreign orphan write is refused', () => {
    const root = tmpRoot('l3')
    const store = openBridgeLedgerStore(root)
    try {
      const job: ExtensionJob = { jobId: 'job-acme-1', kind: 'search', site: SITE, url: 'https://portal.dida.com/find' }
      store.insertQueuedJob(ACME, job, Date.now() + 60_000)
      assert.equal(store.organizationOfJob(job.jobId), ACME)
      assert.equal(store.organizationOfJob('no-such-job'), null)
      store.markClaimed(RIVAL, job.jobId, { origin: EXTENSION_ORIGIN })
      store.markResolved(RIVAL, job.jobId, { ok: true })
      store.markUnresolved(RIVAL, job.jobId, { reason: 'forged' })
      store.markVoid(RIVAL, job.jobId)
      const untouched = store.getJob(job.jobId)!
      assert.equal(untouched.status, 'queued', 'no foreign update took effect')
      assert.equal(untouched.attempts, 0)
      assert.equal(untouched.result_json, null)
      assert.equal(untouched.organization, ACME)
      assert.equal(store.getJobForOrganization(RIVAL, job.jobId), null, 'a foreign read sees nothing')
      assert.equal(store.getJobForOrganization(ACME, job.jobId)?.id, job.jobId)
      assert.throws(() => store.recordOrphanResult(RIVAL, job.jobId, { ok: true, kind: 'search' }), /organization-mismatch/)
      assert.equal(store.getJob(job.jobId)?.result_json, null, 'the refused orphan wrote nothing')
      store.recordOrphanResult(ACME, job.jobId, { ok: true, kind: 'search' })
      assert.equal(store.getJob(job.jobId)?.status, 'unresolved', 'the owner can still reconcile its own job')
      // a genuinely unknown id becomes an orphan row of the caller, and only of the caller
      store.recordOrphanResult(RIVAL, 'job-unknown-1', { ok: true, kind: 'search' })
      assert.equal(store.getJob('job-unknown-1')?.organization, RIVAL)
      assert.equal(store.getJobForOrganization(ACME, 'job-unknown-1'), null)
    } finally {
      store.close()
    }
  })

  await check('L4 every store method validates the organization before the database is touched (a closed database still reports InvalidTenantIdError)', () => {
    const root = tmpRoot('l4')
    const store = openBridgeLedgerStore(root)
    store.close()
    const job: ExtensionJob = { jobId: 'x', kind: 'search', site: SITE }
    for (const bad of BAD_ORGANIZATIONS) {
      const organization = bad as string
      const calls: Array<() => unknown> = [
        () => store.insertQueuedJob(organization, job, 1),
        () => store.markClaimed(organization, 'x', { origin: EXTENSION_ORIGIN }),
        () => store.markResolved(organization, 'x', { ok: true }),
        () => store.markUnresolved(organization, 'x'),
        () => store.markVoid(organization, 'x'),
        () => store.recordOrphanResult(organization, 'x', { ok: true }),
        () => store.upsertClient(organization, randomUUID(), 'o', []),
        () => store.recordClientLoginSite(organization, 'c', 's'),
        () => store.noteSiteHit(organization, 's'),
        () => store.applyCooldown(organization, 's'),
        () => store.pacingOf(organization, 's'),
        () => store.insertEvent(organization, { client_id: 'c', kind: 'k', site: null, subject: 's', payload_json: '{}', idem_key: null }),
        () => store.listEvents(organization),
        () => store.getJobForOrganization(organization, 'x'),
        () => store.getClient(organization, 'c'),
        () => store.listPacing(organization),
      ]
      for (const call of calls) assert.throws(call, InvalidTenantIdError, `organization ${JSON.stringify(bad)} must be refused first`)
    }
    assert.throws(() => store.pacingOf(ACME, 's'), (error: unknown) => !(error instanceof InvalidTenantIdError), 'a valid organization on a closed database fails differently, so the check above is meaningful')
  })

  await check('L5 a legacy bridge.db (no organization anywhere) migrates in place: rows become local, keys are rebuilt, re-opening is idempotent', async () => {
    const root = tmpRoot('l5')
    const dbPath = bridgeLedgerDbPath(root)
    mkdirSync(dirname(dbPath), { recursive: true })
    const legacy = new Database(dbPath)
    const now = Date.now()
    legacy.exec(LEGACY_DDL)
    const insertJob = legacy.prepare(`INSERT INTO bridge_jobs (id, kind, site, payload_json, status, claimed_by_client, claimed_origin, timeout_at, result_json, attempts, created_at, updated_at)
      VALUES (@id, 'search', @site, @payload, @status, @client, @origin, @timeout, @result, @attempts, 1, 1)`)
    const payload = (jobId: string, site: string): string => JSON.stringify({ jobId, kind: 'search', site, url: 'https://portal.dida.com/find' })
    insertJob.run({ id: 'legacy-queued', site: SITE, payload: payload('legacy-queued', SITE), status: 'queued', client: null, origin: null, timeout: now + 60_000, result: null, attempts: 0 })
    insertJob.run({ id: 'legacy-claimed-dead', site: 'ctrip-hotel', payload: payload('legacy-claimed-dead', 'ctrip-hotel'), status: 'claimed', client: null, origin: EXTENSION_ORIGIN, timeout: now - 1_000, result: null, attempts: 1 })
    insertJob.run({ id: 'legacy-resolved', site: SITE, payload: payload('legacy-resolved', SITE), status: 'resolved', client: null, origin: EXTENSION_ORIGIN, timeout: now, result: '{"ok":true}', attempts: 1 })
    legacy.prepare(`INSERT INTO bridge_clients (client_id, origin, capabilities_json, last_seen_at, login_sites_json) VALUES ('legacy-client-1', ?, '["dida-portal"]', 5, '["dida-portal"]')`).run(EXTENSION_ORIGIN)
    legacy.prepare(`INSERT INTO bridge_clients (client_id, origin, capabilities_json, last_seen_at, login_sites_json) VALUES ('legacy-client-2', ?, '[]', 6, '[]')`).run(EXTENSION_ORIGIN)
    legacy.prepare(`INSERT INTO bridge_pacing (site, last_hit_at, cooldown_until) VALUES ('dida-portal', 100, 130000)`).run()
    legacy.prepare(`INSERT INTO bridge_pacing (site, last_hit_at, cooldown_until) VALUES ('ctrip-hotel', 200, 230000)`).run()
    const insertEvent = legacy.prepare(`INSERT INTO bridge_events (ts, client_id, kind, site, subject, payload_json, idem_key) VALUES (1, 'c', 'workspace', NULL, 's', '{}', ?)`)
    insertEvent.run('ev-1')
    insertEvent.run('ev-2')
    insertEvent.run(null)
    legacy.close()

    // open the legacy file three times: the first pass migrates, the others must find nothing left to do
    for (let pass = 0; pass < 3; pass += 1) {
      const store = openBridgeLedgerStore(root)
      try {
        const raw = new Database(dbPath, { readonly: true })
        try {
          for (const table of ['bridge_jobs', 'bridge_clients', 'bridge_pacing', 'bridge_events']) {
            const rows = raw.prepare(`SELECT organization FROM ${table}`).all() as Array<{ organization: string }>
            assert.ok(rows.length > 0 && rows.every((r) => r.organization === 'local'), `${table}: every legacy row is local (pass ${pass})`)
          }
          assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM bridge_jobs').get() as { n: number }).n, 3)
          assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM bridge_clients').get() as { n: number }).n, 2)
          assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM bridge_pacing').get() as { n: number }).n, 2)
          assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM bridge_events').get() as { n: number }).n, 3)
          assert.deepEqual(raw.prepare(`SELECT name FROM sqlite_master WHERE name LIKE '%\\_\\_legacy' ESCAPE '\\'`).all(), [], 'no half-migrated table is left')
          assert.deepEqual((raw.prepare('PRAGMA index_info(bridge_events_org_idem_key)').all() as Array<{ name: string }>).map((c) => c.name), ['organization', 'idem_key'])
          const keyOf = (table: string): string[] => (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
          assert.deepEqual(keyOf('bridge_clients'), ['organization', 'client_id'], 'the client key was rebuilt to include the organization')
          assert.deepEqual(keyOf('bridge_pacing'), ['organization', 'site'], 'the pacing key was rebuilt to include the organization')
          assert.ok(!(raw.prepare(`PRAGMA index_list(bridge_events)`).all() as Array<{ name: string }>).some((i) => i.name === 'bridge_events_idem_key'), 'the legacy single-column idem index was dropped')
        } finally {
          raw.close()
        }
        assert.equal(store.getJobForOrganization(LOCAL, 'legacy-resolved')?.result_json, '{"ok":true}')
        assert.equal(store.getJobForOrganization(ACME, 'legacy-resolved'), null, 'legacy rows are not visible to another organization')
        assert.deepEqual(store.pacingOf(LOCAL, SITE), { lastHitAt: 100, cooldownUntil: 130000 })
        assert.equal(store.pacingOf(ACME, SITE), null)
        assert.equal(store.getClient(LOCAL, 'legacy-client-1')?.login_sites_json, '["dida-portal"]')
        assert.equal(store.getClient(ACME, 'legacy-client-1'), null)
        const event = { client_id: 'c', kind: 'workspace', site: null, subject: 's', payload_json: '{}', idem_key: 'ev-1' }
        assert.equal(store.insertEvent(LOCAL, event), false, 'a legacy idempotency key still deduplicates inside local')
      } finally {
        store.close()
      }
    }
    {
      const store = openBridgeLedgerStore(root)
      try {
        const event = { client_id: 'c', kind: 'workspace', site: null, subject: 's', payload_json: '{}', idem_key: 'ev-1' }
        assert.equal(store.insertEvent(ACME, event), true, 'the legacy key no longer blocks another organization')
        assert.equal(store.insertEvent(ACME, event), false, 'and deduplicates inside it')
        assert.equal(store.listEvents(ACME).length, 1)
        assert.equal(store.listEvents(LOCAL).length, 3)
      } finally {
        store.close()
      }
    }

    // behavior on the migrated file: recovery restores local rows, a local poller can take them, an acme poller cannot
    const store = openBridgeLedgerStore(root)
    const queue = createBridgeJobQueue({ store })
    const local = createServer((req, res) => queue.handleMountedRequest(req, res))
    const acme = createServer((req, res) => queue.handleMountedRequest(req, res, { organization: ACME }))
    await Promise.all([local, acme].map((s) => new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))))
    const faces = { local: { port: (local.address() as { port: number }).port, as: () => undefined }, acme: { port: (acme.address() as { port: number }).port, as: () => undefined } }
    try {
      const summary = queue.recoverOnBoot!()
      assert.deepEqual(summary, { requeued: 1, rehydratedInFlight: 0, settledUnresolved: 1, voidedStale: 0 })
      assert.equal(queue.stats(LOCAL).queued, 1)
      assert.equal(queue.stats(ACME).queued, 0)
      const abort = new AbortController()
      const acmePoll = poll(faces.acme, { capabilities: [SITE] }, { signal: abort.signal }).then(() => 'received', () => 'aborted')
      await until(() => queue.stats(ACME).parked === 1, 'acme poller parked')
      assert.equal(await staysPending(acmePoll), true, 'the acme poller never gets a migrated local job')
      assert.equal((await poll(faces.local, { capabilities: [SITE] })).job?.jobId, 'legacy-queued')
      abort.abort()
      await acmePoll
      assert.ok(store.pacingOf(LOCAL, 'ctrip-hotel')!.cooldownUntil > Date.now(), 'the dead claim cooled the local site')
      assert.equal(store.pacingOf(ACME, 'ctrip-hotel'), null)
    } finally {
      local.closeAllConnections?.()
      acme.closeAllConnections?.()
      local.close()
      acme.close()
      await queue.close()
      store.close()
    }
  })

  /* ---------- Q: queue ---------- */

  await check('L6 an older binary recreates the single-column idempotency index; the next open of the new code drops it again, so one organization\'s key never blocks another\'s', async () => {
    const root = tmpRoot('l6')
    openBridgeLedgerStore(root).close()
    const dbPath = bridgeLedgerDbPath(root)
    const raw = new Database(dbPath)
    // what the older schema does at every open of the file
    raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS bridge_events_idem_key ON bridge_events(idem_key) WHERE idem_key IS NOT NULL')
    raw.close()
    const store = openBridgeLedgerStore(root)
    try {
      const check = new Database(dbPath, { readonly: true })
      try {
        const names = (check.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((row) => row.name)
        assert.ok(!names.includes('bridge_events_idem_key'), `the old single-column index is gone: ${names.join(',')}`)
        assert.ok(names.includes('bridge_events_org_idem_key'))
      } finally {
        check.close()
      }
      const event = { client_id: randomUUID(), kind: 'workspace', site: null, subject: 's', payload_json: '{}', idem_key: 'shared-key' }
      assert.equal(store.insertEvent(ACME, event), true)
      assert.equal(store.insertEvent(RIVAL, event), true, 'the same key in another organization is its own event')
      assert.equal(store.insertEvent(ACME, event), false, 'and still deduplicates inside one')
    } finally {
      store.close()
    }
  })

  await check('Q1 a queued job is never handed to a poller of another organization, even with the same site, origin and client id', async () => {
    const f = await fixture('q1')
    try {
      const acme = await f.serve(ACME)
      const rival = await f.serve(RIVAL)
      const sharedClient = randomUUID()
      await heartbeat(acme)
      const pending = f.queue.forOrganization(ACME).submit(searchJob(), { timeoutMs: 10_000, extensionWaitMs: 30_000 })
      assert.equal(f.queue.stats(ACME).queued, 1)
      const abort = new AbortController()
      const rivalPoll = poll(rival, { clientId: sharedClient, capabilities: [SITE] }, { signal: abort.signal }).then(() => 'received', () => 'aborted')
      await until(() => f.queue.stats(RIVAL).parked === 1, 'rival poller parked')
      assert.equal(await staysPending(rivalPoll), true, 'the rival poller is still waiting')
      assert.equal(f.queue.stats(ACME).queued, 1)
      assert.equal(f.queue.stats(ACME).inFlight, 0)
      assert.equal(f.queue.stats(RIVAL).inFlight, 0)
      const got = await poll(acme, { clientId: sharedClient, capabilities: [SITE] })
      assert.ok(got.job, 'the owner organization receives it')
      assert.equal(f.store.getJobForOrganization(ACME, got.job.jobId)?.status, 'claimed')
      assert.equal(f.store.getJobForOrganization(RIVAL, got.job.jobId), null)
      abort.abort()
      assert.equal(await rivalPoll, 'aborted')
      assert.equal((await postResult(acme, got.job.jobId, { ok: true, kind: 'search', body: '{}' }, sharedClient)).status, 200)
      assert.equal((await pending).ok, true)
    } finally {
      await f.done()
    }
  })

  await check('Q2 a parked poller of another organization is not woken by a new job, in either direction, while the same organization\'s parked poller is', async () => {
    const f = await fixture('q2')
    try {
      const acme = await f.serve(ACME)
      const rival = await f.serve(RIVAL)
      // A: a rival poller is parked; acme submits a job it could technically run
      const abortRival = new AbortController()
      const rivalPoll = poll(rival, { capabilities: [SITE] }, { signal: abortRival.signal }).then(() => 'received', () => 'aborted')
      await until(() => f.queue.stats(RIVAL).parked === 1, 'rival poller parked')
      await heartbeat(acme)
      const acmeJob = f.queue.forOrganization(ACME).submit(searchJob(), { timeoutMs: 10_000, extensionWaitMs: 30_000 })
      assert.equal(await staysPending(rivalPoll), true, 'acme\'s job did not wake the parked rival poller')
      assert.equal(f.queue.stats(ACME).queued, 1, 'the job waits for an acme poller')
      assert.equal(f.queue.stats(RIVAL).parked, 1)
      assert.equal(f.queue.stats(RIVAL).inFlight, 0)

      // B: the reverse, with a positive control. An acme poller is parked first, so it is first in line when a
      // rival job arrives; the rival's own parked poller behind it must be the one that gets the job.
      const abortAcme = new AbortController()
      const acmePoll = poll(acme, { capabilities: ['train-12306'] }, { signal: abortAcme.signal }).then(() => 'received', () => 'aborted')
      await until(() => f.queue.stats(ACME).parked === 1, 'acme poller parked')
      const rivalOwn = poll(rival, { capabilities: ['train-12306'] }).then((r) => r.job?.site ?? 'none')
      await until(() => f.queue.stats(RIVAL).parked === 2, 'second rival poller parked')
      const rivalJob = f.queue.forOrganization(RIVAL).submit(searchJob('train-12306'), { timeoutMs: 10_000, extensionWaitMs: 30_000 })
      assert.equal(await rivalOwn, 'train-12306', 'the rival\'s own parked poller received its job')
      assert.equal(await staysPending(acmePoll), true, 'the acme poller, parked earlier and first in line, did not')
      assert.equal(f.queue.stats(ACME).parked, 1)
      assert.equal(f.queue.stats(ACME).inFlight, 0)
      assert.equal(f.queue.stats(RIVAL).inFlight, 1)
      abortAcme.abort()
      abortRival.abort()
      await Promise.all([acmePoll, rivalPoll])
      void acmeJob
      void rivalJob
    } finally {
      await f.done()
    }
  })

  await check('Q3 the default lane: a caller-less poller gets only local jobs, and local jobs go only to it', async () => {
    const f = await fixture('q3')
    try {
      const local = await f.serve()
      const acme = await f.serve(ACME)
      await heartbeat(local)
      await heartbeat(acme)
      const localJob = f.queue.submit(searchJob(), { timeoutMs: 10_000, extensionWaitMs: 30_000 })
      const acmeJob = f.queue.forOrganization(ACME).submit(searchJob(), { timeoutMs: 10_000, extensionWaitMs: 30_000 })
      assert.equal(f.queue.stats(LOCAL).queued, 1)
      assert.equal(f.queue.stats(ACME).queued, 1)
      const gotLocal = await poll(local, { capabilities: [SITE] })
      const gotAcme = await poll(acme, { capabilities: [SITE] })
      assert.ok(gotLocal.job && gotAcme.job && gotLocal.job.jobId !== gotAcme.job.jobId)
      assert.equal(f.store.getJob(gotLocal.job.jobId)?.organization, LOCAL)
      assert.equal(f.store.getJob(gotAcme.job.jobId)?.organization, ACME)
      await postResult(local, gotLocal.job.jobId, { ok: true, kind: 'search', body: '{}' })
      await postResult(acme, gotAcme.job.jobId, { ok: true, kind: 'search', body: '{}' })
      assert.equal((await localJob).ok && (await acmeJob).ok, true)
    } finally {
      await f.done()
    }
  })

  await check('Q4 a result for another organization\'s job is answered like an unknown job and writes nothing; the owner\'s job stays in flight and still resolves', async () => {
    const f = await fixture('q4')
    try {
      const acme = await f.serve(ACME)
      const rival = await f.serve(RIVAL)
      const client = randomUUID()
      await heartbeat(acme)
      const pending = f.queue.forOrganization(ACME).submit(searchJob(), { timeoutMs: 10_000, extensionWaitMs: 30_000 })
      const got = await poll(acme, { clientId: client, capabilities: [SITE] })
      const jobId = got.job!.jobId
      const before = jobRows(f.root)
      f.spy.calls.length = 0

      // even with the owner's client id header and the same Origin, the rival is just an unknown caller
      const foreign = await postResult(rival, jobId, { ok: true, kind: 'search', body: 'FORGED-BY-RIVAL' }, client)
      const unknown = await postResult(rival, randomUUID(), { ok: true, kind: 'search', body: 'x' })
      assert.equal(foreign.status, 404)
      assert.deepEqual(foreign.body, { ok: false, error: 'unknown-job' })
      assert.equal(unknown.status, foreign.status, 'a foreign job id and an unknown job id are indistinguishable')
      assert.deepEqual(unknown.body, foreign.body)

      const writes = f.spy.writes()
      assert.deepEqual(writes.filter((w) => !w.startsWith('recordOrphanResult:rival')), [], 'only the genuinely unknown id wrote anything, and only as rival')
      assert.equal(writes.filter((w) => w.startsWith('recordOrphanResult')).length, 1, 'exactly one orphan write: the unknown id, not the foreign one')
      const after = jobRows(f.root)
      assert.equal(after.length, before.length + 1, 'one new row: the orphan of the unknown id')
      const job = after.find((r) => r.id === jobId)!
      assert.deepEqual({ status: job.status, attempts: job.attempts, result: job.result_json, organization: job.organization }, { status: 'claimed', attempts: 1, result: null, organization: ACME })
      assert.equal(f.queue.stats(ACME).inFlight, 1, 'the owner\'s job is still in flight')

      assert.equal((await postResult(acme, jobId, { ok: true, kind: 'search', body: 'REAL' }, client)).status, 200, 'the owner\'s own result still resolves it')
      const outcome = await pending
      assert.ok(outcome.ok && outcome.result.body === 'REAL')
      assert.equal(f.store.getJob(jobId)?.status, 'resolved')
    } finally {
      await f.done()
    }
  })

  await check('Q5 a foreign result for a job that is still queued, or already resolved (ledger only), changes nothing and writes no orphan', async () => {
    const f = await fixture('q5')
    try {
      const acme = await f.serve(ACME)
      const rival = await f.serve(RIVAL)
      await heartbeat(acme)
      // queued, not yet claimed
      const queued = f.queue.forOrganization(ACME).submit(searchJob(), { timeoutMs: 10_000, extensionWaitMs: 30_000 })
      const queuedId = jobRows(f.root)[0].id
      f.spy.calls.length = 0
      assert.equal((await postResult(rival, queuedId, { ok: true, kind: 'search', body: 'FORGED' })).status, 404)
      assert.deepEqual(f.spy.writes(), [])
      assert.equal(f.queue.stats(ACME).queued, 1)
      assert.equal(f.store.getJob(queuedId)?.status, 'queued')

      // resolved, then gone from memory: only the ledger knows whose it is
      const got = await poll(acme, { capabilities: [SITE] })
      assert.equal(got.job!.jobId, queuedId)
      await postResult(acme, queuedId, { ok: true, kind: 'search', body: 'REAL' })
      assert.equal((await queued).ok, true)
      const resolved = f.store.getJob(queuedId)!
      f.spy.calls.length = 0
      assert.equal((await postResult(rival, queuedId, { ok: true, kind: 'search', body: 'LATE-FORGED' })).status, 404)
      assert.equal(f.spy.writes().length, 0, 'no orphan write for a resolved job of another organization')
      assert.deepEqual(f.store.getJob(queuedId), resolved, 'the resolved row is byte for byte unchanged')
      // the owner\'s own late duplicate still takes the legacy path (404 + an idempotent orphan call that changes nothing)
      f.spy.calls.length = 0
      assert.equal((await postResult(acme, queuedId, { ok: true, kind: 'search', body: 'LATE-OWN' })).status, 404)
      assert.deepEqual(f.spy.writes(), [`recordOrphanResult:${ACME}`])
      assert.deepEqual(f.store.getJob(queuedId), resolved)
    } finally {
      await f.done()
    }
  })

  await check('Q6 a genuinely unknown job id keeps today\'s reconciliation, filed under the caller\'s organization only', async () => {
    const f = await fixture('q6')
    try {
      const rival = await f.serve(RIVAL)
      const id = `orphan-${randomUUID()}`
      const response = await postResult(rival, id, { ok: true, kind: 'search', body: 'ORPHAN-EVIDENCE' })
      assert.equal(response.status, 404)
      const row = f.store.getJob(id)!
      assert.equal(row.organization, RIVAL)
      assert.equal(row.status, 'unresolved')
      assert.ok(row.result_json?.includes('ORPHAN-EVIDENCE'))
      assert.equal(f.store.getJobForOrganization(ACME, id), null)
      // and the id is now rival\'s: acme posting the same id is treated as foreign, not as a second orphan
      f.spy.calls.length = 0
      const acme = await f.serve(ACME)
      assert.equal((await postResult(acme, id, { ok: true, kind: 'search', body: 'ACME-OVERWRITE' })).status, 404)
      assert.deepEqual(f.spy.writes(), [])
      assert.ok(f.store.getJob(id)?.result_json?.includes('ORPHAN-EVIDENCE'))
    } finally {
      await f.done()
    }
  })

  await check('Q7 heartbeats, stats and /status are per organization', async () => {
    const f = await fixture('q7')
    try {
      const acme = await f.serve(ACME)
      const rival = await f.serve(RIVAL)
      const local = await f.serve()
      assert.equal(f.queue.extensionConnected(ACME), false)
      await heartbeat(acme)
      assert.equal(f.queue.extensionConnected(ACME), true)
      assert.equal(f.queue.extensionConnected(RIVAL), false, 'acme\'s extension being online says nothing about rival\'s')
      assert.equal(f.queue.extensionConnected(), false, 'nor about the default lane')
      assert.equal(f.queue.extensionConnected(LOCAL), false)
      assert.ok(f.queue.stats(ACME).lastSeenMsAgo !== null)
      assert.equal(f.queue.stats(RIVAL).lastSeenMsAgo, null)
      // a diagnostic GET without the extension Origin must not fake a heartbeat
      await fetch(`http://127.0.0.1:${rival.port}${BASE}/status`)
      assert.equal(f.queue.extensionConnected(RIVAL), false)

      const pending = f.queue.forOrganization(ACME).submit(searchJob(), { timeoutMs: 10_000, extensionWaitMs: 30_000 })
      assert.equal(f.queue.stats(ACME).queued, 1)
      assert.equal(f.queue.stats(RIVAL).queued, 0)
      assert.equal(f.queue.stats().queued, 0, 'the default lane counts only its own queue')
      const rivalStatus = await heartbeat(rival)
      assert.equal(rivalStatus.queued, 0, 'rival\'s /status does not count acme\'s queue')
      assert.equal(rivalStatus.extensionConnected, true, 'its own request refreshed its own heartbeat')
      const localStatus = await (await fetch(`http://127.0.0.1:${local.port}${BASE}/status`)).json() as Record<string, unknown>
      assert.equal(localStatus.queued, 0)
      assert.equal(localStatus.extensionConnected, false)
      void pending
    } finally {
      await f.done()
    }
  })

  await check('Q8 the caller organization comes only from the host: bodies and headers that name another organization change nothing', async () => {
    const f = await fixture('q8')
    try {
      const local = await f.serve()
      const acme = await f.serve(ACME)
      await heartbeat(acme)
      await heartbeat(local)
      const pending = f.queue.forOrganization(ACME).submit(searchJob(), { timeoutMs: 10_000, extensionWaitMs: 30_000 })
      const abort = new AbortController()
      const forged = poll(local, { capabilities: [SITE], organization: ACME, tenant: ACME, ledgerTenant: 't-0123456789abcdef0123456789abcdef' }, {
        signal: abort.signal,
        headers: { 'x-gotry-organization': ACME, 'x-organization': ACME, 'x-tenant-id': ACME, 'x-forwarded-organization': ACME },
      }).then(() => 'received', () => 'aborted')
      await until(() => f.queue.stats(LOCAL).parked === 1, 'local poller parked')
      assert.equal(f.queue.stats(ACME).parked, 0, 'forged fields did not move the poller into acme')
      assert.equal(await staysPending(forged), true, 'and it did not receive acme\'s job')
      // the other direction: an acme face stays acme whatever the body says
      const abortAcme = new AbortController()
      const acmePoll = poll(acme, { capabilities: ['train-12306'], organization: RIVAL }, { signal: abortAcme.signal, headers: { 'x-gotry-organization': RIVAL } }).then(() => 'received', () => 'aborted')
      await until(() => f.queue.stats(ACME).parked === 1, 'acme poller parked')
      assert.equal(f.queue.stats(RIVAL).parked, 0)
      abort.abort()
      abortAcme.abort()
      await Promise.all([forged, acmePoll])
      void pending
    } finally {
      await f.done()
    }
  })

  await check('Q9 an invalid caller organization is refused with 403 before any state, store call or heartbeat; an explicit null or missing field is not "local"', async () => {
    const f = await fixture('q9')
    try {
      const face = await f.serve(ACME)
      for (const bad of BAD_ORGANIZATIONS) {
        face.as(bad)
        for (const [method, path] of [['POST', 'jobs'], ['POST', 'results?jobId=x'], ['GET', 'status'], ['GET', 'health']] as const) {
          const response = await fetch(`http://127.0.0.1:${face.port}${BASE}/${path}`, { method, headers: headersFor({}, EXTENSION_ORIGIN), ...(method === 'POST' ? { body: '{}' } : {}) })
          assert.equal(response.status, 403, `${method} ${path} for ${JSON.stringify(bad)}`)
          assert.deepEqual(await response.json(), { ok: false, error: 'organization-invalid' })
        }
      }
      assert.deepEqual(f.spy.calls, [], 'the store was never called')
      for (const org of [LOCAL, ACME, RIVAL]) {
        assert.equal(f.queue.extensionConnected(org), false, 'no heartbeat was recorded for anyone')
        assert.deepEqual(f.queue.stats(org), { queued: 0, inFlight: 0, parked: 0, lastSeenMsAgo: null })
      }
      assert.equal(jobRows(f.root).length, 0)
      // a caller object without the field is invalid, not the default lane
      const bare = createServer((req, res) => f.queue.handleMountedRequest(req, res, {} as { organization: string }))
      await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve))
      try {
        const response = await fetch(`http://127.0.0.1:${(bare.address() as { port: number }).port}${BASE}/status`)
        assert.equal(response.status, 403)
      } finally {
        bare.closeAllConnections?.()
        bare.close()
      }
    } finally {
      await f.done()
    }
  })

  await check('Q10 submit, forOrganization, stats and extensionConnected refuse a bad organization before any store call', async () => {
    const f = await fixture('q10')
    try {
      for (const bad of BAD_ORGANIZATIONS) {
        const outcome = await f.queue.submit(searchJob(), { organization: bad as string, timeoutMs: 200, extensionWaitMs: 0 })
        assert.equal(outcome.ok, false)
        if (!outcome.ok) assert.equal(outcome.reason, 'bridge-unavailable')
        assert.throws(() => f.queue.forOrganization(bad as string), InvalidTenantIdError)
        assert.throws(() => f.queue.stats(bad as string), InvalidTenantIdError)
        assert.throws(() => f.queue.extensionConnected(bad as string), InvalidTenantIdError)
      }
      assert.deepEqual(f.spy.calls, [], 'no store call happened')
      assert.equal(jobRows(f.root).length, 0)
      assert.deepEqual(f.queue.stats(), { queued: 0, inFlight: 0, parked: 0, lastSeenMsAgo: null })
    } finally {
      await f.done()
    }
  })

  await check('Q11 forOrganization cannot be redirected, and a payload cannot choose the organization either', async () => {
    const f = await fixture('q11')
    try {
      const acme = await f.serve(ACME)
      const rival = await f.serve(RIVAL)
      await heartbeat(acme)
      const bound = f.queue.forOrganization(ACME)
      const redirected = bound.submit(searchJob(), { organization: RIVAL, timeoutMs: 10_000, extensionWaitMs: 30_000 } as never)
      assert.equal(f.queue.stats(ACME).queued, 1, 'the bound handle overrides the organization in the options')
      assert.equal(f.queue.stats(RIVAL).queued, 0)
      assert.equal(jobRows(f.root)[0].organization, ACME)
      // a job whose payload claims to belong to rival is still acme's
      const lying = f.queue.forOrganization(ACME).submit({ ...searchJob('train-12306'), organization: RIVAL } as never, { timeoutMs: 10_000, extensionWaitMs: 30_000 })
      const lyingRow = jobRows(f.root).find((r) => r.site === 'train-12306')!
      assert.equal(lyingRow.organization, ACME, 'the column comes from the bound organization')
      assert.ok(lyingRow.payload_json.includes(`"organization":"${RIVAL}"`), 'the lie is in the payload, exactly as the caller wrote it')
      const abort = new AbortController()
      const rivalPoll = poll(rival, { capabilities: ['train-12306', SITE] }, { signal: abort.signal }).then(() => 'received', () => 'aborted')
      await until(() => f.queue.stats(RIVAL).parked === 1, 'rival parked')
      assert.equal(await staysPending(rivalPoll), true, 'the payload\'s claim did not route the job to rival')
      abort.abort()
      await rivalPoll
      // closing the bound handle is closing a view: the shared queue keeps accepting work
      await bound.close()
      const later = f.queue.forOrganization(ACME).submit(searchJob(), { timeoutMs: 10_000, extensionWaitMs: 30_000 })
      assert.equal(f.queue.stats(ACME).queued, 3, 'the queue is still open after the view was closed')
      void redirected
      void lying
      void later
    } finally {
      await f.done()
    }
  })

  await check('Q12 recoverOnBoot restores each row under the organization of its column, never of its payload; pacing and results stay inside', async () => {
    const f = await fixture('q12')
    try {
      const t0 = Date.now()
      const live = randomUUID()
      f.store.insertQueuedJob(ACME, { jobId: 'rec-acme-queued', kind: 'search', site: SITE, url: 'https://portal.dida.com/find' }, t0 + 60_000)
      f.store.insertQueuedJob(RIVAL, { jobId: 'rec-rival-queued', kind: 'search', site: SITE, url: 'https://portal.dida.com/find' }, t0 + 60_000)
      f.store.insertQueuedJob(ACME, { jobId: 'rec-acme-lying', kind: 'search', site: SITE, url: 'https://portal.dida.com/find', organization: RIVAL } as never, t0 + 60_000)
      f.store.insertQueuedJob(ACME, { jobId: 'rec-acme-live', kind: 'search', site: 'ctrip-flight', url: 'https://flights.ctrip.com/online/list' }, t0 + 60_000)
      f.store.markClaimed(ACME, 'rec-acme-live', { origin: EXTENSION_ORIGIN, clientId: live })
      f.store.insertQueuedJob(RIVAL, { jobId: 'rec-rival-dead', kind: 'search', site: 'ctrip-hotel', url: 'https://hotels.ctrip.com/hotels/list' }, t0 - 1_000)
      f.store.markClaimed(RIVAL, 'rec-rival-dead', { origin: EXTENSION_ORIGIN })
      const acme = await f.serve(ACME)
      const rival = await f.serve(RIVAL)

      const summary = f.queue.recoverOnBoot!()
      assert.deepEqual(summary, { requeued: 3, rehydratedInFlight: 1, settledUnresolved: 1, voidedStale: 0 })
      assert.deepEqual([f.queue.stats(ACME).queued, f.queue.stats(ACME).inFlight], [2, 1])
      assert.deepEqual([f.queue.stats(RIVAL).queued, f.queue.stats(RIVAL).inFlight], [1, 0])
      assert.deepEqual([f.queue.stats(LOCAL).queued, f.queue.stats(LOCAL).inFlight], [0, 0])
      assert.ok(f.store.pacingOf(RIVAL, 'ctrip-hotel'), 'the dead claim cooled rival\'s site')
      assert.equal(f.store.pacingOf(ACME, 'ctrip-hotel'), null)
      assert.equal(f.store.pacingOf(LOCAL, 'ctrip-hotel'), null)

      assert.equal((await poll(rival, { capabilities: [SITE] })).job?.jobId, 'rec-rival-queued', 'rival gets only its own queued job')
      const first = await poll(acme, { capabilities: [SITE] })
      const second = await poll(acme, { capabilities: [SITE] })
      assert.deepEqual([first.job?.jobId, second.job?.jobId].sort(), ['rec-acme-lying', 'rec-acme-queued'])
      assert.equal(f.store.pacingOf(RIVAL, SITE) !== null && f.store.pacingOf(ACME, SITE) !== null, true, 'each organization\'s claim cooled its own site')

      // the revived claim: rival cannot resolve it (even with the live client id), acme can
      assert.equal((await postResult(rival, 'rec-acme-live', { ok: true, kind: 'search', body: 'FORGED' }, live)).status, 404)
      assert.equal(f.store.getJob('rec-acme-live')?.status, 'claimed')
      assert.equal((await postResult(acme, 'rec-acme-live', { ok: true, kind: 'search', body: 'REAL' }, live)).status, 200)
      assert.equal(f.store.getJob('rec-acme-live')?.status, 'resolved')
    } finally {
      await f.done()
    }
  })

  await check('Q13 a ledger row whose organization column is corrupt is skipped on recovery (fail closed), not guessed into local', async () => {
    const f = await fixture('q13')
    try {
      f.store.insertQueuedJob(ACME, { jobId: 'rec-corrupt', kind: 'search', site: SITE, url: 'https://portal.dida.com/find' }, Date.now() + 60_000)
      const raw = new Database(bridgeLedgerDbPath(f.root))
      try {
        raw.prepare(`UPDATE bridge_jobs SET organization='../evil' WHERE id='rec-corrupt'`).run()
      } finally {
        raw.close()
      }
      const summary = f.queue.recoverOnBoot!()
      assert.deepEqual(summary, { requeued: 0, rehydratedInFlight: 0, settledUnresolved: 0, voidedStale: 0 })
      for (const org of [LOCAL, ACME]) assert.equal(f.queue.stats(org).queued, 0)
    } finally {
      await f.done()
    }
  })

  await check('Q14 navigation pacing is per organization and site through the queue', async () => {
    const f = await fixture('q14')
    try {
      const acme = await f.serve(ACME)
      await heartbeat(acme)
      const pending = f.queue.forOrganization(ACME).submit(searchJob(), { timeoutMs: 10_000, extensionWaitMs: 30_000 })
      assert.ok(f.store.pacingOf(ACME, SITE), 'submitting a navigation job notes acme\'s hit')
      assert.equal(f.store.pacingOf(RIVAL, SITE), null)
      assert.equal(f.store.pacingOf(LOCAL, SITE), null)
      const got = await poll(acme, { capabilities: [SITE] })
      await postResult(acme, got.job!.jobId, { ok: true, kind: 'search', body: '{}' })
      await pending
      assert.deepEqual(f.store.listPacing(ACME).map((r) => r.organization), [ACME])
      assert.deepEqual(f.store.listPacing(RIVAL), [])
    } finally {
      await f.done()
    }
  })

  /* ---------- M: session-search module hooks ---------- */

  const KEY = 'tenant-bridge-org-key'
  const ORG_HEADER = 'x-test-resolved-organization'

  interface Harness {
    readonly root: string
    readonly base: string
    readonly searches: Array<{ query?: { city?: string }; bridge: SessionJobHandle }>
    readonly admissions: Array<{ organization: string }>
    releases: number
    decide: (organization: string) => SessionAdmissionDecision
    searchImpl: (query?: { city?: string }) => Promise<void>
    done(): Promise<void>
  }

  async function harness(label: string, options: { scoped?: boolean; admission?: boolean } = {}): Promise<Harness> {
    const root = tmpRoot(label)
    const h: Harness = {
      root,
      base: '',
      searches: [],
      admissions: [],
      releases: 0,
      decide: () => ({ ok: true, release: () => { h.releases += 1 } }),
      searchImpl: async () => undefined,
      async done() {
        await closeBackend(handle, [mod])
      },
    }
    const mod = startSessionSearchModule({
      apiKey: () => KEY,
      stateRoot: root,
      verdictLog: () => undefined,
      search: async (opts) => {
        h.searches.push({ query: opts.query, bridge: opts.bridge! })
        await h.searchImpl(opts.query)
        return { ok: true, via: 'session-dida-portal', evidence: '[session:dida-portal@tenant-bridge-org-tests]', latencyMs: 1, verdict: 'hit', rates: [] }
      },
      ...(options.scoped === false ? {} : {
        callerOrganization: (req: IncomingMessage) => {
          const value = req.headers[ORG_HEADER]
          return typeof value === 'string' ? value : null
        },
      }),
      ...(options.admission ? {
        admission: (_req: IncomingMessage, organization: string) => {
          h.admissions.push({ organization })
          return h.decide(organization)
        },
      } : {}),
    })
    const handle: BackendServerHandle = await createBackendServer({ modules: [mod], port: 0 })
    ;(h as { base: string }).base = `http://127.0.0.1:${handle.port}`
    return h
  }

  const authed = (organization?: string, extra: Record<string, string> = {}, origin: string | null = null): Record<string, string> => ({
    authorization: `Bearer ${KEY}`,
    'content-type': 'application/json',
    ...(organization === undefined ? {} : { [ORG_HEADER]: organization }),
    ...(origin === null ? {} : { origin }),
    ...extra,
  })

  async function postSearch(h: Harness, organization: string | undefined, body: unknown = { supplier: SITE }): Promise<Response> {
    return fetch(`${h.base}/v1/session/search`, { method: 'POST', headers: authed(organization), body: JSON.stringify(body) })
  }

  await check('M1 callerOrganization: null, invalid or throwing resolution is 403 organization-unresolved on every route, after (never instead of) the bearer check', async () => {
    const h = await harness('m1')
    try {
      const routes: Array<[string, string, string?]> = [
        ['GET', '/v1/session/status'], ['POST', '/v1/session/search', '{"supplier":"dida-portal"}'], ['POST', '/v1/session/login/open', '{"supplier":"dida-portal"}'],
        ['GET', '/v1/session/bridge/health'], ['GET', '/v1/session/bridge/status'], ['POST', '/v1/session/bridge/jobs', '{}'],
        ['POST', '/v1/session/bridge/results?jobId=x', '{}'], ['POST', '/v1/session/bridge/events', '{}'],
      ]
      for (const [method, path, body] of routes) {
        for (const organization of [undefined, '', 'ACME', '../acme', 'a'.repeat(64)]) {
          const response = await fetch(`${h.base}${path}`, { method, headers: authed(organization, {}, EXTENSION_ORIGIN), ...(body === undefined ? {} : { body }) })
          assert.equal(response.status, 403, `${method} ${path} org=${JSON.stringify(organization)}`)
          assert.deepEqual(await response.json(), { ok: false, error: 'organization-unresolved' })
        }
        const wrongBearer = await fetch(`${h.base}${path}`, { method, headers: { ...authed(ACME, {}, EXTENSION_ORIGIN), authorization: 'Bearer wrong' }, ...(body === undefined ? {} : { body }) })
        assert.deepEqual(await wrongBearer.json(), { ok: false, error: 'forbidden' }, 'a bad bearer is answered by the bearer check, not the organization one')
      }
      assert.equal(h.searches.length, 0, 'no request reached the search')
      assert.equal(jobRows(h.root).length, 0)
    } finally {
      await h.done()
    }
    const thrower = startSessionSearchModule({ apiKey: () => KEY, callerOrganization: () => { throw new Error('resolver down') } })
    const server = await createBackendServer({ modules: [thrower], port: 0 })
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/session/status`, { headers: authed() })
      assert.equal(response.status, 403)
    } finally {
      await closeBackend(server, [thrower])
    }
  })

  await check('M2 events: the organization the host resolved owns the rows; the same idempotency key is accepted once per organization', async () => {
    const h = await harness('m2')
    try {
      const client = randomUUID()
      const body = JSON.stringify({ clientId: client, events: [{ kind: 'workspace', subject: 's', payload_json: '{}', idem_key: 'k-1' }] })
      const post = (organization: string) => fetch(`${h.base}/v1/session/bridge/events`, { method: 'POST', headers: authed(organization, {}, EXTENSION_ORIGIN), body }).then((r) => r.json())
      assert.deepEqual(await post(ACME), { ok: true, accepted: 1, rejected: 0 })
      assert.deepEqual(await post(RIVAL), { ok: true, accepted: 1, rejected: 0 }, 'rival\'s identical key is its own event')
      assert.deepEqual(await post(ACME), { ok: true, accepted: 0, rejected: 1 }, 'a replay inside one organization is still deduplicated')
      // a body field that names another organization is just an unknown field of an event
      const forged = JSON.stringify({ clientId: client, organization: RIVAL, events: [{ kind: 'workspace', subject: 's', payload_json: '{}', idem_key: 'k-2', organization: RIVAL }] })
      await fetch(`${h.base}/v1/session/bridge/events`, { method: 'POST', headers: authed(ACME, {}, EXTENSION_ORIGIN), body: forged })
      const reader = openBridgeLedgerStore(h.root)
      try {
        assert.deepEqual(reader.listEvents(ACME).map((e) => e.idem_key), ['k-1', 'k-2'])
        assert.deepEqual(reader.listEvents(RIVAL).map((e) => e.idem_key), ['k-1'])
        assert.equal(reader.listEvents(LOCAL).length, 0)
      } finally {
        reader.close()
      }
    } finally {
      await h.done()
    }
  })

  await check('M3 search: the bridge handed to the search is bound to the caller\'s organization; the ledger cooldown and the single-flight lock are per organization', async () => {
    const h = await harness('m3')
    try {
      // 1. the bridge is bound
      const hit = await postSearch(h, ACME)
      assert.equal(hit.status, 200)
      const outcome = await h.searches[0].bridge.submit({ kind: 'cookie-names', site: SITE }, { timeoutMs: 200, extensionWaitMs: 0, organization: RIVAL } as never)
      assert.equal(outcome.ok, false)
      assert.deepEqual(jobRows(h.root).map((r) => r.organization), [ACME], 'the job the search made is acme\'s, whatever the option said')

      // 2. the ledger cooldown of one organization does not throttle another
      const writer = openBridgeLedgerStore(h.root)
      try {
        writer.applyCooldown(ACME, SITE)
      } finally {
        writer.close()
      }
      const hot = await postSearch(h, ACME)
      assert.equal(hot.status, 429)
      assert.ok(String(hot.headers.get('retry-after')).length > 0)
      assert.equal((await postSearch(h, RIVAL)).status, 200, 'rival is not cooling down because acme is')
      assert.equal((await postSearch(h, undefined)).status, 403, 'a request the host could not attribute never reaches the search')

      // 3. a slow search of one organization does not queue another organization behind it
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      h.searchImpl = async (query) => { if (query?.city === 'slow') await gate }
      const slow = postSearch(h, 'orgslow', { supplier: SITE, query: { city: 'slow' } })
      try {
        await until(() => h.searches.some((s) => s.query?.city === 'slow'), 'the slow search started')
        const fast = await Promise.race([postSearch(h, 'orgfast', { supplier: SITE, query: { city: 'fast' } }).then((r) => r.status), sleep(5_000).then(() => 'blocked')])
        assert.equal(fast, 200, 'orgfast was served while orgslow\'s search was still running')
      } finally {
        release()
      }
      assert.equal((await slow).status, 200)
    } finally {
      await h.done()
    }
  })

  await check('M4 end to end through the module: a search of one organization is claimed only by that organization\'s extension, and a foreign result is a 404 that leaves the search waiting', async () => {
    const h = await harness('m4')
    try {
      const result: { value: string | null } = { value: null }
      const client = randomUUID()
      const pollAs = (organization: string, signal?: AbortSignal) => fetch(`${h.base}/v1/session/bridge/jobs`, { method: 'POST', headers: authed(organization, {}, EXTENSION_ORIGIN), body: JSON.stringify({ clientId: client, capabilities: [SITE] }), ...(signal ? { signal } : {}) }).then((r) => r.json()) as Promise<{ job: ExtensionJob | null }>
      const resultAs = (organization: string, jobId: string, body: unknown) => fetch(`${h.base}/v1/session/bridge/results?jobId=${jobId}`, { method: 'POST', headers: authed(organization, { 'x-gotry-client-id': client }, EXTENSION_ORIGIN), body: JSON.stringify(body) })
      // submit through a search request: the fake search is told to enqueue a real job and wait for it
      h.searchImpl = async () => {
        const bridge = h.searches[h.searches.length - 1].bridge
        const outcome = await bridge.submit({ kind: 'search', site: SITE, url: 'https://portal.dida.com/find' }, { timeoutMs: 8_000, extensionWaitMs: 30_000 })
        result.value = outcome.ok ? String(outcome.result.body) : outcome.reason
      }
      const requestDone = postSearch(h, ACME).then((r) => r.status)
      await until(() => jobRows(h.root).some((r) => r.organization === ACME && r.status === 'queued'), 'acme job queued')
      const abort = new AbortController()
      const rivalPoll = pollAs(RIVAL, abort.signal).then(() => 'received', () => 'aborted')
      assert.equal(await staysPending(rivalPoll, 200), true, 'rival\'s extension is not given acme\'s job')
      const got = await pollAs(ACME)
      assert.ok(got.job, 'acme\'s extension is')
      const foreign = await resultAs(RIVAL, got.job.jobId, { ok: true, kind: 'search', body: 'FORGED' })
      assert.equal(foreign.status, 404)
      assert.deepEqual(await foreign.json(), { ok: false, error: 'unknown-job' })
      assert.equal(result.value, null, 'the search is still waiting')
      assert.equal((await resultAs(ACME, got.job.jobId, { ok: true, kind: 'search', body: 'REAL' })).status, 200)
      assert.equal(await requestDone, 200)
      assert.equal(result.value, 'REAL')
      abort.abort()
      await rivalPoll
      const rows = jobRows(h.root)
      assert.deepEqual(rows.map((r) => [r.organization, r.status]), [[ACME, 'resolved']], 'no row exists for rival')
    } finally {
      await h.done()
    }
  })

  await check('M5 admission: a refusal is 429 + retry-after before any bridge work; releases run in finally; a throwing admission is 503; it is consulted only for requests that would reach the bridge', async () => {
    const h = await harness('m5', { admission: true })
    try {
      // refusal
      h.decide = () => ({ ok: false, retryAfterSeconds: 7.2, code: 'bridge_jobs_per_tenant' })
      const refused = await postSearch(h, ACME)
      assert.equal(refused.status, 429)
      assert.equal(refused.headers.get('retry-after'), '8')
      assert.deepEqual(await refused.json(), { ok: false, verdict: 'quota_exceeded', error: 'bridge_jobs_per_tenant' })
      assert.equal(h.searches.length, 0, 'the search never ran')
      assert.equal(jobRows(h.root).length, 0, 'no queue activity')
      const refusedLogin = await fetch(`${h.base}/v1/session/login/open`, { method: 'POST', headers: authed(ACME), body: JSON.stringify({ supplier: SITE }) })
      assert.equal(refusedLogin.status, 429)
      assert.equal(jobRows(h.root).length, 0, 'login/open queued nothing either')
      assert.equal(h.releases, 0, 'a refusal has nothing to release')
      // the retry-after floor and non-finite values
      h.decide = () => ({ ok: false, retryAfterSeconds: 0, code: 'floor' })
      assert.equal((await postSearch(h, ACME)).headers.get('retry-after'), '1')
      h.decide = () => ({ ok: false, retryAfterSeconds: Number.NaN, code: 'nan' })
      assert.equal((await postSearch(h, ACME)).headers.get('retry-after'), '1')

      // admitted: release runs once, also when the search throws
      h.admissions.length = 0
      h.decide = () => ({ ok: true, release: () => { h.releases += 1 } })
      assert.equal((await postSearch(h, ACME)).status, 200)
      assert.equal(h.releases, 1)
      h.searchImpl = async () => { throw new Error('boom') }
      assert.equal((await postSearch(h, ACME)).status, 500)
      assert.equal(h.releases, 2, 'released after a failing search too')
      h.searchImpl = async () => undefined
      assert.deepEqual(h.admissions.map((a) => a.organization), [ACME, ACME], 'admission receives the resolved organization')

      // a throwing admission never lets the request through
      h.decide = () => { throw new Error('quota store down') }
      const before = h.searches.length
      assert.equal((await postSearch(h, ACME)).status, 503)
      assert.equal(h.searches.length, before)

      // not consulted for invalid bodies, and not for a ledger cooldown that already says no
      h.admissions.length = 0
      h.decide = () => ({ ok: true })
      assert.equal((await postSearch(h, ACME, [])).status, 400)
      assert.equal((await postSearch(h, ACME, { supplier: 'unknown-supplier' })).status, 400)
      const writer = openBridgeLedgerStore(h.root)
      try {
        writer.applyCooldown(RIVAL, SITE)
      } finally {
        writer.close()
      }
      assert.equal((await postSearch(h, RIVAL)).status, 429)
      assert.deepEqual(h.admissions, [], 'nothing above would have reached the bridge, so the quota was not touched')
    } finally {
      await h.done()
    }
  })

  await check('M6 without the hooks the module is the single lane it always was: no resolver needed, rows land under local', async () => {
    const h = await harness('m6', { scoped: false })
    try {
      assert.equal((await postSearch(h, undefined)).status, 200)
      assert.equal((await postSearch(h, ACME)).status, 200, 'a header naming an organization is ignored when no resolver was configured')
      await h.searches[0].bridge.submit({ kind: 'cookie-names', site: SITE }, { timeoutMs: 200, extensionWaitMs: 0 })
      assert.deepEqual(jobRows(h.root).map((r) => r.organization), [LOCAL])
      const eventPost = await fetch(`${h.base}/v1/session/bridge/events`, { method: 'POST', headers: authed(ACME, {}, EXTENSION_ORIGIN), body: JSON.stringify({ clientId: randomUUID(), events: [{ kind: 'workspace', subject: 's', payload_json: '{}' }] }) })
      assert.equal(eventPost.status, 200)
      const reader = openBridgeLedgerStore(h.root)
      try {
        assert.equal(reader.listEvents(LOCAL).length, 1)
        assert.equal(reader.listEvents(ACME).length, 0, 'the header did not move the event into acme')
      } finally {
        reader.close()
      }
    } finally {
      await h.done()
    }
  })

  await check('M7 the in-process pacing gate of the real search is per organization: two organizations back to back are both served, one organization twice is paced', async () => {
    __resetRateLimiterForTest()
    const mod = startSessionSearchModule({
      apiKey: () => KEY,
      stateRoot: tmpRoot('m7'),
      verdictLog: () => undefined,
      callerOrganization: (req: IncomingMessage) => { const value = req.headers[ORG_HEADER]; return typeof value === 'string' ? value : null },
    })
    const handle: BackendServerHandle = await createBackendServer({ modules: [mod], port: 0 })
    const base = `http://127.0.0.1:${handle.port}`
    try {
      // the real search asks the organization's extension for login tickets; an extension with none ends it at once
      const search = async (organization: string): Promise<{ status: number; body: { verdict?: string; error?: string } }> => {
        const client = randomUUID()
        const request = fetch(`${base}/v1/session/search`, { method: 'POST', headers: authed(organization), body: JSON.stringify({ supplier: SITE }) })
        const polled = await fetch(`${base}/v1/session/bridge/jobs`, { method: 'POST', headers: authed(organization, {}, EXTENSION_ORIGIN), body: JSON.stringify({ clientId: client, capabilities: [SITE] }) }).then((r) => r.json()) as { job: ExtensionJob | null }
        assert.ok(polled.job, `${organization}'s extension was handed its job`)
        await fetch(`${base}/v1/session/bridge/results?jobId=${polled.job.jobId}`, { method: 'POST', headers: authed(organization, { 'x-gotry-client-id': client }, EXTENSION_ORIGIN), body: JSON.stringify({ ok: true, kind: 'cookie-names', names: [] }) })
        const response = await request
        return { status: response.status, body: await response.json() as { verdict?: string; error?: string } }
      }
      const a1 = await search(ACME)
      assert.deepEqual([a1.status, a1.body.verdict], [200, 'needs-login'], 'acme was served')
      const r1 = await search(RIVAL)
      assert.deepEqual([r1.status, r1.body.verdict], [200, 'needs-login'], `rival is not paced by acme's call (${r1.body.error ?? ''})`)
      const a2 = await fetch(`${base}/v1/session/search`, { method: 'POST', headers: authed(ACME), body: JSON.stringify({ supplier: SITE }) })
      assert.equal(a2.status, 429, 'acme twice in a row is still paced')
      assert.match(String(((await a2.json()) as { error?: string }).error), /last call \d+ms ago/)
    } finally {
      await closeBackend(handle, [mod])
      __resetRateLimiterForTest()
    }
  })

  await check('M8 an admission that returns something that is not a decision is a 503, like a throw: it never crashes the process and never lets the request through', async () => {
    const h = await harness('m8', { admission: true })
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      for (const malformed of [undefined, null, 'yes', 42, {}, { ok: 'true' }, { ok: 1 }]) {
        h.decide = () => malformed as unknown as SessionAdmissionDecision
        const before = h.searches.length
        // bounded: a handler that crashes would never answer, and that must read as a failed assertion, not a hang
        const response = await fetch(`${h.base}/v1/session/search`, { method: 'POST', headers: authed(ACME), body: JSON.stringify({ supplier: SITE }), signal: AbortSignal.timeout(3_000) })
        assert.equal(response.status, 503, `a decision of ${JSON.stringify(malformed)}`)
        assert.deepEqual(await response.json(), { ok: false, error: 'admission-unavailable' })
        assert.equal(h.searches.length, before, 'the search never ran')
      }
      // a refusal without a usable code still refuses, with a fixed one
      h.decide = () => ({ ok: false, retryAfterSeconds: 3 } as unknown as SessionAdmissionDecision)
      const refused = await postSearch(h, ACME)
      assert.equal(refused.status, 429)
      assert.deepEqual(await refused.json(), { ok: false, verdict: 'quota_exceeded', error: 'quota_exceeded' })
      assert.equal(jobRows(h.root).length, 0, 'none of it reached the bridge')
      await sleep(50)
      assert.deepEqual(rejections, [], 'no rejection escaped')
    } finally {
      process.off('unhandledRejection', onRejection)
      await h.done()
    }
  })

  await check('M9 the organization-scoped module refuses the cdp transport at construction (it would drive the host\'s own Chrome for any organization); the single lane keeps it', async () => {
    const previous = process.env.GOTRY_SESSION_TRANSPORT
    process.env.GOTRY_SESSION_TRANSPORT = 'cdp'
    try {
      assert.throws(() => startSessionSearchModule({ apiKey: () => KEY, callerOrganization: () => ACME }), /session_search_organization_requires_extension_transport/)
      const single = startSessionSearchModule({ apiKey: () => KEY })
      await single.close?.()
    } finally {
      if (previous === undefined) delete process.env.GOTRY_SESSION_TRANSPORT
      else process.env.GOTRY_SESSION_TRANSPORT = previous
    }
    const extension = startSessionSearchModule({ apiKey: () => KEY, callerOrganization: () => ACME })
    await extension.close?.()
  })

  /* ---------- S: schema scan ---------- */

  await check('S1 no bridge table can hold a cookie value, a credential or a session secret (threat S-9)', async () => {
    const f = await fixture('s1')
    try {
      const raw = new Database(bridgeLedgerDbPath(f.root), { readonly: true })
      try {
        const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>).map((t) => t.name).sort()
        assert.deepEqual(tables, ['bridge_clients', 'bridge_events', 'bridge_jobs', 'bridge_pacing'])
        const forbidden = /cookie|passw|secret|credential|bearer|api[_-]?key|token|session[_-]?(id|key)|^value$|^values$/i
        for (const table of tables) {
          for (const column of raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>) {
            assert.ok(!forbidden.test(column.name), `${table}.${column.name} must not exist: the bridge stores names and control state only`)
          }
        }
      } finally {
        raw.close()
      }
      // the cookie-names path stores the names the extension reported, and nothing shaped like a value
      const acme = await f.serve(ACME)
      await heartbeat(acme)
      const pending = f.queue.forOrganization(ACME).submit({ kind: 'cookie-names', site: SITE }, { timeoutMs: 5_000, extensionWaitMs: 30_000 })
      const client = randomUUID()
      const got = await poll(acme, { clientId: client, capabilities: [SITE] })
      await postResult(acme, got.job!.jobId, { ok: true, kind: 'cookie-names', names: ['dida_session_sig'] }, client)
      await pending
      const row = f.store.getJob(got.job!.jobId)!
      assert.deepEqual(JSON.parse(row.result_json!), { ok: true, kind: 'cookie-names', names: ['dida_session_sig'] })
      assert.deepEqual(JSON.parse(f.store.getClient(ACME, client)!.login_sites_json), [SITE])
    } finally {
      await f.done()
    }
  })

  /* ---------- D: default lane ---------- */

  await check('D1 the default organization is local: loopback handler and plain submit keep the single lane, and the loopback handler ignores a caller', async () => {
    const root = tmpRoot('d1')
    const store = openBridgeLedgerStore(root)
    const queue = createBridgeJobQueue({ store })
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      ;(queue.handleRequest as (req: IncomingMessage, res: ServerResponse, caller?: unknown) => void)(req, res, { organization: ACME })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    server.unref()
    const port = (server.address() as { port: number }).port
    try {
      assert.deepEqual(queue.stats(), queue.stats(LOCAL))
      const pending = queue.submit(searchJob(), { timeoutMs: 5_000, extensionWaitMs: 30_000 })
      const polled = await (await fetch(`http://127.0.0.1:${port}/jobs`, { method: 'POST', headers: headersFor(), body: JSON.stringify({ capabilities: [SITE] }) })).json() as { job: ExtensionJob | null }
      assert.ok(polled.job, 'the loopback poller got the local job even though a caller naming acme was passed')
      assert.equal(store.getJob(polled.job.jobId)?.organization, LOCAL)
      await fetch(`http://127.0.0.1:${port}/results/${polled.job.jobId}`, { method: 'POST', headers: headersFor(), body: JSON.stringify({ ok: true, kind: 'search', body: '{}' }) })
      assert.equal((await pending).ok, true)
      assert.equal(queue.extensionConnected(), true)
      assert.equal(queue.extensionConnected(LOCAL), true)
      assert.equal(queue.extensionConnected(ACME), false)
    } finally {
      server.closeAllConnections?.()
      server.close()
      await queue.close()
      store.close()
    }
  })

  for (const root of roots) rmSync(root, { recursive: true, force: true })
  assert.ok(roots.every((root) => !existsSync(root)), 'temporary state roots are cleaned up')
  console.log(`\n§95 bridge organization dimension: ${passed} checks green`)
}

main().catch((error) => {
  console.error('FAIL:', error)
  process.exit(1)
})
