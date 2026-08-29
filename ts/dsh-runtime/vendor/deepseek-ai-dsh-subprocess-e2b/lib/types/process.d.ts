/** One asynchronously-started E2B command projected onto the subprocess seam. */
import { PassThrough, Writable } from 'node:stream';
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import type E2BRuntime from '@deepseek-ai/dsh-e2b';
/** E2B-backed subprocess handle with deferred remote PID acquisition. */
export declare class E2BSubprocessHandle implements SubprocessHandle {
    private readonly runtime;
    private readonly spec;
    readonly stateDir: string;
    private readonly pollMs;
    readonly stdin: Writable | undefined;
    readonly stdout: PassThrough | undefined;
    readonly stderr: PassThrough | undefined;
    readonly collected: SubprocessHandle['collected'];
    readonly done: Promise<SubprocessOutcome>;
    private readonly commandState;
    private readonly readyState;
    private readonly stdoutDecoder;
    private readonly stderrDecoder;
    private readonly terminationController;
    /** Releases output waits that survive the command outcome, so blocked SDK callbacks settle. */
    private readonly outputReleased;
    private readonly stdoutReader;
    private readonly stderrReader;
    private readonly paths;
    private controlEnvs;
    private remotePid;
    private outputTransportError;
    private outputDrainExpired;
    private stateDirectoryCreated;
    private quiescenceProven;
    private terminationAttempt;
    private terminationFailure;
    private terminationSignal;
    /**
     * Begin an E2B command without blocking the synchronous subprocess spawn call.
     * @param runtime - Shared E2B sandbox owner.
     * @param spec - Fully resolved subprocess request.
     * @param stateDir - Remote directory retaining process identity, status, and valid spills.
     * @param pollMs - Remote status/liveness poll cadence.
     */
    constructor(runtime: E2BRuntime, spec: SubprocessSpawnSpec, stateDir: string, pollMs: number);
    /** Remote process id after start; `-1` while E2B startup is pending or after it fails. */
    get pid(): number;
    /** @inheritdoc */
    terminate(): void;
    /** @inheritdoc */
    waitForExit(signal?: AbortSignal): Promise<boolean>;
    private readonly onAbort;
    private markQuiescent;
    private run;
    private prepareState;
    private writeBatchStdin;
    private dispatchOutput;
    private writeOutput;
    private waitForProcessGroupId;
    private waitForCommand;
    private commandOutcome;
    private rollbackPublishedFailure;
    private rollbackUnpublishedGroup;
    private terminateRemote;
    private terminateRemoteInSandbox;
    private terminateGroup;
    private forceKillGroup;
    private waitForGroupExit;
    private throwTerminationFailure;
    private groupAlive;
    private finalizeSpills;
    private removeFailedState;
}
//# sourceMappingURL=process.d.ts.map