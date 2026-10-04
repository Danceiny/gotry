/**
 * Simulated-trigger drill and RE-BASELINE for the dormant dsh SDK descendant
 * cleanup tracker (issue #422, docs/architecture.md section 10; scoped #271
 * acceptance preserved).
 *
 * HONESTY CONTRACT — read before trusting any line of output:
 *   Every result below is `simulated_trigger_drill` / `synthetic`. Driving the
 *   SDK's direct transport against a FIXTURE `dshBin` is NOT a real product
 *   callsite, NOT a recorded architecture/founder decision on upstream
 *   ownership, and NOT a direct-connect activation. Issue #422's trigger is "a
 *   concrete proposal to put the dsh SDK direct-connect form into a product
 *   runtime, followed by the recorded decision"; this file supplies neither, so
 *   #422 stays open and nothing is activated, forked or upgraded here.
 *
 *   What the drill DOES supply is a re-baseline: the dsh family moved
 *   0.1.5-rc.1 -> 0.2.0-rc.2 on 2026-10-02, so the installed version's actual
 *   behaviour is measured and PINNED. Every pinned assertion carries an
 *   "if this flips, #422's premise changed" message.
 *
 * Sections:
 *   S1  static evidence: the installed SDK's spawn options and dispose ladder
 *   S2  SDK arm, unresponsive runtime: start -> real close() dispose ladder
 *       (shutdown timeout -> stdin EOF -> SIGTERM -> SIGKILL) -> who survives
 *   S3  SDK arm, cooperative runtime: the leader answers `shutdown` and exits
 *       on stdin EOF -> who survives
 *   S4  high-level arm: DeepSeekHarness.start()/close() over the same fixture
 *   S5  missing-binary semantics (an explicit #422 acceptance item)
 *   S6  no unsafe retry: close() is idempotent and terminal, start() after
 *       close is refused, and no second runtime process appears
 *   S7  CONTROL ARM: the GoTry CLI launcher's tested process-group cleanup
 *       (bin/gotry-process-liveness.js) over the SAME fixture leader
 *
 * Leak discipline: every pid this drill learns about is force-reaped in the
 * final `finally`, including on assertion failure, and the suite asserts at the
 * end that nothing it spawned is still alive.
 *
 * No vendor edits, no upstream proposals, no network, no model, no credentials.
 *
 * Run: cd ts && npx tsx scripts/drill-sdk-descendant-cleanup-tests.ts
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { HarnessClient, DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { spawnOwnedChild, signalOwnedChild, isOwnedProcessGroupEmpty, terminateOwnedChild } from '../../bin/gotry-process-liveness.js'

const DRILL_LABEL = 'simulated_trigger_drill'
const TS_DIR = resolve(import.meta.dirname, '..')
const REPO_ROOT = resolve(TS_DIR, '..')
const SUITE_BUDGET_MS = 90_000
const FLIP = 'IF THIS FLIPS, #422 premise changed'

const require_ = createRequire(import.meta.url)
const SDK_MANIFEST_PATH = require_.resolve('@deepseek-ai/dsh-sdk-client/package.json')
const SDK_VERSION = (require_(SDK_MANIFEST_PATH) as { version: string }).version
/**
 * Read the source from the SAME package the version came from. There are two
 * installed copies (`node_modules` and `ts/node_modules`); deriving the path
 * from the resolved manifest makes the version assertion and the static-source
 * assertions describe one package instead of two.
 */
const SDK_SOURCE_PATH = join(dirname(SDK_MANIFEST_PATH), 'lib', 'index.js')
const EXPECTED_SDK_VERSION = '0.2.0-rc.2'

let pass = 0
const failures: string[] = []
const observations: string[] = []
/** Every pid the drill ever learns about; all are force-reaped at the end. */
const trackedPids = new Set<number>()

function ok(condition: unknown, message: string): void {
  if (condition) { pass += 1; return }
  failures.push(message)
  console.error(`  FAIL - ${message}`)
}

function eq(actual: unknown, expected: unknown, message: string): void {
  ok(actual === expected, `${message} (actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)})`)
}

