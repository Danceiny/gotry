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
import { anythingSearch } from '../capabilities/anything.ts'

const root = mkdtempSync(join(tmpdir(), 'gotry-519-abort-'))
const ownedPids = new Set<number>()
let activeWork: Promise<unknown> | undefined
let activeAbort: AbortController | undefined

const waitForFile = async (path: string, label: string, boundMs = 5_000): Promise<void> => {
  let settled = false
  let outcome: unknown
  activeWork?.then(value => { settled = true; outcome = value }, error => { settled = true; outcome = String(error) })
  const deadline = Date.now() + boundMs
  while (!existsSync(path) && !settled && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10))
  }
  assert.ok(existsSync(path), `${label} ready handshake failed within ${boundMs}ms; settled=${settled}; outcome=${JSON.stringify(outcome)}`)
}

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

const waitForPidDead = async (pid: number, boundMs = 1_500): Promise<void> => {
  const deadline = Date.now() + boundMs
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10))
  }
  assert.equal(pidAlive(pid), false, `owned pid ${pid} survived cleanup bound`)
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

assert.equal(result.aborted, true, JSON.stringify(result))
assert.equal(result.timedOut, false)
assert.equal(result.groupReaped, true, JSON.stringify(result))
// 有界回收:TERM_GRACE(500)+ 观测窗,父忽略 SIGTERM 由 SIGKILL 兜底
assert.ok(recycleElapsed < 3_000, `abort bounded wait exceeded: ${recycleElapsed}ms`)
assert.equal(pidAlive(ids.parent), false, 'parent survived abort')
assert.equal(pidAlive(ids.child), false, 'descendant survived abort — kill of parent pid is not tree cleanup')

// 2a) 脱离进程组的自有子进程继续持有 stdout/stderr:close 不应无限等待。
//     child 设 20s 自退只用于让旧实现稳定红灯；finally 仍按已知 PID 立即清理并读回。
const escapedBin = join(root, 'escaped-child.js')
const escapedParentBin = join(root, 'escaped-parent.js')
const escapedPidsFile = join(root, 'escaped-pids.json')
const escapedReadyFile = join(root, 'escaped-ready')
writeFileSync(escapedBin, `setInterval(()=>{},1000);setTimeout(()=>process.exit(0),20000);\n`)
writeFileSync(escapedParentBin, `#!${process.execPath}
const {spawn}=require('node:child_process');const fs=require('node:fs');
const c=spawn(process.execPath,[${JSON.stringify(escapedBin)}],{detached:true,stdio:['ignore','inherit','inherit']});
c.unref();
fs.writeFileSync(${JSON.stringify(escapedPidsFile)},JSON.stringify({child:c.pid}));
fs.writeFileSync(${JSON.stringify(escapedReadyFile)},'ready');
process.on('SIGTERM',()=>process.exit(0));
setInterval(()=>{},1000);`, { mode: 0o700 })
const escapedAbort = new AbortController()
activeAbort = escapedAbort
// Startup has its own 5s readiness bound. Schedule abort 1s before the ordinary
// 10s timeout so both timers still overlap the 2.5s drain window, even on a cold host.
const escapedSpawnStarted = Date.now()
const escapedWork = spawnBounded(escapedParentBin, [], { env: process.env, timeoutMs: 10_000, signal: escapedAbort.signal })
activeWork = escapedWork
await waitForFile(escapedReadyFile, 'escaped process')
const escapedIds = JSON.parse(readFileSync(escapedPidsFile, 'utf8')) as { child: number }
ownedPids.add(escapedIds.child)
// Abort precedes the ordinary timeout; that later timer must not change the cause or extend cleanup.
await new Promise(r => setTimeout(r, Math.max(0, escapedSpawnStarted + 9_000 - Date.now())))
assert.ok(Date.now() - escapedSpawnStarted < 10_000, 'fixture must abort before the ordinary timeout')
const escapedStarted = Date.now()
escapedAbort.abort()
const escapedResult = await escapedWork
activeWork = undefined
activeAbort = undefined
const escapedElapsed = Date.now() - escapedStarted
assert.ok(escapedElapsed < 3_000, `escaped-pipe settlement exceeded bound: ${escapedElapsed}ms`)
assert.equal(escapedResult.aborted, true, JSON.stringify(escapedResult))
assert.equal(escapedResult.groupReaped, false, JSON.stringify(escapedResult))
assert.match(escapedResult.error ?? '', /cleanup incomplete/, JSON.stringify(escapedResult))
assert.equal(pidAlive(escapedIds.child), true, 'escaped child should remain for explicit finally cleanup')
try {
  process.kill(escapedIds.child, 'SIGKILL')
  await waitForPidDead(escapedIds.child)
} finally {
  ownedPids.delete(escapedIds.child)
}

// 2a-adapter) hbcli/Anything 必须把同一 cleanup 不完整状态透传到 error 面。
const adapterCleanupProbe = async (
  label: string,
  invoke: (signal: AbortSignal) => Promise<{ error?: string }>,
): Promise<void> => {
  rmSync(escapedPidsFile, { force: true })
  rmSync(escapedReadyFile, { force: true })
  const controller = new AbortController()
  activeAbort = controller
  const work = invoke(controller.signal)
  activeWork = work
  let pid: number | undefined
  try {
    await waitForFile(escapedReadyFile, `${label} escaped process`)
    pid = (JSON.parse(readFileSync(escapedPidsFile, 'utf8')) as { child: number }).child
    ownedPids.add(pid)
    controller.abort()
    const result = await work
    activeWork = undefined
    activeAbort = undefined
    assert.match(result.error ?? '', /process group cleanup incomplete/, `${label} hid cleanup failure`)
  } finally {
    controller.abort()
    if (pid !== undefined) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
      await waitForPidDead(pid)
      ownedPids.delete(pid)
    }
  }
}
await adapterCleanupProbe('hbcli', signal => callHbcliJson([], { hbcliBin: escapedParentBin, timeoutMs: 10_000, signal }))
await adapterCleanupProbe('anything', signal => anythingSearch({ keyword: 'x', hbcliBin: escapedParentBin, timeoutMs: 10_000, signal }))

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

console.log(`SPAWN BOUNDED ABORT TESTS: 8/8 OK(pre-abort 零 spawn/取消不静态降级/abort 有界杀真父子树/escaped-pipe settlement/adapter cleanup error/abort 不换候选/timeout SIGKILL 树/语义区分)`)
} finally {
  activeAbort?.abort()
  if (activeWork) await activeWork
  cleanupOwnedProcesses()
  rmSync(root, { recursive: true, force: true })
}
