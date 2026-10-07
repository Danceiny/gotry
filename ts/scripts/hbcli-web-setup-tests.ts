/** Native HotelByte configuration: isolated official credential format and a fixture CLI. */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGotryWebHandlers } from '../src/gotry-web-api.ts'

const root = mkdtempSync(join(tmpdir(), 'gotry-hbcli-web-'))
try {
  const home = join(root, 'home'), cli = join(root, 'hbcli-fixture')
  mkdirSync(home)
  writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const credentials = JSON.parse(fs.readFileSync(path.join(process.env.STAICLI_HOME, 'credentials.json')));
const candidate = credentials['openapi:uat'];
fs.writeFileSync(process.env.HBCLI_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), root: process.env.STAICLI_HOME }));
const reply = () => {
  if (candidate.appKey === 'hbk-invalid') { process.stderr.write(candidate.appSecret); process.stdout.write(JSON.stringify({code:401,msg:candidate.appSecret})); }
  else if (candidate.appKey === 'hbk-no-suppliers') process.stdout.write(JSON.stringify({code:300010002,msg:'no available suppliers configured'}));
  else if (candidate.appKey === 'hbk-malformed') process.stdout.write('{}');
  else process.stdout.write(JSON.stringify({list:[{id:123,name:{zh:'Fixture Hotel'},minPrice:{amount:680,currency:'CNY'}}]}));
};
if (candidate.appKey === 'hbk-pending') setTimeout(reply, 800); else reply();
`, { mode: 0o700 })
  const env = { PATH: process.env.PATH, HOME: home, GOTRY_HBCLI_BIN: cli, HBCLI_CAPTURE: join(root, 'capture.json') }
  const handlers = createGotryWebHandlers({ homeDir: home, env, stateRoot: root, workspaceForSession: async () => root }) as ReturnType<typeof createGotryWebHandlers> & { hbcli: (r: Request) => Promise<Response> }
  assert.equal(typeof handlers.hbcli, 'function', 'the native configuration page needs an hbcli handler')
  const request = (action: string, appKey?: string, signal?: AbortSignal) => new Request('http://localhost/api/gotry/hbcli/write', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...(appKey ? { appKey, appSecret: 'hbs-fixture-secret' } : {}) }), signal,
  })
  const status = () => handlers.hbcli(new Request('http://localhost/api/gotry/hbcli')).then(r => r.json())
  assert.equal((await status()).configured, false)
  assert.equal(existsSync(env.HBCLI_CAPTURE), false, 'status must not invoke the CLI or contact a supplier')
  const dir = join(home, '.staicli'), file = join(dir, 'credentials.json')
  mkdirSync(dir, { mode: 0o755 })
  writeFileSync(file, JSON.stringify({ 'portal:uat': { ticket: 'preserve-other-mode' }, 'openapi:prod': { appKey: 'preserve-prod' } }), { mode: 0o600 })
  let response = await handlers.hbcli(request('save', 'hbk-valid'))
  assert.equal(response.status, 200)
  let body = await response.json()
  assert.equal(body.configured, true)
  assert.equal(body.verified, true)
  assert.equal(body.verdict, 'hit')
  assert.doesNotMatch(JSON.stringify(body), /hbk-valid|hbs-fixture-secret|preserve-other-mode/)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(saved['openapi:uat'], { appKey: 'hbk-valid', appSecret: 'hbs-fixture-secret' })
  assert.equal(saved['portal:uat'].ticket, 'preserve-other-mode')
  assert.equal(saved['openapi:prod'].appKey, 'preserve-prod')
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const capture = JSON.parse(readFileSync(env.HBCLI_CAPTURE, 'utf8'))
  assert.notEqual(capture.root, dir, 'verification must use a temporary credential root')
  assert.ok(capture.argv.includes('hotel-list'))
  assert.doesNotMatch(JSON.stringify(capture.argv), /hbk-valid|hbs-fixture-secret/, 'secrets must never be passed in argv')
  const previous = readFileSync(file, 'utf8')
  for (const key of ['hbk-invalid', 'hbk-malformed']) {
    response = await handlers.hbcli(request('save', key))
    assert.equal(response.status, 422)
    assert.doesNotMatch(await response.text(), /hbs-fixture-secret/)
    assert.equal(readFileSync(file, 'utf8'), previous)
  }
  const lockedEnv = { ...env, HOTELBYTE_TOKEN: 'fixture-launch-token' }
  const locked = createGotryWebHandlers({ homeDir: home, env: lockedEnv, stateRoot: root, workspaceForSession: async () => root })
  assert.equal((await (await locked.hbcli(new Request('http://localhost/api/gotry/hbcli'))).json()).writable, false)
  assert.equal((await locked.hbcli(request('save', 'hbk-valid'))).status, 409)
  assert.equal(readFileSync(file, 'utf8'), previous)
  const cancelled = new AbortController()
  const pending = handlers.hbcli(request('save', 'hbk-pending', cancelled.signal))
  setTimeout(() => cancelled.abort(), 100)
  assert.equal((await pending).status, 422)
  assert.equal(readFileSync(file, 'utf8'), previous)
  const concurrent = handlers.hbcli(request('save', 'hbk-pending'))
  setTimeout(() => writeFileSync(file, previous + '\n'), 150)
  assert.equal((await concurrent).status, 409)
  writeFileSync(file, previous)
  const receiptDir = join(home, '.gotry'), receiptBackup = readFileSync(join(receiptDir, 'hbcli-verification.json'), 'utf8')
  rmSync(receiptDir, { recursive: true }); writeFileSync(receiptDir, 'receipt storage unavailable')
  assert.equal((await handlers.hbcli(request('save', 'hbk-other-valid'))).status, 409)
  assert.equal(readFileSync(file, 'utf8'), previous, 'failed receipt storage must restore the previous credential data')
  rmSync(receiptDir); mkdirSync(receiptDir, { mode: 0o700 })
  writeFileSync(join(receiptDir, 'hbcli-verification.json'), receiptBackup, { mode: 0o600 })
  response = await handlers.hbcli(request('save', 'hbk-no-suppliers'))
  body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.configured, true)
  assert.equal(body.verified, false, 'no suppliers is not a successful inventory query')
  assert.equal(body.verdict, 'no-suppliers')
  assert.equal((await status()).verdict, 'no-suppliers')
  assert.equal((await handlers.hbcli(request('clear'))).status, 200)
  assert.equal((await status()).configured, false)
  const cleared = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(cleared['openapi:uat'], undefined)
  assert.equal(cleared['portal:uat'].ticket, 'preserve-other-mode')
  assert.equal(cleared['openapi:prod'].appKey, 'preserve-prod')
  writeFileSync(file, '{broken configuration')
  assert.equal((await handlers.hbcli(request('save', 'hbk-valid'))).status, 409)
  assert.equal(readFileSync(file, 'utf8'), '{broken configuration')
  rmSync(dir, { recursive: true })
  const outside = join(root, 'outside'); mkdirSync(outside)
  symlinkSync(outside, dir, 'dir')
  assert.equal((await handlers.hbcli(request('save', 'hbk-valid'))).status, 409)
  assert.equal(existsSync(join(outside, 'credentials.json')), false)
  rmSync(dir)
  response = await handlers.hbcli(new Request('http://localhost/api/gotry/hbcli/write', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', appKey: 'x'.repeat(9000), appSecret: 'fixture' }),
  }))
  assert.equal(response.status, 413)
  console.log('hbcli native Web setup: isolated verification, confidential responses, supplier status, cancellation, conflict, preservation, clear and file guards PASS')
} finally { rmSync(root, { recursive: true, force: true }) }
