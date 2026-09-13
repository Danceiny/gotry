import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { ManagedDshRunPort } from '../src/booking-surface/managed-dsh-run-port.ts'

const workerPath = fileURLToPath(new URL('./fixtures/managed-dsh-worker-fixture.mjs', import.meta.url))
const port = new ManagedDshRunPort({ workerPath, graceMs: 50 })
const result = await port.run('fixture', { sessionId: 'managed-dsh-proof' })
const pid = (result.events[0] as { grandchildPid: number }).grandchildPid
assert.ok(Number.isInteger(pid) && pid > 0, 'fixture reports its grandchild pid')
const started = Date.now()
await port.close()
assert.ok(Date.now() - started < 2_000, 'tree teardown is bounded')

const deadline = Date.now() + 1_000
let alive = true
while (alive && Date.now() < deadline) {
  try { process.kill(pid, 0) } catch { alive = false }
  if (alive) await new Promise((resolve) => setTimeout(resolve, 25))
}
assert.equal(alive, false, `TERM-resistant grandchild ${pid} must be reaped with its worker tree`)
assert.ok(existsSync(join(process.cwd(), 'node_modules/@deepseek-ai/dsh-subprocess-local')), 'proof uses installed dsh subprocess-local runtime')
console.log('MANAGED DSH RUN PORT TREE PROOF: bounded close reaps TERM-resistant grandchild')
