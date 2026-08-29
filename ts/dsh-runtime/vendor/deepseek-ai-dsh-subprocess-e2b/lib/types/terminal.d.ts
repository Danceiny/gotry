/** E2B PTY allocation and process-session ownership for the subprocess seam. */
import { PassThrough } from 'node:stream';
import type { CommandHandle, CommandResult, Sandbox } from '@deepseek-ai/dsh-e2b';
import type { SubprocessOutcome, SubprocessTerminalForeground, SubprocessTerminalHandle, SubprocessTerminalSignal, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import type E2BRuntime from '@deepseek-ai/dsh-e2b';
/** One E2B PTY and all process groups in its remote process session. */
export declare class E2BTerminalHandle implements SubprocessTerminalHandle {
    private readonly sandbox;
    private readonly handle;
    readonly output: PassThrough;
    private readonly completion;
    private readonly sessionId;
    private readonly controlEnvs;
    private readonly stateDir;
    private readonly graceMs;
    private readonly pollMs;
    readonly pid: number;
    readonly done: Promise<SubprocessOutcome>;
    private topLevelExited;
    private cleanup;
    private readonly operationController;
    private readonly operations;
    private terminationSignal;
    constructor(sandbox: Sandbox, handle: CommandHandle, output: PassThrough, completion: Promise<CommandResult>, sessionId: number, controlEnvs: Record<string, string>, stateDir: string, graceMs: number, pollMs: number);
    /** @inheritdoc */
    write(data: string): Promise<void>;
    /** @inheritdoc */
    inspectForeground(): Promise<SubprocessTerminalForeground | undefined>;
    /** @inheritdoc */
    signalForeground(signal: SubprocessTerminalSignal): Promise<number>;
    /** @inheritdoc */
    terminate(): Promise<void>;
    private inspectForegroundOnce;
    private trackOperation;
    private closeAfterOperations;
    private waitForCommand;
    private closeOnce;
}
/**
 * Allocate an E2B PTY, replace its bootstrap shell with the requested argv,
 * and return only after the private runner has published readiness.
 * @param runtime - Shared E2B sandbox owner.
 * @param spec - Fully specified terminal-process request.
 * @param stateDir - Private remote directory for one startup transaction.
 * @param pollMs - Remote session liveness poll cadence.
 * @returns The live subprocess terminal handle.
 */
export declare function spawnE2BTerminal(runtime: E2BRuntime, spec: SubprocessTerminalSpawnSpec, stateDir: string, pollMs: number): Promise<E2BTerminalHandle>;
//# sourceMappingURL=terminal.d.ts.map