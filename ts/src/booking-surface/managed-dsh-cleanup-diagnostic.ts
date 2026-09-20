import { execFile } from 'node:child_process'

export type ManagedDshWorkerOutcome =
  | { state: 'pending' }
  | { state: 'exited'; exitCode: number | null; signal: string | null }
  | { state: 'failed' }

export interface ManagedDshGroupMember {
  pid: number
  ppid: number
  pgid: number
  state: string
  /** Read-only `ps lstart` identity evidence; zombies keep their original start time. */
  startedAt: string | null
  zombie: boolean
}

/**
 * `has-live-members`: at least one non-zombie member remains. `zombie-only`:
 * every remaining member is a dead-but-unreaped zombie. `empty`: the group has
 * no visible member. On Darwin the detached-fallback observation
 * (`kill(-pgid, 0)`) cannot distinguish these: it returns EPERM for
 * zombie-only groups, which the runtime maps to "alive".
 */
export type ManagedDshGroupClassification = 'empty' | 'zombie-only' | 'has-live-members'

export interface ManagedDshProcessGroupSnapshot {
  status: 'observed' | 'unavailable' | 'unsupported' | 'unknown_worker'
  expectedPgid: number | null
  members: ManagedDshGroupMember[]
  truncated: boolean
  classification: ManagedDshGroupClassification | null
  liveMemberCount: number | null
  zombieMemberCount: number | null
  /** Start-time anchor captured while the worker was alive, for identity comparison. */
  workerStartedAt: string | null
  workerIdentity: 'match' | 'mismatch' | 'worker-absent' | 'unknown' | null
}

export interface ManagedDshCleanupDiagnostic {
  schemaVersion: 'managed-dsh-cleanup.v2'
  role: 'task' | 'warmer' | 'unspecified'
  workerPid: number | null
  elapsedMs: number
  deadlineMs: number
  graceMs: number
  workerOutcome: ManagedDshWorkerOutcome
  processGroup: ManagedDshProcessGroupSnapshot
}

/** Diagnostics never include argv, environment, provider output or request data. */
export class ManagedDshCleanupError extends Error {
  constructor(message: string, readonly diagnostic: ManagedDshCleanupDiagnostic) {
    // Keep the safe snapshot visible even when nested AggregateError inspection
    // collapses custom object properties in an uncaught-error log.
    super(`${message}; diagnostic=${JSON.stringify(diagnostic)}`)
    this.name = 'ManagedDshCleanupError'
  }
}

const MEMBER_LINE = /^(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z+<NsLlEWXU-]+)\s+(.+?)\s*$/
const MAX_MEMBERS = 32

/**
 * Classify one `ps -axo pid=,ppid=,pgid=,stat=,lstart=` table for the owned
 * group. Pure so proofs can feed crafted tables without signalling anything.
 */
export function parseManagedDshGroupSnapshot(
  stdout: string,
  expectedPgid: number | null,
  workerStartedAt: string | null = null,
): ManagedDshProcessGroupSnapshot {
  const empty = {
    status: 'unknown_worker', expectedPgid, members: [], truncated: false, classification: null,
    liveMemberCount: null, zombieMemberCount: null, workerStartedAt, workerIdentity: null,
  } as ManagedDshProcessGroupSnapshot
  if (expectedPgid === null) return { ...empty, status: 'unknown_worker' }
  const members: ManagedDshGroupMember[] = []
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(MEMBER_LINE)
    if (!match || Number(match[3]) !== expectedPgid) continue
    members.push({
      pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
      state: match[4], startedAt: match[5] ?? null, zombie: match[4].startsWith('Z'),
    })
  }
  const liveMemberCount = members.filter((member) => !member.zombie).length
  const zombieMemberCount = members.length - liveMemberCount
  const classification: ManagedDshGroupClassification =
    members.length === 0 ? 'empty' : liveMemberCount === 0 ? 'zombie-only' : 'has-live-members'
  let workerIdentity: ManagedDshProcessGroupSnapshot['workerIdentity'] = 'unknown'
  if (workerStartedAt !== null) {
    const workerRow = members.find((member) => member.pid === expectedPgid)
    workerIdentity = workerRow === undefined
      ? 'worker-absent'
      : workerRow.startedAt === workerStartedAt ? 'match' : 'mismatch'
  }
  return {
    status: 'observed', expectedPgid,
    members: members.slice(0, MAX_MEMBERS), truncated: members.length > MAX_MEMBERS,
    classification, liveMemberCount, zombieMemberCount,
    workerStartedAt, workerIdentity,
  }
}

/** Whether the snapshot proves the owned group holds no live member. */
export function managedDshGroupIsQuiescent(group: ManagedDshProcessGroupSnapshot): boolean {
  return group.status === 'observed' && (group.classification === 'empty' || group.classification === 'zombie-only')
}

/** Read-only one-shot start-time anchor for the live worker (Darwin only). */
export function readManagedDshWorkerStart(pid: number): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 250, maxBuffer: 4096,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    }, (error, stdout) => resolve(error ? null : stdout.trim() || null))
  })
}

/**
 * Observe only the detached worker's group, without signalling any process.
 * Snapshot fields are limited to pid/ppid/pgid/state/start time — never argv,
 * environment, or request content.
 */
export async function snapshotManagedDshGroup(
  workerPid: number | null,
  workerStartedAt: string | null = null,
): Promise<ManagedDshProcessGroupSnapshot> {
  const empty = {
    status: 'unknown_worker', expectedPgid: null, members: [], truncated: false, classification: null,
    liveMemberCount: null, zombieMemberCount: null, workerStartedAt, workerIdentity: null,
  } as ManagedDshProcessGroupSnapshot
  if (workerPid === null) return { ...empty, status: 'unknown_worker' }
  // Only Darwin's installed detached fallback establishes PID == PGID here.
  // Linux native scopes and Windows Jobs require a provider range identity,
  // so an unsupported platform claims no expected group at all.
  if (process.platform !== 'darwin') return { ...empty, status: 'unsupported' }
  return new Promise((resolve) => {
    // A separate, bounded failure-only observation; it does not extend the
    // provider's cleanup deadline or change its success/failure verdict.
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], {
      encoding: 'utf8', timeout: 250, maxBuffer: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    }, (error, stdout) => {
      if (error) return resolve({ ...empty, expectedPgid: workerPid, status: 'unavailable' })
      resolve(parseManagedDshGroupSnapshot(stdout, workerPid, workerStartedAt))
    })
  })
}
