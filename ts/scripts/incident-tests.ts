/**
 * D-NEW / #271 Phase A 事故观察器测试。
 *
 * 覆盖真实 native ESM dist 产物的 uncaughtExceptionMonitor：有观察器时
 * fatal 事故留下 JSONL、仍按宿主语义非零退出；无观察器时只有 Node 原生
 * 非零退出。另覆盖同一 fd 的 fsync/close、写入失败返回值、监听器卸载和
 * guardToolExecute 结构化业务失败。
 *
 * 运行: cd ts && npx tsx scripts/incident-tests.ts
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { guardToolExecute, installProcessGuards, recordIncident, resolveIncidentsPath } from '../capabilities/incident-log.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../..')
const distModule = join(repoRoot, 'dist/capabilities/incident-log.js')
const tmp = await mkdtemp(join(tmpdir(), 'incident-test-'))
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  return env
}

type ChildResult = { stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }
async function runChild(code: string, stateRoot: string): Promise<ChildResult> {
  const childPath = join(stateRoot, 'child.mjs')
  await writeFile(childPath, code)
  return await new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(process.execPath, [childPath], { cwd: repoRoot, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`child timeout: ${stderr.slice(0, 400)}`))
    }, 3000)
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (codeValue, signal) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: codeValue, signal })
    })
  })
}

try {
  assert.ok(fs.existsSync(distModule), `build-dist output missing: ${distModule}`)

  // Unit 1: the writer uses one fd, calls real fsync, and reports boolean success.
  {
    let fsyncCalls = 0
    const originalFsync = fs.fsyncSync
    fs.fsyncSync = ((fd: number) => { fsyncCalls += 1; return originalFsync(fd) }) as typeof fs.fsyncSync
    syncBuiltinESMExports()
    try {
      const ok = recordIncident({ ts: '2026-09-09T00:00:00Z', kind: 'uncaughtException', message: 'synthetic', stack: 'no-stack' }, tmp)
      assert.equal(ok, true)
      assert.equal(fsyncCalls, 1)
      const content = await readFile(resolveIncidentsPath(tmp), 'utf8')
      const written = JSON.parse(content.trim().split('\n')[0]!)
      assert.equal(written.kind, 'uncaughtException')
      assert.equal(written.message, 'synthetic')
      assert.equal(written.stack, 'no-stack')
    } finally {
      fs.fsyncSync = originalFsync
      syncBuiltinESMExports()
    }
  }
  console.log('UNIT 1 OK: recordIncident 同一 fd 真实 fsync + boolean success')

  // Unit 2: a failing fsync is contained, returns false, and closes the fd.
  {
    let closeCalls = 0
    const originalFsync = fs.fsyncSync
    const originalClose = fs.closeSync
    fs.fsyncSync = (() => { throw new Error('synthetic fsync failure') }) as typeof fs.fsyncSync
    fs.closeSync = ((fd: number) => { closeCalls += 1; return originalClose(fd) }) as typeof fs.closeSync
    syncBuiltinESMExports()
    try {
      let result = true
      assert.doesNotThrow(() => { result = recordIncident({ ts: '2026-09-09T00:00:01Z', kind: 'plugin_error', message: 'fsync-failure' }, tmp) })
      assert.equal(result, false)
      assert.equal(closeCalls, 1)
    } finally {
      fs.fsyncSync = originalFsync
      fs.closeSync = originalClose
      syncBuiltinESMExports()
    }
    closeCalls = 0
    const originalClose2 = fs.closeSync
    fs.closeSync = ((fd: number) => { closeCalls += 1; originalClose2(fd); throw new Error('synthetic close report') }) as typeof fs.closeSync
    syncBuiltinESMExports()
    try {
      assert.equal(recordIncident({ ts: '2026-09-09T00:00:02Z', kind: 'plugin_error', message: 'close-failure' }, tmp), false)
      assert.equal(closeCalls, 1)
    } finally {
      fs.closeSync = originalClose2
      syncBuiltinESMExports()
    }
  }
  console.log('UNIT 2 OK: fsync failure returns false, closes fd, does not throw')

  // Unit 3: install/dispose changes only the monitor listener and never leaks it.
  {
    const before = process.listenerCount('uncaughtExceptionMonitor')
    const dispose = installProcessGuards(tmp, { uncaughtException: 'unit', unhandledRejection: 'unit' })
    assert.equal(process.listenerCount('uncaughtExceptionMonitor'), before + 1)
    const duplicateDispose = installProcessGuards(tmp)
    duplicateDispose()
    assert.equal(process.listenerCount('uncaughtExceptionMonitor'), before + 1)
    dispose()
    assert.equal(process.listenerCount('uncaughtExceptionMonitor'), before)
    const disposeB = installProcessGuards(tmp)
    dispose()
    assert.equal(process.listenerCount('uncaughtExceptionMonitor'), before + 1)
    disposeB()
    assert.equal(process.listenerCount('uncaughtExceptionMonitor'), before)
  }
  console.log('UNIT 3 OK: monitor install/dispose 无监听泄漏')

  // Integration 0: the packaged native ESM writer returns true and invokes real fsync.
  {
    const stateRoot = join(tmp, 'dist-writer')
    await fs.promises.mkdir(stateRoot, { recursive: true })
    const result = await runChild(`
      import fs from 'node:fs'
      import { syncBuiltinESMExports } from 'node:module'
      import { recordIncident, resolveIncidentsPath } from ${JSON.stringify(distModule)}
      const originalFsync = fs.fsyncSync
      let fsyncCalls = 0
      fs.fsyncSync = ((fd) => { fsyncCalls += 1; return originalFsync(fd) })
      syncBuiltinESMExports()
      const ok = recordIncident({ ts: '2026-09-09T00:00:03Z', kind: 'plugin_error', message: 'native-dist-writer' }, ${JSON.stringify(stateRoot)})
      if (!ok || fsyncCalls !== 1 || !fs.existsSync(resolveIncidentsPath(${JSON.stringify(stateRoot)}))) process.exit(42)
    `, stateRoot)
    assert.equal(result.code, 0, `native dist writer assertion failed: ${result.stderr}`)
    const line = JSON.parse((await readFile(resolveIncidentsPath(stateRoot), 'utf8')).trim())
    assert.equal(line.message, 'native-dist-writer')
  }
  console.log('INTEG 0 OK: native dist writer true + real fsync + JSONL')

  // Integration 0b: direct dist entrypoint smoke is fatal; importing it with
  // argv2=--smoke does not trigger the CLI branch.
  {
    const directRoot = join(tmp, 'direct-smoke')
    const importedRoot = join(tmp, 'imported-smoke')
    const importedMarker = join(importedRoot, 'continued.marker')
    await fs.promises.mkdir(directRoot, { recursive: true })
    await fs.promises.mkdir(importedRoot, { recursive: true })
    const direct = await new Promise<ChildResult>((resolve, reject) => {
      const child = spawn(process.execPath, [distModule, '--smoke', directRoot], { cwd: repoRoot, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('direct smoke timeout')) }, 3000)
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ stdout, stderr, code, signal }) })
    })
    assert.equal(direct.code, 1, `direct dist smoke should exit 1: ${direct.stderr}`)
    const directIncident = JSON.parse((await readFile(resolveIncidentsPath(directRoot), 'utf8')).trim())
    assert.equal(directIncident.message, 'intentional smoke-uncaught')
    const imported = await runChild(`
      import { writeFileSync } from 'node:fs'
      process.argv.push('--smoke', ${JSON.stringify(importedRoot)})
      await import(${JSON.stringify(distModule)})
      setTimeout(() => writeFileSync(${JSON.stringify(importedMarker)}, 'continued'), 50)
    `, importedRoot)
    assert.equal(imported.code, 0, `imported module must not trigger smoke: ${imported.stderr}`)
    assert.equal(fs.existsSync(importedMarker), true)
    assert.equal(fs.existsSync(resolveIncidentsPath(importedRoot)), false)
  }
  console.log('INTEG 0b OK: direct smoke fatal; imported --smoke inert')

  // Integration 1-2: native dist, observer + fatal => durable log, exit 1, no marker.
  for (const [kind, trigger, expectedKind] of [
    ['uncaughtException', "setTimeout(() => { throw new Error('native-uncaught') }, 20)", 'uncaughtException'],
    ['unhandledRejection', "setTimeout(() => Promise.reject(new Error('native-rejection')), 20)", 'unhandledRejection'],
  ] as const) {
    const stateRoot = join(tmp, `guard-${kind}`)
    const marker = join(stateRoot, 'after-fatal.marker')
    await fs.promises.mkdir(stateRoot, { recursive: true })
    const result = await runChild(`
      import { installProcessGuards } from ${JSON.stringify(distModule)}
      import { writeFileSync } from 'node:fs'
      installProcessGuards(${JSON.stringify(stateRoot)}, { uncaughtException: 'native-test', unhandledRejection: 'native-test' })
      ${trigger}
      setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'after-fatal'), 100)
    `, stateRoot)
    assert.equal(result.code, 1, `${kind} should retain native nonzero exit: ${result.stderr}`)
    assert.equal(result.signal, null)
    assert.equal(fs.existsSync(marker), false)
    const lines = (await readFile(resolveIncidentsPath(stateRoot), 'utf8')).trim().split('\n').filter(Boolean)
    assert.equal(lines.length, 1)
    const incident = JSON.parse(lines[0]!)
    assert.equal(incident.kind, expectedKind)
    assert.match(incident.message, /native-(uncaught|rejection)/)
    assert.equal(incident.source, 'native-test')
  }
  console.log('INTEG 1-2 OK: native dist monitor records uncaught/rejection and preserves exit 1')

  // Integration 3-4: no monitor is the Node native comparison pair.
  for (const [kind, trigger] of [
    ['uncaughtException', "setTimeout(() => { throw new Error('plain-uncaught') }, 20)"],
    ['unhandledRejection', "setTimeout(() => Promise.reject(new Error('plain-rejection')), 20)"],
  ] as const) {
    const stateRoot = join(tmp, `plain-${kind}`)
    const marker = join(stateRoot, 'after-fatal.marker')
    await fs.promises.mkdir(stateRoot, { recursive: true })
    const result = await runChild(`import { writeFileSync } from 'node:fs'\n${trigger}\nsetTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'after-fatal'), 100)`, stateRoot)
    assert.equal(result.code, 1, `${kind} without monitor should retain native nonzero exit: ${result.stderr}`)
    assert.equal(result.signal, null)
    assert.equal(fs.existsSync(marker), false)
    assert.equal(fs.existsSync(resolveIncidentsPath(stateRoot)), false)
  }
  console.log('INTEG 3-4 OK: no-monitor native comparison exits 1 without incident log')

  // Integration 5: an existing host handler owns the exit code; the observer does not bypass it.
  {
    const stateRoot = join(tmp, 'host-handler')
    await fs.promises.mkdir(stateRoot, { recursive: true })
    const hostMarker = join(stateRoot, 'host-handler.marker')
    const result = await runChild(`
      import { installProcessGuards } from ${JSON.stringify(distModule)}
      import { writeFileSync } from 'node:fs'
      installProcessGuards(${JSON.stringify(stateRoot)})
      process.on('uncaughtException', (_error, origin) => {
        writeFileSync(${JSON.stringify(hostMarker)}, origin)
        process.exitCode = 23
      })
      setTimeout(() => { throw new Error('host-owned-fatal') }, 20)
      setTimeout(() => {}, 100)
    `, stateRoot)
    assert.equal(result.code, 23, `host handler exit code was bypassed: ${result.stderr}`)
    assert.equal(result.signal, null)
    assert.equal((await readFile(hostMarker, 'utf8')), 'uncaughtException')
    const incident = JSON.parse((await readFile(resolveIncidentsPath(stateRoot), 'utf8')).trim())
    assert.equal(incident.kind, 'uncaughtException')
  }
  console.log('INTEG 5 OK: host fatal handler retains exit policy')

  // Integration 6: a thrown non-Error with hostile message/stack accessors
  // cannot break the observer; the host receives the original object identity.
  {
    const stateRoot = join(tmp, 'host-non-error')
    const hostMarker = join(stateRoot, 'host-handler.marker')
    await fs.promises.mkdir(stateRoot, { recursive: true })
    const result = await runChild(`
      import { installProcessGuards } from ${JSON.stringify(distModule)}
      import { writeFileSync } from 'node:fs'
      installProcessGuards(${JSON.stringify(stateRoot)})
      const original = Object.create(null)
      Object.defineProperty(original, 'message', { enumerable: true, get() { throw new Error('message getter') } })
      Object.defineProperty(original, 'stack', { enumerable: true, get() { throw new Error('stack getter') } })
      process.on('uncaughtException', (_error, origin) => {
        writeFileSync(${JSON.stringify(hostMarker)}, _error === original ? origin : 'wrong-identity')
        process.exitCode = 23
      })
      setTimeout(() => { throw original }, 20)
      setTimeout(() => {}, 100)
    `, stateRoot)
    assert.equal(result.code, 23, `non-Error throw bypassed host handler: ${result.stderr}`)
    assert.equal(result.signal, null)
    assert.equal((await readFile(hostMarker, 'utf8')), 'uncaughtException')
    const incident = JSON.parse((await readFile(resolveIncidentsPath(stateRoot), 'utf8')).trim())
    assert.equal(incident.kind, 'uncaughtException')
    assert.equal(typeof incident.message, 'string')
  }
  console.log('INTEG 6 OK: non-Error throw safe formatting + original host identity/exit policy')

  // Unit 4: tool business errors remain structured and do not escape.
  {
    const asyncBoom = guardToolExecute<{ x?: number }, Record<string, unknown>>('synthetic-tool', tmp, async () => { throw new Error('boom-async') })
    const r1 = await asyncBoom({ x: 1 }, undefined)
    assert.equal(r1.ok, false)
    assert.ok(String(r1.summary).includes('synthetic-tool'))
    assert.ok(String(r1.evidence).includes('tool_execute_error'))
    const syncBoom = guardToolExecute<Record<string, never>, Record<string, unknown>>('synthetic-tool-sync', tmp, () => { throw new Error('boom-sync') })
    const r2 = await syncBoom({}, undefined)
    assert.equal(r2.ok, false)
    const nonErrorBoom = guardToolExecute<Record<string, never>, Record<string, unknown>>('synthetic-tool-nonerror', tmp, () => { throw Object.create(null) })
    const r3 = await nonErrorBoom({}, undefined)
    assert.equal(r3.ok, false)
    const toolErrs = (await readFile(resolveIncidentsPath(tmp), 'utf8')).trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { kind?: string }).filter((line) => line.kind === 'tool_execute_error')
    assert.equal(toolErrs.length, 3)
  }
  console.log('UNIT 4 OK: guardToolExecute 保持结构化业务失败')
} finally {
  await rm(tmp, { recursive: true, force: true })
}

console.log('INCIDENT TESTS: all focused checks OK')
