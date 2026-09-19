import { execFile } from 'node:child_process'

export type ManagedDshWorkerOutcome =
  | { state: 'pending' }
  | { state: 'exited'; exitCode: number | null; signal: string | null }
  | { state: 'failed' }

export interface ManagedDshCleanupDiagnostic {
  schemaVersion: 'managed-dsh-cleanup.v1'
  role: 'task' | 'warmer' | 'unspecified'
  workerPid: number | null
  elapsedMs: number
  deadlineMs: number
  graceMs: number
  workerOutcome: ManagedDshWorkerOutcome
  processGroup: {
    status: 'observed' | 'unavailable' | 'unsupported' | 'unknown_worker'
    expectedPgid: number | null
    members: { pid: number; ppid: number; pgid: number; state: string }[]
    truncated: boolean
  }
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

/** Observe only the detached worker's group, without signalling any process. */
export async function snapshotManagedDshGroup(workerPid: number | null): Promise<ManagedDshCleanupDiagnostic['processGroup']> {
  const empty = { expectedPgid: null, members: [], truncated: false }
  if (workerPid === null) return { ...empty, status: 'unknown_worker' }
  // Only Darwin's installed detached fallback establishes PID == PGID here.
  // Linux native scopes and Windows Jobs require a provider range identity.
  if (process.platform !== 'darwin') return { ...empty, status: 'unsupported' }
  return new Promise((resolve) => {
    // A separate, bounded failure-only observation; it does not extend the
    // provider's cleanup deadline or change its success/failure verdict.
    execFile('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat='], {
      encoding: 'utf8', timeout: 250, maxBuffer: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    }, (error, stdout) => {
      if (error) return resolve({ ...empty, expectedPgid: workerPid, status: 'unavailable' })
      const members: ManagedDshCleanupDiagnostic['processGroup']['members'] = []
      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z+<NsLlEWX-]+)$/)
        if (!match || Number(match[3]) !== workerPid) continue
        members.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), state: match[4] })
      }
      resolve({ status: 'observed', expectedPgid: workerPid, members: members.slice(0, 32), truncated: members.length > 32 })
    })
  })
}
