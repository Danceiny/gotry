/** Typed Win32 process operations over the shared binding table. */
import type { NativePtr, Win32ProcessBindings } from './ffi.ts';
/**
 * Quote one argument according to CommandLineToArgvW parsing.
 * @param argument - one argv entry.
 * @returns bare or quoted command-line segment.
 */
export declare function quoteArg(argument: string): string;
/**
 * Build the mutable command line accepted by CreateProcessAsUserW.
 * @param program - executable argv entry.
 * @param args - remaining argv entries.
 * @returns joined Win32 command line.
 */
export declare function buildCommandLine(program: string, args: readonly string[]): string;
/** Restricted-token process creation inputs owned by the Windows ACL sandbox. */
export interface RestrictedProcessSpawnOptions {
    /** Executable argv entry passed through CreateProcessAsUserW. */
    command: string;
    /** Arguments excluding the executable. */
    args: readonly string[];
    /** Existing child working directory. */
    cwd: string;
    /** Restricted primary token supplied by sandbox policy. */
    token: NativePtr;
}
/** Piped child resources whose process and read handles remain caller-owned. */
export interface SpawnedPipedProcess {
    /** Direct child process id. */
    pid: number;
    /** Process handle closed by waitForProcessExit. */
    process: NativePtr;
    /** Stdout pipe read end closed by drainPipe. */
    stdoutRead: NativePtr;
    /** Stderr pipe read end closed by drainPipe. */
    stderrRead: NativePtr;
}
/** Suspended child assigned to one caller-owned kill-on-close Job before resume. */
export interface SpawnedJobProcess {
    /** Direct child process id. */
    pid: number;
    /** Process handle closed by waitForProcessExit. */
    process: NativePtr;
    /** Job handle closed by the lifecycle owner. */
    job: NativePtr;
}
/**
 * Spawn a process with anonymous-pipe stdout/stderr and immediate stdin EOF.
 * @param api - active binding table.
 * @param options - command, cwd, args, and restricted primary token.
 * @returns caller-owned process and pipe read handles.
 */
export declare function spawnPipedProcess(api: Win32ProcessBindings, options: RestrictedProcessSpawnOptions): SpawnedPipedProcess;
/**
 * Drain one anonymous pipe until the writer closes it.
 * @param api - active binding table.
 * @param handle - caller-owned pipe read end.
 * @returns complete bytes read before EOF; the handle is always closed.
 * @throws when a Win32 pipe operation fails.
 */
export declare function drainPipe(api: Win32ProcessBindings, handle: NativePtr): Promise<Buffer>;
/**
 * Wait for a process and always close its handle.
 * @param api - active binding table.
 * @param process - caller-owned process handle.
 * @returns direct process exit code.
 */
export declare function waitForProcessExit(api: Win32ProcessBindings, process: NativePtr): number;
/**
 * Spawn suspended, assign the child to a kill-on-close Job, then resume it.
 * @param api - active binding table.
 * @param options - command, cwd, args, and restricted primary token.
 * @returns caller-owned process and Job handles after successful resume.
 * @remarks Node clears stdio handle inheritability at startup through
 * uv_disable_stdio_inheritance. This operation temporarily restores the bits
 * required by STARTF_USESTDHANDLES. Restoring them afterward is best-effort:
 * failure must not replace the already-created child's outcome.
 */
export declare function spawnInheritedJobProcess(api: Win32ProcessBindings, options: RestrictedProcessSpawnOptions): SpawnedJobProcess;
//# sourceMappingURL=process.d.ts.map