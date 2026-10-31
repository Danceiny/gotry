/**
 * The executor's host browser belongs to one organization (AaaS, docs/rfc/aaas-rfc.md §4.8; threat S-19).
 *
 * The booking executor's default observer drives the host machine's Chrome over CDP. That is one browser holding one
 * supplier login, so it is single-organization by construction: if a second organization's caller could reach it, that
 * caller would be acting on the first organization's login. The module therefore knows whose browser it is, resolves
 * the caller's organization (from the host, never from the request), and refuses any other organization before it
 * touches the browser. An observer that is injected instead is organization-aware and is told the caller's organization.
 *
 * Offline: the browser is a spy. Nothing here opens a real session.
 *
 *   E  the binding: matching and foreign organizations, forged bodies and headers, unresolved callers, order of checks,
 *      construction rules, the injected observer, the single-organization form unchanged
 *
 * Run: cd ts && npx tsx scripts/tenant-executor-binding-tests.ts
 */

import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'

import { closeBackend, createBackendServer } from '../src/backend/kernel.ts'
import { startBookingExecutorModule, type BookingExecutorModuleOptions, type BookingObserveRequest, type BookingObserveResult } from '../src/backend/modules/booking-executor.ts'

const KEY = 'test-booking-key'
const RESULT: BookingObserveResult = {
  ok: true,
  supplier: 'dida-portal',
  entryUrl: 'https://portal.dida.com/hotel/find',
  entryPoints: [{ text: '预订', tag: 'button' }],
  screenshotPath: '/tmp/evidence/test.png',
  observedAt: '2026-10-30T00:00:00.000Z',
}

let passed = 0
async function check(label: string, assertion: () => void | Promise<void>): Promise<void> {
  await assertion()
  passed += 1
  console.log(`  ok - ${label}`)
}

/** The host's authenticator, as a test double: credential header -> organization. The request body and every other header are never consulted. */
const ORGANIZATION_OF: Record<string, string | null | 'throw'> = {
  'cred-acme': 'acme',
  'cred-globex': 'globex',
  'cred-local': 'local',
  'cred-nobody': null,
  'cred-path': '../etc',
  'cred-upper': 'ACME',
  'cred-empty': '',
  'cred-throws': 'throw',
}

function callerOf(req: IncomingMessage): string | null {
  const resolved = ORGANIZATION_OF[String(req.headers['x-test-credential'] ?? '')]
  if (resolved === 'throw') throw new Error('authenticator down')
  return resolved ?? null
}

interface Harness {
  readonly base: string
  readonly browser: BookingObserveRequest[]
  readonly observed: BookingObserveRequest[]
  readonly consulted: IncomingMessage[]
  post(credential: string | null, body?: unknown, headers?: Record<string, string>, bearer?: string | null): Promise<{ status: number; body: Record<string, unknown> }>
  close(): Promise<void>
}

