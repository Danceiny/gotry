import type { ChildProcess, SpawnOptions } from 'node:child_process'

export interface OwnedChild {
  child: ChildProcess
  groupPid: number | null
}

export interface OwnedChildCleanupResult {
  childExited: boolean
  groupEmpty: boolean
  forced: boolean
}

export interface OwnedChildCleanupOptions {
  child?: ChildProcess | null
  groupPid?: number | null
  signal?: NodeJS.Signals
  termGraceMs?: number
  killWaitMs?: number
}

export declare function spawnOwnedChild(command: string, args: readonly string[], options?: SpawnOptions): OwnedChild
export declare function signalOwnedChild(child: ChildProcess | null | undefined, signal: NodeJS.Signals, groupPid?: number | null): void
export declare function isOwnedProcessGroupEmpty(groupPid: number | null): boolean
export declare function waitForOwnedChildQuiescence(child: ChildProcess, groupPid?: number | null, timeoutMs?: number): Promise<boolean>
export declare function terminateOwnedChild(options?: OwnedChildCleanupOptions): Promise<OwnedChildCleanupResult>
export declare const PROCESS_LIVENESS_BOUNDS: Readonly<{ termGraceMs: number; killWaitMs: number }>
