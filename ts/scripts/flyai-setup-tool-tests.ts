import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFlyaiSetupTool } from '../src/flyai-setup-tool.ts'

const root = mkdtempSync(join(tmpdir(), 'flyai-readonly-tool-'))
const original = { ...process.env }
let calls = 0
try {
  process.env.HOME = root
  delete process.env.FLYAI_API_KEY
  delete process.env.DEBUG_FLYAI_API_KEY
  delete process.env.DEBUG_FLYAI_MCP_URL
  mkdirSync(join(root, '.flyai'), { mode: 0o700 })
  const key = 'synthetic-only-secret-8192'
  const path = join(root, '.flyai/config.json')
  writeFileSync(path, JSON.stringify({ FLYAI_API_KEY: key, preserved: 'yes' }), { mode: 0o600 })
  const before = readFileSync(path)
  const tool = createFlyaiSetupTool(async fx => {
    calls++
    assert.equal(fx.effect, 'FLYAI_SEARCH')
    assert.ok(!JSON.stringify(fx).includes(key), 'Credential must not enter effect args')
    return { result: { verdict: 'miss' }, trace: { effect: fx.effect, channel: 'cli', attempts: 1, backoffMs: 0, breaker: 'off', evidence: [] } }
  }) as unknown as { execute(args: Record<string, unknown>, context: unknown): Promise<Record<string, unknown>>; presentCall(args: Record<string, unknown>): unknown }
  const status = await tool.execute({ action: 'status' }, {})
  assert.equal(status.configured, true)
  assert.equal(status.verified, false)
  assert.equal(calls, 0)
  const rejected = await tool.execute({ action: 'check', key }, {})
  assert.equal(rejected.ok, false)
  assert.equal(calls, 0)
  assert.ok(!(JSON.stringify(tool.presentCall({ action: 'save', key })) ?? '').includes(key))
  const checked = await tool.execute({ action: 'check' }, {})
  assert.equal(checked.verified, true)
  assert.equal(checked.receiptSaved, true)
  assert.deepEqual(readFileSync(path), before, 'Model check must not change credentials')
  const freshTool = createFlyaiSetupTool(async () => { throw Error('status must not call provider') }) as unknown as typeof tool
  assert.equal((await freshTool.execute({}, {})).verified, true)
  process.env.DEBUG_FLYAI_MCP_URL = 'https://private-user:private-pass@example.test/changed?secret=private-token'
  const mismatch = await freshTool.execute({}, {})
  assert.equal(mismatch.verified, false)
  for (const secret of [key, 'private-user', 'private-pass', 'private-token']) {
    assert.ok(!JSON.stringify([status, rejected, checked, mismatch]).includes(secret), 'No credentials in model output')
  }
  console.log('FlyAI model setup: read-only credential boundary, metadata persistence, endpoint binding and redaction OK')
} finally {
  process.env = original
  rmSync(root, { recursive: true, force: true })
}
