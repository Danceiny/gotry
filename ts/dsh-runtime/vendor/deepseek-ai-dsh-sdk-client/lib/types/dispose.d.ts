/**
 * Private teardown ladder for the runtime subprocess: stdin EOF (cooperative
 * quiesce), then SIGTERM, then SIGKILL, resolving only after the process has
 * actually exited. The SDK client runs OUTSIDE any harness context, so it
 * cannot ride the `dsh-subprocess` service — this module is the seam's
 * documented exception for SDK-managed transports.
 *
 * @module @deepseek-ai/dsh-sdk-client/dispose
 */
import type { ChildProcess } from 'node:child_process';
/**
 * Tear the runtime down to quiescence, resolving only after exit: close stdin
 * and allow cooperative flush, then use the host's graceful and forced
 * termination semantics. POSIX sends `SIGTERM` before `SIGKILL`; Windows
 * skips directly to forced termination because Node maps both signals to
 * `TerminateProcess`.
 * @param child - the runtime child process to tear down.
 * @param graces - the EOF and termination-confirmation windows (ms).
 * @param platform - the host platform, injectable for unit coverage.
 * @throws When forced termination errors or the child does not report exit
 * within `disposeGraceMs`.
 */
export declare function disposeRuntimeProcess(child: ChildProcess, graces: {
    disposeEofGraceMs: number;
    disposeGraceMs: number;
}, platform?: NodeJS.Platform): Promise<void>;
//# sourceMappingURL=dispose.d.ts.map