async function harness(options: Partial<BookingExecutorModuleOptions> & { multi?: boolean } = {}): Promise<Harness> {
  const browser: BookingObserveRequest[] = []
  const observed: BookingObserveRequest[] = []
  const consulted: IncomingMessage[] = []
  const { multi, ...rest } = options
  const module = startBookingExecutorModule({
    apiKey: () => KEY,
    evidenceDir: () => '/tmp/booking-executor-binding-evidence',
    hostBrowserObserve: async (request) => { browser.push(request); return RESULT },
    ...(multi ? { callerOrganization: (req: IncomingMessage) => { consulted.push(req); return callerOf(req) } } : {}),
    ...rest,
  })
  const handle = await createBackendServer({ modules: [module], port: 0 })
  const base = `http://127.0.0.1:${handle.port}`
  return {
    base,
    browser,
    observed,
    consulted,
    async post(credential, body = { supplier: 'dida-portal' }, headers = {}, bearer = KEY) {
      const response = await fetch(`${base}/v1/booking/observe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), ...(credential === null ? {} : { 'x-test-credential': credential }), ...headers },
        body: JSON.stringify(body),
      })
      let parsed: Record<string, unknown> = {}
      try { parsed = await response.json() as Record<string, unknown> } catch { /* an empty body */ }
      return { status: response.status, body: parsed }
    },
    close: () => closeBackend(handle, [module]).catch(() => undefined),
  }
}

const open: Harness[] = []
async function started(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = await harness(options)
  open.push(h)
  return h
}

console.log('E  the executor binding')

await check('E1 the single-organization form is unchanged: no hook, every caller is local, and the host browser is used', async () => {
  const h = await started()
  const reply = await h.post(null)
  assert.equal(reply.status, 200)
  assert.equal(reply.body.ok, true)
  assert.deepEqual(h.browser, [{ supplier: 'dida-portal', entryUrl: 'https://portal.dida.com/hotel/find' }], 'the request an observer receives keeps the shape it always had')
  assert.ok(!('organization' in h.browser[0]!))
  assert.deepEqual((await h.post(null, { supplier: 'dida-portal' }, { 'x-organization': 'globex' })).status, 200, 'with no hook a header changes nothing')
})

await check('E2 the host browser serves only the organization whose login it holds; any other is refused before the browser is touched', async () => {
  const h = await started({ multi: true, hostBrowserOrganization: 'acme' })
  const own = await h.post('cred-acme')
  assert.equal(own.status, 200)
  assert.equal(h.browser.length, 1)
  assert.equal(h.browser[0]!.organization, 'acme')
  for (const credential of ['cred-globex', 'cred-local']) {
    const refused = await h.post(credential)
    assert.equal(refused.status, 403, credential)
    assert.equal(refused.body.error, 'executor-organization-mismatch')
    assert.equal(refused.body.ok, false)
  }
  assert.equal(h.browser.length, 1, 'the browser was touched once, for its own organization')
})

await check('E3 a caller cannot choose its organization: a body, a header or a query that names another changes nothing', async () => {
  const h = await started({ multi: true, hostBrowserOrganization: 'acme' })
  const forgedBody = await h.post('cred-globex', { supplier: 'dida-portal', organization: 'acme', org: 'acme', tenant: 'acme' })
  assert.equal(forgedBody.status, 403)
  const forgedHeaders = await h.post('cred-globex', { supplier: 'dida-portal' }, { 'x-organization': 'acme', 'x-org': 'acme', 'x-tenant': 'acme', host: 'acme.example' })
  assert.equal(forgedHeaders.status, 403)
  const forgedQuery = await fetch(`${h.base}/v1/booking/observe?organization=acme`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'x-test-credential': 'cred-globex' }, body: '{"supplier":"dida-portal"}' })
  assert.equal(forgedQuery.status, 403)
  assert.equal(h.browser.length, 0)
  const own = await h.post('cred-acme', { supplier: 'dida-portal', organization: 'globex' })
  assert.equal(own.status, 200)
  assert.equal(h.browser[0]!.organization, 'acme', 'and a body that names another organization does not move the owner either')
})

await check('E4 a caller the host cannot place is refused as unresolved, and nothing is observed', async () => {
  const h = await started({ multi: true, hostBrowserOrganization: 'acme' })
  for (const credential of ['cred-nobody', 'cred-path', 'cred-upper', 'cred-empty', 'cred-throws', 'cred-unknown']) {
    const reply = await h.post(credential)
    assert.equal(reply.status, 403, credential)
    assert.equal(reply.body.error, 'organization-unresolved', credential)
  }
  assert.equal(h.browser.length, 0)
})

await check('E5 the bearer is checked first: a wrong or missing key never consults the host, and an unconfigured key still fails closed', async () => {
  const h = await started({ multi: true, hostBrowserOrganization: 'acme' })
  assert.equal((await h.post('cred-acme', undefined, {}, 'wrong-key')).status, 403)
  assert.equal((await h.post('cred-acme', undefined, {}, null)).status, 403)
  assert.equal(h.consulted.length, 0, 'the host was never asked who the caller is')
  const closed = await started({ multi: true, hostBrowserOrganization: 'acme', apiKey: () => '' })
  assert.equal((await closed.post('cred-acme')).status, 503)
  assert.equal(closed.consulted.length, 0)
})

await check('E6 a deployment that serves several organizations must say whose browser this is; a bad organization id is refused', async () => {
  const callerOrganization = () => 'acme'
  const base = { apiKey: () => KEY, evidenceDir: () => '/tmp/x' }
  assert.throws(() => startBookingExecutorModule({ ...base, callerOrganization }), /booking_executor_host_browser_organization_required/)
  assert.doesNotThrow(() => startBookingExecutorModule({ ...base, callerOrganization, hostBrowserOrganization: 'acme' }))
  assert.doesNotThrow(() => startBookingExecutorModule({ ...base, callerOrganization, observe: async () => RESULT }), 'an organization-aware observer needs no host browser')
  assert.doesNotThrow(() => startBookingExecutorModule(base), 'the single-organization form needs nothing')
  for (const bad of ['', '../x', 'ACME', 'a b', 'x'.repeat(64)]) {
    assert.throws(() => startBookingExecutorModule({ ...base, hostBrowserOrganization: bad }), /booking_executor_host_browser_organization_invalid/, JSON.stringify(bad))
  }
})

await check('E7 an injected observer is told the caller\'s organization on every request, and is not gated by the host browser\'s', async () => {
  const seen: BookingObserveRequest[] = []
  const h = await started({ multi: true, observe: async (request) => { seen.push(request); return RESULT } })
  assert.equal((await h.post('cred-acme', { supplier: 'dida-portal', organization: 'globex' })).status, 200)
  assert.equal((await h.post('cred-globex')).status, 200)
  assert.deepEqual(seen.map((request) => request.organization), ['acme', 'globex'])
  assert.equal(h.browser.length, 0, 'the host browser is not used when an observer is injected')
})

await check('E8 the default owner is local: with an explicit local owner only local callers pass, and request validation still comes first', async () => {
  const h = await started({ multi: true, hostBrowserOrganization: 'local' })
  assert.equal((await h.post('cred-local')).status, 200)
  assert.equal((await h.post('cred-acme')).status, 403)
  assert.equal((await h.post('cred-local', { supplier: 'ctrip-flight' })).status, 400)
  assert.equal((await h.post('cred-local', { supplier: 'dida-portal', entryUrl: 'https://evil.example.com/x' })).status, 400)
  assert.equal(h.browser.length, 1, 'only the valid request reached the browser')
})

for (const h of open) await h.close()
console.log(`tenant-executor-binding: ${passed} checks passed`)
process.exit(0)