function observe(line: string): void {
  observations.push(line)
  console.log(`     observed: ${line}`)
}

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/** macOS-compatible process-table facts for a pid set (ps -o pid,ppid,pgid). */
function psFacts(pids: number[]): Array<{ pid: number; ppid: number; pgid: number }> {
  const live = pids.filter((p) => pidAlive(p))
  if (live.length === 0) return []
  try {
    const out = execFileSync('ps', ['-o', 'pid=,ppid=,pgid=', '-p', live.join(',')], { encoding: 'utf8' })
    return out.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
      const [pid, ppid, pgid] = line.split(/\s+/).map(Number)
      return { pid: pid as number, ppid: ppid as number, pgid: pgid as number }
    })
  } catch {
    return []
  }
}

/**
 * Is this pid still one of OUR processes? Guards the reap path against pid
 * reuse: a recorded pid can be recycled by the OS for an unrelated process
 * between the observation and the kill, and SIGKILLing that would be a real
 * side effect outside the drill's blast radius.
 *
 * Ownership evidence, either is enough: the command line still names one of
 * this drill's fixture files (they all live under the drill's own temp root),
 * or the parent chain reaches this drill process.
 */
function isDrillOwned(pid: number): boolean {
  try {
    const argv = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
    if (argv.includes('fixture-dsh-runtime') || argv.includes('fixture-descendant') || argv.includes('fixture-grandchild')) return true
  } catch {
    return false
  }
  // Walk the parent chain, bounded, looking for this process.
  let current = pid
  for (let hop = 0; hop < 8; hop += 1) {
    const facts = psFacts([current])
    const parent = facts[0]?.ppid
    if (parent === undefined || parent <= 1) return false
    if (parent === process.pid) return true
    current = parent
  }
  return false
}

/** SIGKILL one recorded pid, but only while it is still ours. */
function reapIfOwned(pid: number | null | undefined): void {
  if (!pid || !pidAlive(pid)) return
  if (!isDrillOwned(pid)) return
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(10)
  }
  return predicate()
}

function readPid(path: string): number | null {
  try { return Number(readFileSync(path, 'utf8').trim()) || null } catch { return null }
}

function trackIfAlive(...pids: Array<number | null>): void {
  for (const pid of pids) if (pid) trackedPids.add(pid)
}

// ---- fixtures ---------------------------------------------------------------

/**
 * The grandchild: ignores SIGTERM and lives on a timer. It is reachable only by
 * the process tree, never by the SDK's direct-child handle.
 */
const GRANDCHILD_FIXTURE = `
import { writeFileSync } from 'node:fs'
process.on('SIGTERM', () => {})
process.on('SIGINT', () => {})
writeFileSync(process.env.GRANDCHILD_PID_FILE, String(process.pid))
setInterval(() => {}, 60_000)
`

/** The TERM-ignoring descendant, which itself spawns the grandchild. */
const DESCENDANT_FIXTURE = `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
process.on('SIGTERM', () => {})
process.on('SIGINT', () => {})
spawn(process.execPath, [process.env.GRANDCHILD_FIXTURE], { stdio: 'ignore', env: process.env })
writeFileSync(process.env.DESCENDANT_PID_FILE, String(process.pid))
setInterval(() => {}, 60_000)
`

/**
 * The fixture dsh runtime (`dshBin`). It is what the SDK's direct transport
 * spawns and owns. It immediately creates a TERM-resistant descendant subtree,
 * so a direct-child-only teardown cannot pass by accident.
 *
 * MODE=unresponsive: never answers JSON-RPC and ignores SIGTERM, which forces
 *   the SDK ladder all the way to SIGKILL.
 * MODE=cooperative: answers `initialize` and `shutdown`, and exits 0 on stdin
 *   EOF, so the cooperative tier of the ladder is the one that runs.
 */
const LEADER_FIXTURE = `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const mode = process.env.LEADER_MODE
if (mode === 'unresponsive') {
  process.on('SIGTERM', () => {})
  process.on('SIGINT', () => {})
}

spawn(process.execPath, [process.env.DESCENDANT_FIXTURE], { stdio: 'ignore', env: process.env })
writeFileSync(process.env.LEADER_PID_FILE, String(process.pid))

if (mode === 'cooperative') {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) {
        let message
        try { message = JSON.parse(line) } catch { message = null }
        if (message && message.id !== undefined) {
          const result = message.method === 'initialize'
            ? { serverInfo: { name: 'gotry-drill-fixture-runtime', version: '0.0.0-drill' } }
            : {}
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
        }
      }
      index = buffer.indexOf('\\n')
    }
  })
  process.stdin.on('end', () => { process.exit(0) })
}

setInterval(() => {}, 60_000)
`

