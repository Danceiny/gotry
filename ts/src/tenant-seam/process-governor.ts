/**
 * Resource limits for the child process trees that run model-driven code on a replica
 * (docs/rfc/aaas-rfc.md §4.8, threat S-17).
 *
 * The tenant boundary of the state layer says nothing about CPU and memory: every tenant on a replica shares them,
 * so one runaway planner child could take the replica, and every tenant on it, down with it. This module bounds
 * what one child tree can take before the operating system's OOM killer decides for us. It is a ceiling for a
 * runaway, not a budget and not isolation: a tree that stays under its limits still shares the machine.
 *
 * The governor samples the process table (`ps`), finds the tree that starts at a watched root, and kills the
 * whole tree the moment it is over a limit. The root is identified by its parent as well as by its pid, so a pid
 * that the operating system has reused for an unrelated process is never sampled and never killed. Sampling is
 * read-only, one `ps` per tick for every watched tree, and a failed sample kills nothing.
 *
 * Linux places the worker in a user-systemd scope and Darwin in its own process group, so neither a group id nor a
 * cgroup is assumed here: the tree is the root and its descendants by parent pid, which both platforms report.
 * A child that deliberately re-parents itself away leaves the tree; the planner children cannot start processes
 * (their shell, file and subprocess plugins are disabled), and the provider-owned range cleanup of
 * `dsh-subprocess-local` remains the primary teardown. This is the second line.
 */

import { execFile } from 'node:child_process'

export interface TreeLimits {
  /**
   * Resident set of the whole tree in bytes. Pages that processes share are counted once per process, so this
   * overstates: set it as a ceiling for a runaway.
   */
  readonly maxRssBytes?: number
  /** CPU time consumed by the tree's live processes, in seconds, as the process table reports it (one-second resolution on Linux). */
  readonly maxCpuSeconds?: number
}

export interface TreeBreach {
  readonly kind: 'memory' | 'cpu'
  readonly limit: number
  readonly observed: number
}

export interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly rssBytes: number
  readonly cpuSeconds: number
}

export type ProcessTable = () => Promise<readonly ProcessRow[]>

/** A tree to watch: the root and the process that must be its parent (this process, for a child it spawned). */
export interface TreeTarget {
  readonly rootPid: number
  readonly parentPid: number
}

export interface TreeSample {
  readonly pids: readonly number[]
  readonly rssBytes: number
  readonly cpuSeconds: number
}

/** The process table cannot be read or does not show this process: the sampler would govern nothing. */
export class ProcessTableUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('the process table cannot be read, so planner process trees cannot be governed', { cause })
    this.name = 'ProcessTableUnavailableError'
  }
}

export interface ProcessTreeGovernorOptions {
  /** Time between samples. Default 1000. */
  readonly intervalMs?: number
  /** The process table. Default: `ps`. Injected by the suites. */
  readonly table?: ProcessTable
  /** Kills the sampled processes. Default: SIGKILL each pid. Injected by the suites. */
  readonly kill?: (pids: readonly number[]) => void
  /** Receives a failed sample or a throwing breach handler. A failure here never stops the governor. */
  readonly onFault?: (error: unknown) => void
}

const DEFAULT_INTERVAL_MS = 1_000
const PS_TIMEOUT_MS = 3_000
const PS_MAX_BUFFER_BYTES = 16 * 1024 * 1024

/** `[DD-][HH:]MM:SS[.ss]`: Linux prints `HH:MM:SS` and `DD-HH:MM:SS`, Darwin `M:SS.ss` and `H:MM:SS.ss`. NaN for anything else. */
export function parseCpuSeconds(text: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim())
  if (!match) return Number.NaN
  const [, days, hours, minutes, seconds] = match
  return (Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3_600 + Number(minutes) * 60 + Number(seconds)
}

/** Parses the output of `ps` with `PS_ARGS` (rss in KiB). Lines that do not parse are dropped, never guessed. */
export function parsePsTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line)
    if (!match) continue
    const cpuSeconds = parseCpuSeconds(match[4]!)
    if (Number.isNaN(cpuSeconds)) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, cpuSeconds })
  }
  return rows
}

/**
 * `-A` selects every process on procps (Linux) and on BSD (Darwin) alike; the BSD-style `-ax` that the cleanup diagnostics
 * use on Darwin makes procps warn on stderr. `pid=` and the like suppress the header. `rss` is in KiB on both.
 */
export const PS_ARGS: readonly string[] = ['-A', '-o', 'pid=,ppid=,rss=,time=']

export function readPsTable(): Promise<readonly ProcessRow[]> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', [...PS_ARGS], {
      encoding: 'utf8', timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER_BYTES,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    }, (error, stdout) => (error ? reject(error) : resolve(parsePsTable(stdout))))
  })
}

/**
 * The root and its descendants, or `null` when the root is not there or is not a child of the expected parent.
 * Pure: the suites feed crafted tables.
 */
export function treeOf(rows: readonly ProcessRow[], target: TreeTarget): TreeSample | null {
  const byPid = new Map<number, ProcessRow>()
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    byPid.set(row.pid, row)
    const siblings = children.get(row.ppid)
    if (siblings) siblings.push(row)
    else children.set(row.ppid, [row])
  }
  const root = byPid.get(target.rootPid)
  if (!root || root.ppid !== target.parentPid) return null
  const pids: number[] = []
  let rssBytes = 0
  let cpuSeconds = 0
  const seen = new Set<number>()
  const queue: ProcessRow[] = [root]
  for (let row = queue.shift(); row; row = queue.shift()) {
    if (seen.has(row.pid)) continue
    seen.add(row.pid)
    pids.push(row.pid)
    rssBytes += row.rssBytes
    cpuSeconds += row.cpuSeconds
    for (const child of children.get(row.pid) ?? []) queue.push(child)
  }
  return { pids, rssBytes, cpuSeconds }
}

