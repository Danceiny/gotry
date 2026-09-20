/**
 * spawn-bounded 取消/进程树回收 E2E(issue #519;真实进程,非 mock):
 *   1. pre-aborted signal → 零 spawn;
 *   2. 启动真父子(父忽略 SIGTERM、持续 spawn 孙)→ abort →
 *      父与孙均被杀,有界等待,结果语义 aborted;
 *   3. 超时 → SIGKILL 进程树;
 *   4. abort 不触发候选重试(直接 callHbcliJson 双候选场景验证)。
 * 全程临时目录 fixture,结束前 kill -0 复核并兜底清理同根 pid。
 * 运行: cd ts && npx tsx scripts/spawn-bounded-abort-tests.ts
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnBounded } from '../capabilities/spawn-bounded.ts'
import { callHbcliJson, searchHotels } from '../capabilities/hbcli.ts'

const root = mkdtempSync(join(tmpdir(), 'gotry-519-abort-'))
const ownedPids = new Set<number>()
let activeWork: Promise<unknown> | undefined
let activeAbort: AbortController | undefined

const waitForFile = async (path: string, label: string, boundMs = 5_000): Promise<void> => {
  const deadline = Date.now() + boundMs
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10))
  }
  assert.ok(existsSync(path), `${label} ready handshake exceeded ${boundMs}ms`)
}

const cleanupOwnedProcesses = (): void => {
  for (const pid of ownedPids) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
  }
}

try {

const marker = join(root, 'started')
const preabortBin = join(root, 'preabort.js')
writeFileSync(preabortBin, `#!${process.execPath}
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'started');console.log('{}');`, { mode: 0o700 })

// 1) pre-aborted:零 spawn
const pre = new AbortController()
pre.abort()
const preResult = await spawnBounded(preabortBin, [], { env: process.env, timeoutMs: 1000, signal: pre.signal })
assert.equal(preResult.aborted, true, JSON.stringify(preResult))
assert.equal(preResult.groupReaped, true)
assert.equal(existsSync(marker), false, 'pre-aborted signal must produce zero spawn')

// 经 callHbcliJson(带 fallback 候选语义)同样零 spawn、不触发候选
const preViaApi = await callHbcliJson([], { hbcliBin: preabortBin, timeoutMs: 1000, signal: pre.signal })
assert.equal(preViaApi.via, 'hbcli-error')
assert.equal(/abort/.test(preViaApi.error ?? ''), true, preViaApi.error)
assert.equal(existsSync(marker), false, 'callHbcliJson pre-aborted must not spawn either')
const preViaSearch = await searchHotels(
  { destination: '普吉岛' },
  { hbcliBin: preabortBin, fallbackPath: join(root, 'missing-fallback.json'), signal: pre.signal },
)
assert.match(preViaSearch.summary, /检索已取消/)
assert.doesNotMatch(preViaSearch.summary, /静态包/)

// 2) 真父子进程树:父捕获 SIGTERM 不退出、孙独立常驻
const childBin = join(root, 'descendant.js')
const parentBin = join(root, 'parent.js')
const pidsFile = join(root, 'pids.json')
const readyFile = join(root, 'ready')
writeFileSync(childBin, `setInterval(()=>{},1000)\n`)
writeFileSync(parentBin, `#!${process.execPath}
const {spawn}=require('node:child_process');const fs=require('node:fs');
process.on('SIGTERM',()=>{});
const c=spawn(process.execPath,[${JSON.stringify(childBin)}]);
fs.writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify({parent:process.pid,child:c.pid}));
fs.writeFileSync(${JSON.stringify(readyFile)},'ready');
setInterval(()=>{},1000);`, { mode: 0o700 })

const abort = new AbortController()
activeAbort = abort
const work = spawnBounded(parentBin, [], { env: process.env, timeoutMs: 10_000, signal: abort.signal })
activeWork = work
await waitForFile(readyFile, 'process tree')
const ids = JSON.parse(readFileSync(pidsFile, 'utf8')) as { parent: number; child: number }
ownedPids.add(ids.parent)
ownedPids.add(ids.child)
const abortStarted = Date.now()
abort.abort()
const result = await work
activeWork = undefined
activeAbort = undefined
const recycleElapsed = Date.now() - abortStarted

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
assert.equal(result.aborted, true, JSON.stringify(result))
assert.equal(result.timedOut, false)
assert.equal(result.groupReaped, true, JSON.stringify(result))
// 有界回收:TERM_GRACE(500)+ 观测窗,父忽略 SIGTERM 由 SIGKILL 兜底
assert.ok(recycleElapsed < 3_000, `abort bounded wait exceeded: ${recycleElapsed}ms`)
assert.equal(alive(ids.parent), false, 'parent survived abort')
assert.equal(alive(ids.child), false, 'descendant survived abort — kill of parent pid is not tree cleanup')

// 2b) abort 后不走已知安装位候选:首个缺失后启动 ~/.local/bin，第三候选永不执行
const home = join(root, 'fake-home')
const secondMarker = join(home, 'second-started')
const thirdMarker = join(home, 'third-started')
const localDir = join(home, '.local/bin')
const staicliDir = join(home, '.staicli/current')
const emptyPath = join(root, 'empty-path')
const { mkdirSync } = await import('node:fs')
mkdirSync(localDir, { recursive: true })
mkdirSync(staicliDir, { recursive: true })
mkdirSync(emptyPath, { recursive: true })
const candidateScript = (startedMarker: string): string => `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(startedMarker)},'started');
setInterval(()=>{},1000);`
writeFileSync(join(localDir, 'hbcli'), candidateScript(secondMarker), { mode: 0o700 })
writeFileSync(join(staicliDir, 'hbcli'), candidateScript(thirdMarker), { mode: 0o700 })
const savedHome = process.env.HOME
const savedPath = process.env.PATH
process.env.HOME = home
process.env.PATH = emptyPath
const candidateAbort = new AbortController()
const candidateWork = callHbcliJson([], { hbcliBin: 'hbcli', timeoutMs: 10_000, signal: candidateAbort.signal })
try {
  await waitForFile(secondMarker, 'candidate process')
  candidateAbort.abort()
  const candidateResult = await candidateWork
  assert.equal(candidateResult.error, 'aborted by host signal')
  assert.equal(existsSync(thirdMarker), false, 'abort must not continue to another candidate')
} finally {
  candidateAbort.abort()
  await candidateWork
  process.env.HOME = savedHome
  process.env.PATH = savedPath
}

// 3) 超时:SIGKILL 树,语义 timedOut
const slow = join(root, 'slow.js')
writeFileSync(slow, `#!${process.execPath}
const t=setInterval(()=>{},1000);`, { mode: 0o700 })
const timed = await spawnBounded(slow, [], { env: process.env, timeoutMs: 300 })
assert.equal(timed.timedOut, true, JSON.stringify(timed))
assert.equal(timed.aborted, false)
assert.equal(timed.groupReaped, true, JSON.stringify(timed))
assert.match(timed.error ?? '', /timeout/)

console.log(`SPAWN BOUNDED ABORT TESTS: 6/6 OK(pre-abort 零 spawn/取消不静态降级/abort 有界杀真父子树/abort 不换候选/timeout SIGKILL 树/语义区分)`)
} finally {
  activeAbort?.abort()
  if (activeWork) await activeWork
  cleanupOwnedProcesses()
  rmSync(root, { recursive: true, force: true })
}