interface FixtureSet {
  leader: string
  descendantFixture: string
  grandchildFixture: string
  leaderPidFile: string
  descendantPidFile: string
  grandchildPidFile: string
  env: Record<string, string>
}

function writeFixtures(root: string, mode: 'unresponsive' | 'cooperative'): FixtureSet {
  mkdirSync(root, { recursive: true })
  const leader = join(root, 'fixture-dsh-runtime.mjs')
  const descendantFixture = join(root, 'fixture-descendant.mjs')
  const grandchildFixture = join(root, 'fixture-grandchild.mjs')
  const leaderPidFile = join(root, 'leader.pid')
  const descendantPidFile = join(root, 'descendant.pid')
  const grandchildPidFile = join(root, 'grandchild.pid')
  writeFileSync(leader, LEADER_FIXTURE)
  writeFileSync(descendantFixture, DESCENDANT_FIXTURE)
  writeFileSync(grandchildFixture, GRANDCHILD_FIXTURE)
  return {
    leader,
    descendantFixture,
    grandchildFixture,
    leaderPidFile,
    descendantPidFile,
    grandchildPidFile,
    env: {
      PATH: process.env.PATH ?? '',
      LEADER_MODE: mode,
      DESCENDANT_FIXTURE: descendantFixture,
      GRANDCHILD_FIXTURE: grandchildFixture,
      LEADER_PID_FILE: leaderPidFile,
      DESCENDANT_PID_FILE: descendantPidFile,
      GRANDCHILD_PID_FILE: grandchildPidFile,
    },
  }
}

interface TreeObservation {
  leader: number | null
  descendant: number | null
  grandchild: number | null
}

async function awaitTree(fixtures: FixtureSet, budgetMs = 8_000): Promise<TreeObservation> {
  await waitFor(() => readPid(fixtures.leaderPidFile) !== null && readPid(fixtures.descendantPidFile) !== null && readPid(fixtures.grandchildPidFile) !== null, budgetMs)
  const tree = {
    leader: readPid(fixtures.leaderPidFile),
    descendant: readPid(fixtures.descendantPidFile),
    grandchild: readPid(fixtures.grandchildPidFile),
  }
  trackIfAlive(tree.leader, tree.descendant, tree.grandchild)
  return tree
}

// Generous diagnostic backstop, not a performance assertion. `process.exit`
// skips `finally`, so the deadline path reaps the fixture tree itself —
// otherwise it would strand exactly the TERM-ignoring descendants this suite
// creates on purpose.
const suiteDeadline = setTimeout(() => {
  console.error(`DRILL BUDGET EXCEEDED (${SUITE_BUDGET_MS}ms) — reaping fixture tree before exit`)
  for (const pid of trackedPids) reapIfOwned(pid)
  try { rmSync(workRoot, { recursive: true, force: true }) } catch { /* best effort */ }
  process.exit(1)
}, SUITE_BUDGET_MS)
suiteDeadline.unref()

const workRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gotry-drill-422-')))