function breachOf(sample: TreeSample, limits: TreeLimits): TreeBreach | null {
  if (limits.maxRssBytes !== undefined && sample.rssBytes > limits.maxRssBytes) {
    return { kind: 'memory', limit: limits.maxRssBytes, observed: sample.rssBytes }
  }
  if (limits.maxCpuSeconds !== undefined && sample.cpuSeconds > limits.maxCpuSeconds) {
    return { kind: 'cpu', limit: limits.maxCpuSeconds, observed: sample.cpuSeconds }
  }
  return null
}

function assertPositive(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new RangeError(`${name} must be a positive number`)
}

function killEach(pids: readonly number[]): void {
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

interface Watch {
  readonly target: TreeTarget
  readonly limits: TreeLimits
  readonly onBreach: (breach: TreeBreach) => void
}

export class ProcessTreeGovernor {
  private readonly intervalMs: number
  private readonly table: ProcessTable
  private readonly kill: (pids: readonly number[]) => void
  private readonly onFault: ((error: unknown) => void) | undefined
  private readonly watches = new Map<number, Watch>()
  private nextId = 1
  private timer: NodeJS.Timeout | undefined
  private ticking = false
  private sampleFailures = 0

  constructor(options: ProcessTreeGovernorOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    assertPositive('intervalMs', this.intervalMs)
    this.table = options.table ?? readPsTable
    this.kill = options.kill ?? killEach
    this.onFault = options.onFault
  }

  /** Trees under watch now. */
  get size(): number {
    return this.watches.size
  }

  /** Samples that failed since construction. A failed sample kills nothing. */
  get failedSamples(): number {
    return this.sampleFailures
  }

  /**
   * Watches one tree. `onBreach` runs once, before the tree is killed, so the owner can record why. The returned
   * function stops the watch and is safe to call after a breach. With no limit given nothing is watched.
   */
  watch(target: TreeTarget, limits: TreeLimits, onBreach: (breach: TreeBreach) => void): () => void {
    if (!Number.isSafeInteger(target.rootPid) || target.rootPid <= 0) throw new RangeError('rootPid must be a positive integer')
    if (!Number.isSafeInteger(target.parentPid) || target.parentPid <= 0) throw new RangeError('parentPid must be a positive integer')
    assertPositive('maxRssBytes', limits.maxRssBytes)
    assertPositive('maxCpuSeconds', limits.maxCpuSeconds)
    if (limits.maxRssBytes === undefined && limits.maxCpuSeconds === undefined) return () => undefined
    const id = this.nextId++
    this.watches.set(id, { target, limits, onBreach })
    this.startTimer()
    return () => {
      this.watches.delete(id)
      if (this.watches.size === 0) this.stopTimer()
    }
  }

  /**
   * Proves the sampler can see: the table reads, and it shows this very process. A service that cannot see its own
   * process table would run its children ungoverned and silently (for example where `ps` is a stripped-down build),
   * so a deployment checks this once before the first tree starts and refuses to run children without it.
   */
  async probe(): Promise<void> {
    let rows: readonly ProcessRow[]
    try {
      rows = await this.table()
    } catch (error) {
      throw new ProcessTableUnavailableError(error)
    }
    const self = rows.find((row) => row.pid === process.pid)
    if (!self || self.rssBytes <= 0) throw new ProcessTableUnavailableError()
  }

  /** One sampling pass. The timer calls it; the suites call it directly to stay deterministic. */
  async tick(): Promise<void> {
    if (this.ticking || this.watches.size === 0) return
    this.ticking = true
    try {
      let rows: readonly ProcessRow[]
      try {
        rows = await this.table()
      } catch (error) {
        this.sampleFailures += 1
        this.report(error)
        return
      }
      for (const [id, watch] of [...this.watches]) {
        const sample = treeOf(rows, watch.target)
        if (!sample) continue
        const breach = breachOf(sample, watch.limits)
        if (!breach) continue
        this.watches.delete(id)
        try {
          watch.onBreach(breach)
        } catch (error) {
          this.report(error)
        } finally {
          this.kill(sample.pids)
        }
      }
    } finally {
      this.ticking = false
      if (this.watches.size === 0) this.stopTimer()
    }
  }

  close(): void {
    this.watches.clear()
    this.stopTimer()
  }

  private report(error: unknown): void {
    try { this.onFault?.(error) } catch { /* reporting must never stop the governor */ }
  }

  private startTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => { this.tick().catch((error: unknown) => this.report(error)) }, this.intervalMs)
    // The governor must not keep the process alive: a watched child cannot outlive its owner's own shutdown.
    this.timer.unref()
  }

  private stopTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }
}

let shared: ProcessTreeGovernor | undefined

/** The governor every managed port shares by default: one `ps` per tick, however many trees are watched. */
export function sharedProcessTreeGovernor(): ProcessTreeGovernor {
  shared ??= new ProcessTreeGovernor({
    onFault: (error) => { console.error('[process-governor] fault:', error instanceof Error ? error.message : String(error)) },
  })
  return shared
}
