/**
 * 有界进程树 spawn(shared by hbcli.ts / anything.ts)。
 *
 * 契约:
 *   - pre-aborted signal → 零 spawn,直接返回 aborted;
 *   - 子进程以私有进程组启动(detached);宿主 abort → SIGTERM 整组,
 *     TERM_GRACE 内组不空则 SIGKILL 整组——不 kill 父 PID 冒充树清理;
 *   - 内部超时 → SIGKILL 整组,有界等待 close;
 *   - close 后最多再等待两段 KILL_GRACE 观察进程组；到达边界仍存活时只返回
 *     「清理尝试已耗尽」的结果，不把任意后代树伪装成已回收。调用方若需要
 *     更强证明，必须按自身已知 PID/进程组做读回。
 *   - 所有路径移除 timer/监听器;正常路径等子进程 close,取消/超时路径另有
 *     有界 settlement deadline,避免后代持有 stdio 管道时无限等待。
 * 只面向 CLI 能力层内部,不是通用任务框架。
 */

import { spawn } from 'node:child_process'

const TERM_GRACE_MS = 500
const KILL_GRACE_MS = 1_000
const HARD_SETTLE_MS = TERM_GRACE_MS + KILL_GRACE_MS * 2
const POLL_MS = 10

export interface BoundedSpawnOptions {
  env: NodeJS.ProcessEnv
  cwd?: string
  timeoutMs: number
  signal?: AbortSignal
}

export interface BoundedSpawnResult {
  code: number | null
  stdout: string
  stderr: string
  /** ENOENT 等 spawn 级错误原文 */
  error?: string
  aborted: boolean
  timedOut: boolean
  /** 进程组在 close 后的有界观察是否确认为空；不代表未知后代树的全局证明。 */
  groupReaped?: boolean
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function groupAlive(groupPid: number): boolean {
  try {
    process.kill(-groupPid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitGroupEmpty(groupPid: number, boundMs: number): Promise<boolean> {
  const deadline = Date.now() + boundMs
  while (Date.now() < deadline) {
    if (!groupAlive(groupPid)) return true
    await sleep(POLL_MS)
  }
  return !groupAlive(groupPid)
}

export function spawnBounded(cmd: string, args: string[], opts: BoundedSpawnOptions): Promise<BoundedSpawnResult> {
  if (opts.signal?.aborted) {
    return Promise.resolve({ code: null, stdout: '', stderr: '', aborted: true, timedOut: false, groupReaped: true })
  }

  const child = spawn(cmd, args, {
    env: opts.env,
    cwd: opts.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const groupPid = child.pid

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let done = false
    let timedOut = false
    let timeoutTimer: NodeJS.Timeout | undefined
    let hardSettleTimer: NodeJS.Timeout | undefined
    const trackedTimers = new Set<NodeJS.Timeout>()
    const track = (timer: NodeJS.Timeout): NodeJS.Timeout => {
      trackedTimers.add(timer)
      return timer
    }

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (groupPid === undefined) {
        try { child.kill(signal) } catch { /* ignore */ }
        return
      }
      try {
        process.kill(-groupPid, signal)
      } catch {
        try { child.kill(signal) } catch { /* exit race */ }
      }
    }

    const cleanupTimers = (): void => {
      for (const timer of trackedTimers) clearTimeout(timer)
      trackedTimers.clear()
    }

    const finish = (result: BoundedSpawnResult): void => {
      if (done) return
      done = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (hardSettleTimer) clearTimeout(hardSettleTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      cleanupTimers()
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve(result)
    }

    const forceSettle = (): void => {
      if (done) return
      signalGroup('SIGKILL')
      finish({
        code: null,
        stdout,
        stderr,
        error: timedOut ? `timeout after ${opts.timeoutMs}ms` : 'process group cleanup incomplete',
        aborted: opts.signal?.aborted === true && !timedOut,
        timedOut,
        // close 未到达，无法证明未知后代已释放管道；显式保留不完整状态。
        groupReaped: false,
      })
    }

    const armHardSettle = (delayMs: number): void => {
      if (hardSettleTimer) clearTimeout(hardSettleTimer)
      hardSettleTimer = track(setTimeout(forceSettle, delayMs))
    }

    const onAbort = (): void => {
      if (done || timedOut) return
      // The first termination cause owns the deadline; a later timeout must not
      // relabel an abort or extend the bounded drain window.
      if (timeoutTimer) clearTimeout(timeoutTimer)
      signalGroup('SIGTERM')
      track(setTimeout(() => {
        signalGroup('SIGKILL')
      }, TERM_GRACE_MS))
      armHardSettle(HARD_SETTLE_MS)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    timeoutTimer = setTimeout(() => {
      if (done) return
      timedOut = true
      signalGroup('SIGKILL')
      armHardSettle(KILL_GRACE_MS * 2)
    }, opts.timeoutMs)

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (e: Error) => {
      finish({ code: null, stdout, stderr, error: e.message, aborted: false, timedOut: false })
    })
    child.on('close', async (code) => {
      if (done) return
      const aborted = opts.signal?.aborted === true && !timedOut
      // close 只代表直接子进程退出;再观测进程组为空才认定树清理完成(有界)。
      let groupReaped = true
      if (groupPid !== undefined) {
        groupReaped = await waitGroupEmpty(groupPid, KILL_GRACE_MS)
        if (done) return
        if (!groupReaped) {
          signalGroup('SIGKILL')
          groupReaped = await waitGroupEmpty(groupPid, KILL_GRACE_MS)
        }
      }
      finish({ code, stdout, stderr, aborted, timedOut, groupReaped, ...(timedOut ? { error: `timeout after ${opts.timeoutMs}ms` } : {}) })
    })
  })
}

export const SPAWN_BOUNDED_BOUNDS = Object.freeze({ termGraceMs: TERM_GRACE_MS, killGraceMs: KILL_GRACE_MS, hardSettleMs: HARD_SETTLE_MS })
