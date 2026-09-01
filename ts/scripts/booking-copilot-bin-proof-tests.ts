/** Production executable proof for the standalone Booking Copilot server. */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.equal(packageJson.bin?.['gotry-booking-copilot'], 'bin/gotry-booking-copilot.js')

const build = spawnSync(process.execPath, ['scripts/build-dist.mjs'], {
  cwd: root,
  encoding: 'utf8',
})
assert.equal(build.status, 0, build.stderr || build.stdout)

const bin = join(root, 'bin/gotry-booking-copilot.js')
const missingKey = spawnSync(process.execPath, [bin], {
  cwd: root,
  env: { PATH: process.env.PATH },
  encoding: 'utf8',
})
assert.equal(missingKey.status, 1)
assert.match(missingKey.stderr, /booking_copilot_api_key_required/)

const stateRoot = mkdtempSync(join(tmpdir(), 'gotry-booking-bin-'))
try {
  const child = spawn(process.execPath, [bin], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      GOTRY_BOOKING_COPILOT_API_KEY: 'fixture-bff-key',
      GOTRY_BOOKING_COPILOT_STATE_ROOT: stateRoot,
      GOTRY_BOOKING_COPILOT_HOST: '127.0.0.1',
      GOTRY_BOOKING_COPILOT_PORT: '0',
      DEEPSEEK_API_KEY: 'fixture-model-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })

  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`booking copilot bin did not listen: ${stderr}`)), 10_000)
    const inspect = () => {
      if (!stderr.includes('/a2a/booking-copilot/turn')) return
      clearTimeout(timeout)
      resolveReady()
    }
    child.stderr.on('data', inspect)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`booking copilot bin exited before listen: ${code}: ${stderr}`))
    })
  })
  assert.match(stderr, /listening on http:\/\/127\.0\.0\.1:\d+\/a2a\/booking-copilot\/turn/)
  assert.ok(!stderr.includes('fixture-bff-key'))
  assert.ok(!stderr.includes('fixture-model-key'))

  child.kill('SIGTERM')
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  assert.deepEqual(exit, { code: 0, signal: null }, `graceful shutdown failed: ${stderr}`)
} finally {
  rmSync(stateRoot, { recursive: true, force: true })
}

console.log('BOOKING COPILOT BIN PROOF: startup failure/listen/SIGTERM lifecycle OK')
