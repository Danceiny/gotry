/** Connect durable planning tickets to DSH's owned jobs and managed processes. */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { settleTurnHandoffTicket, writeTicketJson, type TurnHandoffTicket } from './turn-deadline.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { 'gotry-planning': 'gotry-planning' }
}

const require = createRequire(import.meta.url)

export async function startTurnHandoffJob(
  ctx: Context, ticket: TurnHandoffTicket, owner: Agent, stateRoot: string,
): Promise<TurnHandoffTicket> {
  if (ticket.status !== 'open') return ticket
  const jobs = ctx.get('jobs')
  const subprocess = ctx.get('subprocess')
  if (!jobs || !subprocess) return ticket // Queued, never announced as running.
  let current = ticket
  let handle: SubprocessHandle | undefined
  let cancelled = false
  let release!: (ok: boolean) => void
  const prepared = new Promise<boolean>(resolve => { release = resolve })
  let announceStarted!: () => void
  const started = new Promise<void>(resolve => { announceStarted = resolve })
  const fail = async (reason: string) => {
    await settleTurnHandoffTicket(stateRoot, current, 'failed', `# Planning failed\n\n${reason}\n\nNo completed plan was produced.`, reason)
    current = { ...current, status: 'failed', error: reason }
  }
  try {
    const jobId = jobs.start({
      kind: 'gotry-planning', owner: owner.id, label: `${ticket.id}: ${ticket.objective.slice(0, 100)}`, outputLimitBytes: 12_000,
      run() {
        return {
          cancel() { cancelled = true; handle?.terminate() },
          done: (async (): Promise<JobOutcome> => {
            if (!await prepared) { announceStarted(); return { status: 'failed', detail: 'ticket persistence failed' } }
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              if (cancelled) throw new Error('planning cancelled')
              const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
              const collector = join(import.meta.dirname, '..', 'scripts', `turn-handoff-collect.${extension}`)
              const argv = extension === 'ts'
                ? [process.execPath, require.resolve('tsx/cli'), collector, ticket.id, stateRoot]
                : [process.execPath, collector, ticket.id, stateRoot]
              handle = subprocess.spawn({
                argv, cwd: ticket.workspaceCwd ?? stateRoot,
                stdio: { stdin: 'ignore', stdout: { maxBytes: 16_000 }, stderr: { maxBytes: 16_000 } },
                // Collector cleanup includes the wrapper's detached DSH group
                // (5s+1s), then its own 8s+1s bound and durable settlement.
                graceMs: 11_000,
                // This dedicated planning child inherits the configured model
                // environment explicitly; secrets never enter tickets or output.
                env: { GOTRY_HANDOFF_JOB_ID: current.jobId,
                  GOTRY_HANDOFF_PLANNER_BIN: process.env.GOTRY_HANDOFF_PLANNER_BIN,
                  GOTRY_HANDOFF_PLANNER_TIMEOUT_MS: process.env.GOTRY_HANDOFF_PLANNER_TIMEOUT_MS,
                  DSH_HOME: process.env.DSH_HOME,
                  LLM_API_KEY: process.env.LLM_API_KEY, LLM_BASE_URL: process.env.LLM_BASE_URL,
                  LLM_MODEL: process.env.LLM_MODEL, GOTRY_LLM_MODEL: process.env.GOTRY_LLM_MODEL,
                  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL },
              })
              announceStarted()
              const plannerTimeout = Number(process.env.GOTRY_HANDOFF_PLANNER_TIMEOUT_MS)
              const timeout = Number.isSafeInteger(plannerTimeout) && plannerTimeout > 0 ? plannerTimeout : 900_000
              timer = setTimeout(() => handle!.terminate(), timeout + 12_000)
              const direct = await handle.done.then(
                outcome => ({ ok: true as const, outcome }),
                error => ({ ok: false as const, error }),
              )
              // Direct success or failure does not prove managed-range exit.
              if (!direct.ok) handle.terminate()
              try { await handle.waitForExit() }
              catch (cleanupError) {
                handle.terminate()
                const cleanupDiagnostic = cleanupError instanceof Error ? cleanupError.message : 'unknown cleanup error'
                const cleanupReason = `managed-range cleanup could not be confirmed: ${cleanupDiagnostic}`
                if (!direct.ok) {
                  const diagnostic = direct.error instanceof Error ? direct.error.message : 'planning failed'
                  throw new AggregateError([direct.error, cleanupError], `${diagnostic}; ${cleanupReason}`)
                }
                throw new Error(cleanupReason, { cause: cleanupError })
              }
              if (!direct.ok) throw direct.error
              const outcome = direct.outcome
              const path = join(stateRoot, 'gotry-state', 'turn-handoffs', `${ticket.id}.json`)
              const settled = JSON.parse(await readFile(path, 'utf8')) as TurnHandoffTicket
              if (cancelled) throw new Error('planning cancelled')
              if (outcome.exitCode !== 0 || settled.status !== 'settled' || settled.deliverableFile !== `${ticket.id}.deliverable.md`) {
                throw new Error(settled.error ?? `planning collector failed (exit ${outcome.exitCode ?? outcome.signal})`)
              }
              const deliverablePath = join(stateRoot, 'gotry-state', 'turn-handoffs', settled.deliverableFile)
              const content = await readFile(deliverablePath, 'utf8')
              if (!content.trim()) throw new Error('planning collector produced an empty deliverable')
              current = settled
              return { status: 'completed', detail: `ticket ${ticket.id} settled`, result: `Planning completed: ${ticket.id}. Deliverable: ${deliverablePath}\nCall present with this exact path, then report the result.\n\n${content.slice(0, 8_000)}` }
            } catch (error) {
              const reason = error instanceof Error ? error.message : 'planning failed'
              await fail(reason)
              return { status: cancelled ? 'killed' : 'failed', detail: reason, result: `Ticket ${ticket.id} failed: ${reason}` }
            } finally { if (timer) clearTimeout(timer); announceStarted() }
          })(),
        }
      },
    })
    current = { ...ticket, status: 'running', jobId }
    await writeTicketJson(stateRoot, current)
    release(true)
    await started
    return current
  } catch (error) {
    release(false)
    await fail(error instanceof Error ? error.message : 'background job registration failed')
    return current
  }
}