try {
  console.log(`-- S1 static evidence from the installed SDK [${DRILL_LABEL}]`)
  {
    eq(SDK_VERSION, EXPECTED_SDK_VERSION, `S1-1 the installed @deepseek-ai/dsh-sdk-client is the re-baseline target ${EXPECTED_SDK_VERSION}. ${FLIP}: a different version invalidates every pinned result below`)
    console.log(`     observed: S1 version and source both read from ${SDK_MANIFEST_PATH.replace(REPO_ROOT, '<repo>')}`)
    const sdkSource = readFileSync(SDK_SOURCE_PATH, 'utf8')
    const spawnBlock = sdkSource.slice(sdkSource.indexOf('const child = spawn(this.runtime.command'), sdkSource.indexOf('this.child = child;'))
    ok(spawnBlock.length > 0, 'S1-2 located the transport spawn call in the installed SDK')
    eq(/detached/.test(spawnBlock), false, `S1-3 PINNED: the SDK transport spawn passes no \`detached\` option, so the runtime is NOT a process-group leader. ${FLIP}`)
    eq(/setsid|process\.kill\(-/.test(sdkSource), false, `S1-4 PINNED: the SDK never signals a process group (no \`process.kill(-pid)\`, no setsid). ${FLIP}`)
    ok(/child\.kill\("SIGTERM"\)/.test(sdkSource) && /child\.kill\("SIGKILL"\)/.test(sdkSource), 'S1-5 the dispose ladder signals the DIRECT child only (SIGTERM then SIGKILL)')
    ok(sdkSource.includes('documented exception for SDK-managed transports'), 'S1-6 the SDK documents that it runs outside any harness context and spawns directly')
    observe(`S1 SDK ${SDK_VERSION}: direct spawn with stdio pipes, no detached, no process-group signalling; teardown ladder = stdin EOF -> SIGTERM -> SIGKILL on the direct child handle only`)
  }

  console.log('-- S2 SDK arm, unresponsive TERM-ignoring runtime: the real close() dispose path')
  {
    const root = join(workRoot, 'sdk-unresponsive')
    const fixtures = writeFixtures(root, 'unresponsive')
    const client = new HarnessClient({
      profile: 'sdk-minimal',
      dshBin: fixtures.leader,
      dshHome: join(root, 'dsh-home'),
      processCwd: root,
      env: fixtures.env,
      initializeTimeoutMs: 300,
      shutdownTimeoutMs: 200,
      disposeEofGraceMs: 300,
      disposeGraceMs: 400,
    })
    let tree: TreeObservation = { leader: null, descendant: null, grandchild: null }
    let closeMs = -1
    try {
      client.start()
      tree = await awaitTree(fixtures)
      ok(tree.leader !== null && tree.descendant !== null && tree.grandchild !== null, `S2-1 the fixture runtime really built a 3-deep tree (${JSON.stringify(tree)})`)
      eq(pidAlive(tree.descendant), true, 'S2-2 the TERM-ignoring descendant is alive before teardown')
      eq(pidAlive(tree.grandchild), true, 'S2-3 the grandchild is alive before teardown')
      const before = psFacts([tree.leader, tree.descendant, tree.grandchild].filter((p): p is number => p !== null))
      const leaderFact = before.find((f) => f.pid === tree.leader)
      const descendantFact = before.find((f) => f.pid === tree.descendant)
      ok(leaderFact !== undefined, 'S2-4 ps reported the leader')
      if (leaderFact && descendantFact) {
        eq(descendantFact.ppid, leaderFact.pid, 'S2-5 the descendant really is a child of the SDK-owned leader')
        eq(descendantFact.pgid, leaderFact.pgid, `S2-6 PINNED: leader and descendant share this process group (the SDK created no private group). ${FLIP}`)
        eq(leaderFact.pgid === process.pid || leaderFact.pgid !== leaderFact.pid, true, `S2-7 PINNED: the leader is not its own group leader. ${FLIP}`)
        observe(`S2 process table before teardown: ${JSON.stringify(before)} (drill pid ${process.pid}, pgid ${psFacts([process.pid])[0]?.pgid ?? 'unknown'})`)
      }

      const startedAt = Date.now()
      await client.close()
      closeMs = Date.now() - startedAt

      eq(await waitFor(() => !pidAlive(tree.leader), 2_000), true, 'S2-8 the SDK dispose ladder really reaped the direct child it owns')
      ok(closeMs < 4_000, `S2-9 close() is bounded: ${closeMs}ms against a runtime that ignores SIGTERM and answers nothing`)

      // THE #422 QUESTION, answered against 0.2.0-rc.2.
      const descendantSurvived = pidAlive(tree.descendant)
      const grandchildSurvived = pidAlive(tree.grandchild)
      eq(descendantSurvived, true, `S2-10 PINNED RE-BASELINE: on SDK ${SDK_VERSION} the TERM-ignoring DESCENDANT SURVIVES a full SDK dispose of its leader. ${FLIP} — if this reads false, descendant cleanup was fixed upstream and #422 can be closed with evidence`)
      eq(grandchildSurvived, true, `S2-11 PINNED RE-BASELINE: the GRANDCHILD also survives. ${FLIP}`)
      const after = psFacts([tree.descendant, tree.grandchild].filter((p): p is number => p !== null))
      observe(`S2 after SDK close() (${closeMs}ms): leader ${tree.leader} gone=${!pidAlive(tree.leader)}, descendant ${tree.descendant} alive=${descendantSurvived}, grandchild ${tree.grandchild} alive=${grandchildSurvived}; survivors reparented to ${JSON.stringify(after.map((f) => ({ pid: f.pid, ppid: f.ppid })))}`)
      observe(`S2 #422 GAP CONFIRMED on ${SDK_VERSION} (synthetic fixture, not a product callsite): the SDK-owned leader is reaped, its descendants are not. The CLI launcher's guarantee (S7) is NOT inherited by the direct transport.`)
    } finally {
      for (const pid of [tree.descendant, tree.grandchild]) {
        reapIfOwned(pid)
      }
      await client.close().catch(() => {})
    }
  }

  console.log('-- S3 SDK arm, cooperative runtime: shutdown answered, exit on stdin EOF')
  {
    const root = join(workRoot, 'sdk-cooperative')
    const fixtures = writeFixtures(root, 'cooperative')
    const client = new HarnessClient({
      profile: 'sdk-minimal',
      dshBin: fixtures.leader,
      dshHome: join(root, 'dsh-home'),
      processCwd: root,
      env: fixtures.env,
      initializeTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
      disposeEofGraceMs: 1_500,
      disposeGraceMs: 500,
    })
    let tree: TreeObservation = { leader: null, descendant: null, grandchild: null }
    try {
      client.start()
      const identity = await client.initialize({ cwd: root, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
      eq(identity.serverInfo.name, 'gotry-drill-fixture-runtime', 'S3-1 the cooperative fixture completed a real JSON-RPC initialize handshake')
      tree = await awaitTree(fixtures)
      ok(tree.descendant !== null && tree.grandchild !== null, `S3-2 the cooperative runtime also built the descendant subtree (${JSON.stringify(tree)})`)
      const startedAt = Date.now()
      await client.close()
      const closeMs = Date.now() - startedAt
      eq(await waitFor(() => !pidAlive(tree.leader), 2_000), true, 'S3-3 the cooperative leader exited on the shutdown/stdin-EOF tier')
      ok(closeMs < 2_500, `S3-4 the cooperative teardown is faster than the forced one: ${closeMs}ms`)
      eq(pidAlive(tree.descendant), true, `S3-5 PINNED: a COOPERATIVE clean exit also leaves the descendant running — the gap is ownership, not signal strength. ${FLIP}`)
      eq(pidAlive(tree.grandchild), true, `S3-6 PINNED: and the grandchild. ${FLIP}`)
      observe(`S3 cooperative teardown ${closeMs}ms: leader exited cleanly, descendant alive=${pidAlive(tree.descendant)}, grandchild alive=${pidAlive(tree.grandchild)}`)
    } finally {
      for (const pid of [tree.descendant, tree.grandchild]) {
        reapIfOwned(pid)
      }
      await client.close().catch(() => {})
    }
  }

  console.log('-- S4 high-level arm: DeepSeekHarness start()/close() over the same fixture')
  {
    const root = join(workRoot, 'sdk-harness')
    const fixtures = writeFixtures(root, 'cooperative')
    const harness = new DeepSeekHarness({
      profile: 'sdk-minimal',
      dshBin: fixtures.leader,
      dshHome: join(root, 'dsh-home'),
      cwd: root,
      processCwd: root,
      env: fixtures.env,
      initializeTimeoutMs: 2_000,
      shutdownTimeoutMs: 1_000,
      disposeEofGraceMs: 1_500,
      disposeGraceMs: 500,
    })
    let tree: TreeObservation = { leader: null, descendant: null, grandchild: null }
    try {
      await harness.start()
      tree = await awaitTree(fixtures)
      ok(tree.leader !== null, `S4-1 DeepSeekHarness.start() booted the fixture runtime (${JSON.stringify(tree)})`)
      await harness.close()
      eq(await waitFor(() => !pidAlive(tree.leader), 2_000), true, 'S4-2 DeepSeekHarness.close() reaped the direct child')
      eq(pidAlive(tree.descendant), true, `S4-3 PINNED: the high-level API inherits the same descendant gap as the low-level client. ${FLIP}`)
      observe(`S4 DeepSeekHarness: leader gone=${!pidAlive(tree.leader)}, descendant alive=${pidAlive(tree.descendant)} — the gap is in the transport, not in the API layer`)
    } finally {
      for (const pid of [tree.descendant, tree.grandchild]) {
        reapIfOwned(pid)
      }
      await harness.close().catch(() => {})
    }
  }

  console.log('-- S5 missing-binary semantics (explicit #422 acceptance item)')
  {
    const root = join(workRoot, 'sdk-missing-bin')
    mkdirSync(root, { recursive: true })
    const missing = join(root, 'does-not-exist-dsh-runtime.mjs')
    const client = new HarnessClient({
      profile: 'sdk-minimal',
      dshBin: missing,
      dshHome: join(root, 'dsh-home'),
      processCwd: root,
      env: { PATH: process.env.PATH ?? '' },
      initializeTimeoutMs: 1_000,
      shutdownTimeoutMs: 200,
      disposeEofGraceMs: 200,
      disposeGraceMs: 300,
    })
    let errorName = 'none'
    let errorMessage = ''
    const startedAt = Date.now()
    try {
      client.start()
      await client.initialize({ cwd: root, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    } catch (error) {
      errorName = error instanceof Error ? error.name : 'unknown'
      errorMessage = error instanceof Error ? error.message : String(error)
    }
    const failMs = Date.now() - startedAt
    await client.close()
    eq(errorName, 'TransportClosedError', `S5-1 PINNED: a missing dshBin surfaces as TransportClosedError, not a hang and not a silent success. ${FLIP}`)
    ok(failMs < 3_000, `S5-2 the missing-binary failure is bounded: ${failMs}ms`)
    // The precise semantics #422 asks to document: a missing binary is NOT an
    // ENOENT spawn error. Because `dshBin` is launched as `node <path>`, node
    // itself exits 1 and the SDK reports a transport closure; the real cause
    // survives only in the retained stderr tail.
    ok(/JSON-RPC input closed/.test(errorMessage), `S5-3 PINNED: the failure is reported as a transport closure, not as a spawn ENOENT. ${FLIP} (got: ${errorMessage.slice(0, 120)})`)
    ok(/exit code: 1/.test(errorMessage), `S5-4 the report carries the runtime exit code (got: ${errorMessage.slice(0, 160)})`)
    ok(/Cannot find module/.test(errorMessage), `S5-5 the real cause is recoverable ONLY from the retained stderr tail — a caller that logs just error.name loses it (got: ${errorMessage.slice(0, 200)})`)
    observe(`S5 missing dshBin: ${errorName} after ${failMs}ms, reported as "${errorMessage.split('\n')[0]?.slice(0, 120)}" with exit code 1; the actual "Cannot find module" cause appears only in the stderr tail, never in the error class — a direct-connect product callsite must retain the tail or it will mis-diagnose a packaging failure as a protocol failure`)
  }

  console.log('-- S6 no unsafe retry: close() is terminal and spawns nothing new')
  {
    const root = join(workRoot, 'sdk-no-retry')
    const fixtures = writeFixtures(root, 'cooperative')
    const client = new HarnessClient({
      profile: 'sdk-minimal',
      dshBin: fixtures.leader,
      dshHome: join(root, 'dsh-home'),
      processCwd: root,
      env: fixtures.env,
      initializeTimeoutMs: 2_000,
      shutdownTimeoutMs: 500,
      disposeEofGraceMs: 800,
      disposeGraceMs: 400,
    })
    let tree: TreeObservation = { leader: null, descendant: null, grandchild: null }
    try {
      client.start()
      tree = await awaitTree(fixtures)
      const firstLeader = tree.leader
      await client.close()
      await client.close()
      eq(pidAlive(firstLeader), false, 'S6-1 the first (and only) runtime is gone after close()')
      let reuseError = 'none'
      try { client.start() } catch (error) { reuseError = error instanceof Error ? error.name : 'unknown' }
      eq(reuseError, 'TransportClosedError', `S6-2 PINNED: start() after close() is refused — the SDK never silently respawns a runtime. ${FLIP}`)
      const leaderAfter = readPid(fixtures.leaderPidFile)
      eq(leaderAfter, firstLeader, 'S6-3 no second runtime process was ever launched (the pid file never changed)')
      observe(`S6 close() idempotent and terminal; reuse rejected with ${reuseError}; exactly one runtime pid (${firstLeader}) over the whole lifecycle`)
    } finally {
      for (const pid of [tree.descendant, tree.grandchild]) {
        reapIfOwned(pid)
      }
      await client.close().catch(() => {})
    }
  }

  console.log('-- S7 CONTROL ARM: the GoTry CLI launcher process-group cleanup, same fixture')
  {
    const root = join(workRoot, 'cli-control')
    const fixtures = writeFixtures(root, 'unresponsive')
    const { child, groupPid } = spawnOwnedChild(process.execPath, [fixtures.leader], {
      cwd: root,
      env: fixtures.env,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    let tree: TreeObservation = { leader: null, descendant: null, grandchild: null }
    try {
      tree = await awaitTree(fixtures)
      ok(tree.leader !== null && tree.descendant !== null && tree.grandchild !== null, `S7-1 the control arm built the same 3-deep tree (${JSON.stringify(tree)})`)
      const facts = psFacts([tree.leader, tree.descendant, tree.grandchild].filter((p): p is number => p !== null))
      const leaderFact = facts.find((f) => f.pid === tree.leader)
      if (leaderFact) {
        eq(leaderFact.pgid, leaderFact.pid, 'S7-2 the CLI launcher made the leader its OWN process-group leader (this is the difference from the SDK transport)')
        eq(facts.every((f) => f.pgid === leaderFact.pgid), true, `S7-3 the whole subtree shares that private group (${JSON.stringify(facts)})`)
      }
      eq(isOwnedProcessGroupEmpty(groupPid), false, 'S7-4 the group is observably non-empty before cleanup')
      const startedAt = Date.now()
      await terminateOwnedChild({ child, groupPid, signal: 'SIGTERM', termGraceMs: 1_200, killWaitMs: 800 })
      const cleanupMs = Date.now() - startedAt
      eq(await waitFor(() => !pidAlive(tree.leader) && !pidAlive(tree.descendant) && !pidAlive(tree.grandchild), 2_000), true, 'S7-5 CONTROL: bounded group cleanup reaped the leader AND the TERM-ignoring descendant AND the grandchild')
      eq(isOwnedProcessGroupEmpty(groupPid), true, 'S7-6 CONTROL: the private process group is observably empty')
      ok(cleanupMs < 4_000, `S7-7 CONTROL: cleanup is bounded: ${cleanupMs}ms`)
      observe(`S7 CONTROL ARM (bin/gotry-process-liveness.js): private group cleanup in ${cleanupMs}ms left zero survivors — the guarantee the SDK direct transport does not provide`)
    } finally {
      signalOwnedChild(child, 'SIGKILL', groupPid)
      for (const pid of [tree.leader, tree.descendant, tree.grandchild]) {
        reapIfOwned(pid)
      }
    }
  }
} finally {
  clearTimeout(suiteDeadline)
  // Leak discipline: reap every pid this drill ever learned about, twice,
  // regardless of which assertion failed.
  //
  // Identity guard against pid reuse: only signal a pid whose process is still
  // a descendant of this drill (its own pid, or a parent chain reaching this
  // process), or whose argv still names one of this drill's fixtures. A pid the
  // OS has since handed to an unrelated process must never be killed.
  for (const round of [0, 1]) {
    for (const pid of trackedPids) {
      if (!pidAlive(pid)) continue
      if (!isDrillOwned(pid)) {
        console.error(`     note: pid ${pid} is alive but no longer owned by this drill (pid reuse) — not signalling it`)
        continue
      }
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
    if (round === 0) await sleep(120)
  }
  rmSync(workRoot, { recursive: true, force: true })
}

{
  const survivors = [...trackedPids].filter((pid) => pidAlive(pid))
  eq(survivors.length, 0, `Z every process this drill spawned is reaped (survivors=${JSON.stringify(psFacts(survivors))})`)
  observe(`Z tracked ${trackedPids.size} fixture pids across all arms; ${survivors.length} survived the final reap`)
}

console.log(`\nDRILL #422 SDK DESCENDANT CLEANUP (${DRILL_LABEL}): ${pass} ok, ${failures.length} fail`)
console.log(`RE-BASELINE TARGET: @deepseek-ai/dsh-sdk-client ${SDK_VERSION}`)
console.log('OBSERVATIONS (facts, not acceptance):')
for (const line of observations) console.log(`  - ${line}`)
console.log('EVIDENCE BOUNDARY: a fixture dshBin and synthetic descendants only. No real product')
console.log('callsite, no recorded ownership decision, no direct-connect activation, no vendor edit.')
console.log('Issue #422 stays open; this drill documents behaviour and proposes nothing upstream.')
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILURE(S):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
