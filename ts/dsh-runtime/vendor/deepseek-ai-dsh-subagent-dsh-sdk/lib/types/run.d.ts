/**
 * Fresh-process SDK subagent client. Drives one child DeepSeek Harness
 * runtime over stdio JSON-RPC through `@deepseek-ai/dsh-sdk-client` and owns
 * cancellation and quiescent disposal. It publishes after the child
 * handshake, maps child failures to stop reasons, and tears down to
 * quiescence. The SDK client spawns the child rather than using
 * `ctx.subprocess` — the subprocess seam's documented exception for
 * SDK-managed transports — so this driver applies the seam's shared env scrub.
 *
 * @module @deepseek-ai/dsh-subagent-dsh-sdk/run
 */
import { DeepSeekHarness, type DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client';
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { type TurnEndReason } from '@deepseek-ai/dsh-session';
import type { SubagentResult, SubagentRun, SubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent';
/** Resolved spawn spec for an SDK runtime child process (no defaults — see Config). */
export interface SdkRunSpec {
    /** Explicit dsh CLI module; omission resolves the SDK client's same-version dependency. */
    dshBin?: string;
    /** Named child profile. */
    profile: string;
    /** Ordered per-launch profile patch files. */
    patches: string[];
    /** Absolute isolated Harness home for the nested runtime. */
    dshHome: string;
    /**
     * Absolute working directory for the child process AND the workspace cwd
     * of its SDK session. The provider resolves it before this spec exists:
     * config override, else the delegating parent session's workspace.
     */
    cwd: string;
    /** Provider route the child runtime initializes with. */
    provider: string;
    /** Model the child runtime initializes with. */
    model: string;
    /** Optional adapter-owned reasoning effort sent in the child runtime's initialize handshake. */
    reasoningEffort?: ReasoningEffortId;
    /** Optional per-request output-token cap sent in the child runtime's initialize handshake. */
    maxTokens?: number;
    /**
     * Extra environment variables to ADD for the child (e.g. the child
     * runtime's own `DEEPSEEK_API_KEY`). Merged after
     * the seam's `scrubbedParentEnv()` base, so an explicit credential or
     * current `DSH_*` fact survives while ambient namesakes never leak.
     */
    env: Record<string, string>;
    /** Bound (ms) on the protocol `shutdown` exchange during dispose. */
    shutdownTimeoutMs: number;
    /** Grace period (ms) for the child's EOF-driven quiesce on dispose. */
    disposeEofGraceMs: number;
    /** Termination confirmation window (ms), including forced exit on every platform. */
    disposeGraceMs: number;
    /**
     * Host sink for startup, published-run, or shutdown failures. Model-visible
     * text uses fixed safe facts, while this callback retains the original Error.
     * A throw from the sink itself is contained.
     */
    onError?: (error: Error, stopReason: SubagentStopReason) => void;
}
/** EOF grace for child flush and nested-process teardown; wider than the signal grace below. */
export declare const DEFAULT_DISPOSE_EOF_GRACE_MS = 6000;
/** Default POSIX grace between SIGTERM and SIGKILL on dispose (the `disposeGraceMs` config). */
export declare const DEFAULT_DISPOSE_GRACE_MS = 3000;
/** Default bound on the protocol `shutdown` exchange during dispose. */
export declare const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1000;
/** Runtime constructor seam replaced only by package-local fake-runtime tests. */
export declare const internals: {
    createHarness(options: DeepSeekHarnessOptions): DeepSeekHarness;
};
/**
 * Hide a pre-spawn workspace/configuration failure behind fixed safe facts.
 * @param cause - original Host failure retained on the Error cause chain.
 * @returns an Error whose message contains only the fixed DSH SDK failure line.
 */
export declare function sdkConfigurationFailure(cause: unknown): Error;
/**
 * Map one child terminal reason to its complete shared result outcome.
 * @param reason - the owned child run's final durable turn reason, or
 * `undefined` when it settled without running a turn.
 * @returns the shared stop reason and any additional safe diagnostic.
 */
export declare function sdkChildOutcome(reason: TurnEndReason | undefined): Pick<SubagentResult, 'stopReason' | 'diagnostic'>;
/**
 * Start and publish one SDK runtime child after its `initialize` handshake.
 * Child failures resolve through the run result. Startup rejects with fixed
 * safe facts after SDK-owned cleanup; successful cleanup proves process reap.
 * Cleanup failure preserves initialize plus shutdown for an ordinary failure,
 * or shutdown alone after cancellation, without claiming quiescence. Disposal
 * shuts the runtime down and reaps it.
 * @param request - the start request; its signal is the cancellation channel.
 * @param spec - the resolved spawn spec: profile/patches/home/cwd, the child's
 * provider/model/reasoning route, output cap, env, timeouts, and the optional
 * error sink.
 * @returns the ready run handle for the child subprocess.
 */
export declare function startSdkRun(request: SubagentStartRequest, spec: SdkRunSpec): Promise<SubagentRun>;
//# sourceMappingURL=run.d.ts.map