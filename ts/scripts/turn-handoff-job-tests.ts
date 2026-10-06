import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { writeTurnHandoffTicket, writeTicketJson, listTurnHandoffTickets } from '../src/turn-deadline.ts'
import { startTurnHandoffJob } from '../src/turn-handoff-job.ts'
import { pathToFileURL } from 'node:url'
import { listArtifacts, readArtifact } from '../capabilities/artifacts.ts'
import { apply } from '../src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'gotry-native-handoff-'))
const ctx = new Context()
const owner = { id: SessionId('owner'), ctx } as unknown as Agent
ctx.provide('agents', { get: (id: string) => id === 'owner' ? owner : undefined })
const jobs = new LocalJobRegistry(ctx, { maxConcurrentJobsPerOwner: 10 })
const subprocess = new LocalSubprocessRuntime(ctx)
const detach = jobs.attachController('test')
const planner = join(root, 'planner.mjs')
const descendants: number[] = []
writeFileSync(planner, `console.error('DIAGNOSTIC, NOT THE DELIVERABLE');console.log('# Finished plan\\nOriginal request: '+process.argv[2])`)
process.env.GOTRY_HANDOFF_PLANNER_BIN = planner
try {
  const ticket = await writeTurnHandoffTicket(root, '东北旅行', { workspaceCwd: root, ownerSessionId: owner.id })
  const running = await startTurnHandoffJob(ctx, ticket, owner, root)
  assert.equal(running.status, 'running')
  assert.ok(running.jobId)
  assert.equal(jobs.list(owner.id)[0].label.includes(ticket.id), true, 'native UI jobs carry the durable ticket identity')
  assert.deepEqual(jobs.list(SessionId('foreign')), [], 'another session cannot see the task')
  const jobId = JobId(running.jobId!)
  assert.equal((await jobs.wait(jobId, 10_000, owner.id)).status, 'completed')
  const views = await listTurnHandoffTickets(root)
  assert.equal(views[0].status, 'settled')
  assert.ok(views[0].deliverablePath)
  assert.match(jobs.read(jobId, owner.id).result ?? '', /present/, 'completion tells the owning session to present the output')
  const content = readFileSync(views[0].deliverablePath!, 'utf8')
  assert.ok(content.includes('# Finished plan'))
  assert.ok(!content.includes('DIAGNOSTIC'), 'stderr cannot be accepted as the plan')
  const artifacts = await listArtifacts({ stateRoot: root, cwd: root })
  assert.ok(artifacts.artifacts.some(item => item.id === ticket.id), 'handoff deliverable must be discoverable')
  assert.equal((await readArtifact({ stateRoot: root, cwd: root, path: ticket.id })).ok, true)
  const legacyRoot = join(root, 'legacy-root')
  mkdirSync(join(legacyRoot, 'gotry-state', 'async'), { recursive: true })
  writeFileSync(join(legacyRoot, 'gotry-state', 'async', 'legacy.deliverable.md'), 'Legacy plan')
  const mixed = await listArtifacts({ stateRoot: legacyRoot, cwd: root })
  assert.ok(mixed.artifacts.some(item => item.id === 'legacy'), 'existing async outputs stay reachable')
  assert.ok(mixed.artifacts.some(item => item.id === ticket.id), 'workspace handoffs coexist with configured async state')
  assert.equal((await readArtifact({ stateRoot: legacyRoot, cwd: root, path: ticket.id })).ok, true)

  const settled = JSON.parse(readFileSync(join(root, 'gotry-state', 'turn-handoffs', `${ticket.id}.json`), 'utf8'))
  const before = jobs.list(owner.id).length
  assert.equal((await startTurnHandoffJob(ctx, settled, owner, root)).status, 'settled')
  assert.equal(jobs.list(owner.id).length, before, 'terminal replay must not start more work')

  writeFileSync(planner, `setTimeout(()=>console.log('must not complete'),60000)`)
  const pending = await writeTurnHandoffTicket(root, 'cancel', { workspaceCwd: root })
  const cancellable = await startTurnHandoffJob(ctx, pending, owner, root)
  jobs.kill(JobId(cancellable.jobId!), owner.id)
  assert.equal((await jobs.wait(JobId(cancellable.jobId!), 10_000, owner.id)).status, 'killed')
  const cancelled = (await listTurnHandoffTickets(root)).find(item => item.id === pending.id)!
  assert.equal(cancelled.status, 'failed', 'cancellation must settle the durable ticket')
  assert.match(cancelled.error!, /cancelled/)

  writeFileSync(planner, `setTimeout(()=>console.log('late'),60000)`)
  process.env.GOTRY_HANDOFF_PLANNER_TIMEOUT_MS = '50'
  const timeoutTicket = await writeTurnHandoffTicket(root, 'timeout', { workspaceCwd: root })
  const timeoutJob = await startTurnHandoffJob(ctx, timeoutTicket, owner, root)
  assert.equal((await jobs.wait(JobId(timeoutJob.jobId!), 10_000, owner.id)).status, 'failed')
  assert.match((await listTurnHandoffTickets(root)).find(item => item.id === timeoutTicket.id)!.error!, /timed out/)
  delete process.env.GOTRY_HANDOFF_PLANNER_TIMEOUT_MS

  // Match gotry-inner's detached DSH child, inherited pipes and real TERM
  // forwarding bound. Its child ignores TERM, requiring wrapper-owned KILL.
  if (process.platform !== 'win32') {
    const pidFile = join(root, 'descendant.pid')
    const readyFile = join(root, 'descendant.ready')
    const lifecycle = pathToFileURL(join(import.meta.dirname, '..', '..', 'bin', 'gotry-process-liveness.js')).href
    const childCode = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(readyFile)},'ready');setInterval(()=>{},1000)`
    writeFileSync(planner, `
      import {writeFileSync} from 'node:fs';
      import {spawnOwnedChild,terminateOwnedChild} from ${JSON.stringify(lifecycle)};
      const {child,groupPid}=spawnOwnedChild(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','inherit','inherit']});
      writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
      process.once('SIGTERM',()=>{void terminateOwnedChild({child,groupPid}).then(()=>process.exit(143))});
      setInterval(()=>{},1000);
    `)
    for (const mode of ['timeout', 'cancel'] as const) {
      rmSync(readyFile, { force: true })
      rmSync(pidFile, { force: true })
      if (mode === 'timeout') process.env.GOTRY_HANDOFF_PLANNER_TIMEOUT_MS = '1000'
      else delete process.env.GOTRY_HANDOFF_PLANNER_TIMEOUT_MS
      const nestedTicket = await writeTurnHandoffTicket(root, `nested ${mode}`, { workspaceCwd: root })
      const nestedJob = await startTurnHandoffJob(ctx, nestedTicket, owner, root)
      const readyBy = Date.now() + 5000
      while (!existsSync(readyFile) && Date.now() < readyBy) await new Promise(resolve => setTimeout(resolve, 20))
      assert.ok(existsSync(readyFile), 'detached stubborn child actually started')
      const pid = Number(readFileSync(pidFile, 'utf8'))
      descendants.push(pid)
      if (mode === 'cancel') jobs.kill(JobId(nestedJob.jobId!), owner.id)
      const terminal = await jobs.wait(JobId(nestedJob.jobId!), 15_000, owner.id)
      assert.equal(terminal.status, mode === 'cancel' ? 'killed' : 'failed')
      assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' }, `${mode} cannot report terminal while the detached planner child is alive`)
      const view = (await listTurnHandoffTickets(root)).find(item => item.id === nestedTicket.id)!
      assert.equal(view.status, 'failed')
      assert.match(view.error!, mode === 'cancel' ? /cancelled/ : /timed out/)
    }
    delete process.env.GOTRY_HANDOFF_PLANNER_TIMEOUT_MS
  }

  // A fresh host can reuse a native counter id. Its new job must never make
  // an older persisted running ticket look active or offer the wrong controls.
  writeFileSync(planner, `setTimeout(()=>console.log('late'),60000)`)
  const freshTicket = await writeTurnHandoffTicket(root, 'new host trip', { workspaceCwd: root })
  const fresh = await startTurnHandoffJob(ctx, freshTicket, owner, root)
  const stale = await writeTurnHandoffTicket(root, 'old interrupted trip', { workspaceCwd: root })
  await writeTicketJson(root, { ...stale, status: 'running', jobId: fresh.jobId })
  let listTool: { execute(args: unknown, exec: unknown): Promise<unknown> } | undefined
  const queryCtx = {
    tools: { register(tool: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }) { if (tool.name === 'gotry_turn_handoff_list') listTool = tool } },
    systemPrompt: { variable() {} }, on() { return () => {} },
    get: (name: string) => name === 'jobs' ? jobs : undefined,
  } as unknown as Context
  apply(queryCtx, { stateRoot: root, timeoutMs: 1000, hbcliBin: '', sessionAccess: 'off' })
  const oldQuery = await listTool!.execute({ ticketId: stale.id }, { agent: owner }) as { summary: string }
  assert.match(oldQuery.summary, /已中断/, 'reused native id does not identify another saved ticket')
  const newQuery = await listTool!.execute({ ticketId: fresh.id }, { agent: owner }) as { summary: string }
  assert.match(newQuery.summary, /后台任务/, 'exact current ticket still has live controls')
  jobs.kill(JobId(fresh.jobId!), owner.id)
  await jobs.wait(JobId(fresh.jobId!), 15_000, owner.id)

  const unhosted = new Context()
  const waiting = await writeTurnHandoffTicket(root, 'no execution services')
  assert.equal((await startTurnHandoffJob(unhosted, waiting, owner, root)).status, 'open')
  assert.equal((await listTurnHandoffTickets(root)).find(item => item.id === waiting.id)!.jobId, undefined)
  await unhosted.fiber.dispose()

  // A missing controller creates no execution resource and no running claim.
  detach()
  const queued = await writeTurnHandoffTicket(root, 'queued')
  const rejected = await startTurnHandoffJob(ctx, queued, owner, root)
  assert.equal(rejected.status, 'failed')
  assert.ok(rejected.error)
  console.log('native handoff job tests: OK (real registry/process, ownership, settlement, artifacts, idempotence, cancellation, controller rejection)')
} finally {
  delete process.env.GOTRY_HANDOFF_PLANNER_BIN
  delete process.env.GOTRY_HANDOFF_PLANNER_TIMEOUT_MS
  for (const pid of descendants) { try { process.kill(-pid, 'SIGKILL') } catch {} }
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
}
