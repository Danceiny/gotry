/** Isolated Web setup regressions: real child verifier, official files, and Host-owned roots. */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const moduleUrl = new URL('../src/gotry-web-api.ts', import.meta.url).href
const api = await import(moduleUrl).catch(() => undefined)
assert.equal(typeof api?.createGotryWebHandlers, 'function', 'GoTry must expose authenticated Web configuration and artifact handlers')
const root = mkdtempSync(join(tmpdir(), 'gotry-web-api-'))
try {
  const home = join(root, 'home'), workspace = join(root, 'workspace'), outside = join(root, 'outside')
  for (const dir of [home, workspace, outside]) mkdirSync(dir)
  const verifier = join(root, 'verifier.cjs')
  writeFileSync(verifier, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.VERIFIER_CAPTURE, JSON.stringify({ candidate: process.env.FLYAI_API_KEY, debug: process.env.DEBUG_FLYAI_API_KEY }));
if (process.env.FLYAI_API_KEY === 'sk-bad-candidate') { process.stderr.write('HTTP 401 ' + process.env.FLYAI_API_KEY); process.exit(1); }
if (process.env.FLYAI_API_KEY === 'sk-pending-candidate') { setTimeout(() => process.stdout.write(JSON.stringify({data:{itemList:[]}})), 1000); }
else process.stdout.write(JSON.stringify({data:{itemList:[]}}));
`)
  chmodSync(verifier, 0o700)
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, GOTRY_FLYAI_CLI_BIN: verifier,
    VERIFIER_CAPTURE: join(root, 'capture.json'), GOTRY_FLYAI_VERIFY_TIMEOUT_MS: '5000' }
  const handlers = api!.createGotryWebHandlers({ homeDir: home, env, stateRoot: workspace,
    workspaceForSession: async (id: string) => id === 'known-session' ? workspace : undefined })
  const request = (action: string, key?: string, signal?: AbortSignal) => new Request('http://localhost/api/gotry/flyai', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...(key === undefined ? {} : { key }) }), signal,
  })
  const status = () => handlers.flyai(new Request('http://localhost/api/gotry/flyai')).then((r: Response) => r.json())
  assert.deepEqual(await status(), { ok: true, configured: false, verified: false, writable: true, source: 'none', endpoint: 'https://flyai.open.fliggy.com/mcp', endpointDebug: false })
  let response: Response = await handlers.flyai(request('save', 'sk-good-candidate-1234'))
  assert.equal(response.status, 200)
  let body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.verified, true)
  assert.equal(body.source, 'config')
  assert.ok(!JSON.stringify(body).includes('sk-good-candidate'))
  const config = join(home, '.flyai/config.json'), receipt = join(home, '.gotry/flyai-verification.json')
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).FLYAI_API_KEY, 'sk-good-candidate-1234')
  assert.equal(statSync(config).mode & 0o777, 0o600)
  const previous = readFileSync(config, 'utf8'), previousReceipt = readFileSync(receipt, 'utf8')
  response = await handlers.flyai(request('save', 'sk-bad-candidate'))
  body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.verdict, 'auth-error')
  assert.ok(!JSON.stringify(body).includes('sk-bad-candidate'))
  assert.equal(readFileSync(config, 'utf8'), previous)
  assert.equal(readFileSync(receipt, 'utf8'), previousReceipt)
  assert.equal((await status()).verified, true)
  const cancelled = new AbortController()
  const pending = handlers.flyai(request('save', 'sk-pending-candidate', cancelled.signal))
  setTimeout(() => cancelled.abort(), 100)
  assert.equal((await (await pending).json()).ok, false)
  assert.equal(readFileSync(config, 'utf8'), previous)
  env.FLYAI_API_KEY = 'sk-environment-key'
  assert.equal((await status()).writable, false)
  response = await handlers.flyai(request('save', 'sk-good-candidate-5678'))
  assert.equal(response.status, 409)
  assert.equal(readFileSync(config, 'utf8'), previous)
  delete env.FLYAI_API_KEY
  response = await handlers.flyai(request('save', 'x'.repeat(9000)))
  assert.equal(response.status, 413)
  assert.equal(readFileSync(config, 'utf8'), previous)
  const concurrent = handlers.flyai(request('save', 'sk-pending-candidate'))
  setTimeout(() => writeFileSync(config, JSON.stringify({ FLYAI_API_KEY: 'sk-external-change' })), 150)
  assert.equal((await concurrent).status, 409)
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).FLYAI_API_KEY, 'sk-external-change')
  response = await handlers.flyai(request('clear'))
  assert.equal((await response.json()).configured, false)
  assert.ok(!existsSync(receipt))

  writeFileSync(config, '{corrupt configuration', { mode: 0o600 })
  assert.equal((await handlers.flyai(request('save', 'sk-good-candidate-1234'))).status, 409)
  assert.equal(readFileSync(config, 'utf8'), '{corrupt configuration')
  writeFileSync(config, previous)
  // A receipt cannot be published when its parent is a file. A successful
  // candidate must not replace the previously usable key in this case.
  rmSync(join(home, '.gotry'), { recursive: true, force: true })
  writeFileSync(join(home, '.gotry'), 'receipt directory unavailable')
  assert.equal((await handlers.flyai(request('save', 'sk-good-candidate-5678'))).status, 409)
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).FLYAI_API_KEY, 'sk-good-candidate-1234')
  rmSync(join(home, '.gotry'))

  const queuedSave = handlers.flyai(request('save', 'sk-pending-candidate'))
  const queuedClear = handlers.flyai(request('clear'))
  const queuedSaved = await queuedSave
  assert.equal(queuedSaved.status, 200, await queuedSaved.text())
  assert.equal((await (await queuedClear).json()).configured, false)

  writeFileSync(join(workspace, 'trip-one.md'), '# A trip\n')
  writeFileSync(join(workspace, 'trip-two.html'), '<h1>Another trip</h1>')
  writeFileSync(join(outside, 'private-trip.md'), '# Outside\n')
  response = await handlers.artifacts(new Request('http://localhost/api/gotry/artifacts?sessionId=known-session&search=trip&limit=1'))
  body = await response.json()
  assert.equal(body.total, 2)
  assert.equal(body.artifacts.length, 1)
  assert.equal(body.nextOffset, 1)
  response = await handlers.artifacts(new Request('http://localhost/api/gotry/artifacts?sessionId=known-session&search=two'))
  assert.ok((await response.json()).artifacts[0].path.endsWith('trip-two.html'))
  response = await handlers.artifacts(new Request('http://localhost/api/gotry/artifacts?sessionId=unknown'))
  assert.equal(response.status, 404)
  response = await handlers.artifacts(new Request('http://localhost/api/gotry/artifacts?sessionId=known-session&cwd=' + encodeURIComponent(outside)))
  assert.equal(response.status, 400)
  const handoff = join(outside, 'gotry-state', 'turn-handoffs')
  mkdirSync(handoff, { recursive: true })
  writeFileSync(join(handoff, 'host-ticket.json'), JSON.stringify({ schema: 'gotry_turn_handoff.v1', id: 'host-ticket',
    status: 'settled', objective: 'Host-owned handoff', deliverableFile: 'host-ticket.deliverable.md' }))
  writeFileSync(join(handoff, 'host-ticket.deliverable.md'), '# Handoff delivery\n')
  env.GOTRY_TURN_HANDOFF_ROOT = outside
  response = await handlers.artifacts(new Request('http://localhost/api/gotry/artifacts?sessionId=known-session&search=Host-owned'))
  assert.equal((await response.json()).artifacts[0]?.id, 'host-ticket', 'Web must use the same configured Host handoff root as conversational listing')
  console.log('GoTry Web API: verified save, rollback, cancellation, override, bounds, conflict, clear and Session-owned artifact search PASS')
} finally { rmSync(root, { recursive: true, force: true }) }
