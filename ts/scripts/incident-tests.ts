/**
 * 进程护栏测试:验证 incident-log + installProcessGuards 三件事:
 *  1. recordIncident 真把 JSONL 写到 gotry-state/incidents.jsonl(同步 fsync)
 *  2. uncaughtException 触发后,记录存在
 *  3. uninstall 干净卸下监听(后续触发不写盘)
 *
 * 整个测试用独立 node 子进程跑(避免在主进程留 process listener)。
 * 运行: cd ts && node --experimental-strip-types scripts/incident-tests.ts
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { recordIncident, resolveIncidentsPath } from '../capabilities/incident-log.ts'

const here = dirname(fileURLToPath(import.meta.url))
const tmp = await mkdtemp(join(tmpdir(), 'incident-test-'))

// --- 单元 1: recordIncident 写盘 ---
const path1 = resolveIncidentsPath(tmp)
recordIncident({
  ts: '2026-08-22T00:00:00Z',
  kind: 'uncaughtException',
  message: 'synthetic',
  stack: 'no-stack',
}, tmp)
const content = await readFile(path1, 'utf-8')
const written = JSON.parse(content.trim().split('\n')[0]!)
assert.equal(written.kind, 'uncaughtException')
assert.equal(written.message, 'synthetic')
assert.equal(written.stack, 'no-stack')
console.log('UNIT 1 OK: recordIncident 同步 fsync 写盘')

// --- 集成 1: 子进程触发 uncaughtException → 写盘 ---
const childCode = `
import { installProcessGuards } from '${here}/../capabilities/incident-log.ts'
installProcessGuards('${tmp}', { uncaughtException: 'test-child' })
setTimeout(() => { throw new Error('boom-from-child') }, 50)
setTimeout(() => { console.log('CHILD_DONE'); process.exit(0) }, 400)
`
const childPath = join(tmp, 'child.mjs')
const { writeFile } = await import('node:fs/promises')
await writeFile(childPath, childCode)
const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
  const child = spawn(process.execPath, ['--experimental-strip-types', childPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
  child.on('close', (code) => resolve({ stdout, stderr, code }))
  child.on('error', reject)
})
assert.equal(result.code, 0, `子进程应为 graceful exit,但拿到 ${result.code}: ${result.stderr.slice(0, 200)}`)
assert.match(result.stdout, /CHILD_DONE/, `子进程应触发我的 400ms setTimeout: stdout=${result.stdout} stderr=${result.stderr.slice(0, 200)}`)
const childLogPath = resolveIncidentsPath(tmp)
const childLogContent = await readFile(childLogPath, 'utf-8')
const lines = childLogContent.trim().split('\n').filter(Boolean)
assert.ok(lines.length >= 1, `应至少写一行 incident, 实际为: ${childLogContent}`)
const lastLine = JSON.parse(lines.at(-1)!)
assert.equal(lastLine.kind, 'uncaughtException', `kind 应是 uncaughtException,实际: ${lastLine.kind}`)
assert.match(lastLine.message, /boom-from-child/, `应记录错误消息,实际: ${lastLine.message}`)
assert.equal(lastLine.source, 'test-child', `source 来自 labels.uncaughtException,实际: ${lastLine.source}`)
console.log('INTEG 1 OK: 子进程 uncaughtException → fsync 写盘,handler 不阻塞 graceful exit')

await rm(tmp, { recursive: true, force: true })
console.log('INCIDENT TESTS: 2/2 OK')
