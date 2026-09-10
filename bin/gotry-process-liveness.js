/**
 * GoTry-owned lifecycle for one externally spawned dsh child.
 *
 * The dsh CLI is an external process boundary. On POSIX we make it the
 * leader of its own process group so a parent-only signal or a failed dsh
 * child cannot strand descendants. This module owns only bounded signalling
 * and quiescence observation; incident formatting remains in the existing
 * GoTry incident writer.
 */

import { spawn } from 'node:child_process'

const DEFAULT_TERM_GRACE_MS = 5_000
const DEFAULT_KILL_WAIT_MS = 1_000
const POLL_MS = 20

/** Spawn a child in a private process group where the host supports it. */
export function spawnOwnedChild(command, args, options = {}) {
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== 'win32',
  })
  return {
    child,
    groupPid: process.platform !== 'win32' ? (child.pid ?? null) : null,
  }
}

/** Signal the child group, falling back to the direct child when necessary. */
export function signalOwnedChild(child, signal, groupPid = null) {
  if (!child) return
  if (process.platform !== 'win32' && groupPid !== null) {
    try {
      process.kill(-groupPid, signal)
      return
    } catch {
      // The group can disappear between observation and delivery. Try the
      // direct handle as a best-effort race fallback.
    }
  }
  try { child.kill(signal) } catch { /* exit races are contained */ }
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function groupEmpty(groupPid) {
  if (process.platform === 'win32' || groupPid === null) return true
  try {
    process.kill(-groupPid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

/** Expose the same group-emptiness fact used by the bounded cleanup proof. */
export function isOwnedProcessGroupEmpty(groupPid) {
  return groupEmpty(groupPid)
}

/** Wait for the direct child and, on POSIX, its whole private group. */
export async function waitForOwnedChildQuiescence(child, groupPid = null, timeoutMs = DEFAULT_TERM_GRACE_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (childExited(child) && groupEmpty(groupPid)) return true
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return childExited(child) && groupEmpty(groupPid)
}

/**
 * Bounded TERM → KILL cleanup for one owned child group. It resolves only
 * after the direct child and group are observed empty, or after the bound.
 */
export async function terminateOwnedChild({
  child,
  groupPid = null,
  signal = 'SIGTERM',
  termGraceMs = DEFAULT_TERM_GRACE_MS,
  killWaitMs = DEFAULT_KILL_WAIT_MS,
} = {}) {
  if (!child) return { childExited: true, groupEmpty: true, forced: false }
  signalOwnedChild(child, signal, groupPid)
  if (await waitForOwnedChildQuiescence(child, groupPid, termGraceMs)) {
    return { childExited: true, groupEmpty: true, forced: false }
  }
  signalOwnedChild(child, 'SIGKILL', groupPid)
  const empty = await waitForOwnedChildQuiescence(child, groupPid, killWaitMs)
  return { childExited: childExited(child), groupEmpty: empty, forced: true }
}

export const PROCESS_LIVENESS_BOUNDS = Object.freeze({
  termGraceMs: DEFAULT_TERM_GRACE_MS,
  killWaitMs: DEFAULT_KILL_WAIT_MS,
})
