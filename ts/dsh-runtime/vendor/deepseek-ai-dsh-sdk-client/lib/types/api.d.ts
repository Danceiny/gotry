/**
 * High-level run API over {@link HarnessClient}: `DeepSeekHarness` owns one
 * runtime subprocess across many sessions; `HarnessSession.run` sends a
 * prompt and settles when the whole agent next becomes idle.
 *
 * @module @deepseek-ai/dsh-sdk-client/api
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { HarnessClient } from './client.ts';
import type { RuntimeProcessOptions } from './launch.ts';
import type { DeepSeekHarnessOptions, HarnessNotification, RunResult, SdkPromptContentBlock } from './types.ts';
/**
 * Reusable SDK for running DeepSeek Harness agent turns in a runtime
 * subprocess. The subprocess starts lazily on first use and stays owned by
 * this instance until {@link close}; always close (or `await using`) so the
 * child is reaped.
 */
export declare class DeepSeekHarness implements AsyncDisposable {
    private clientInstance;
    private readonly createClient;
    private readonly cwd;
    private readonly provider;
    private readonly model;
    private readonly reasoningEffort;
    private readonly maxTokens;
    private initialized;
    private closed;
    /** @param options - dsh launch configuration plus the session route, effort, and output cap. */
    constructor(options?: DeepSeekHarnessOptions);
    /**
     * The underlying JSON-RPC client (exposed for low-level access). A failed
     * handshake swaps in a fresh instance only after cleanup proves the runtime
     * exited; cleanup failure retains this client, so do not cache it across a
     * failed {@link start}.
     * @returns the client currently owning the runtime subprocess.
     */
    get client(): HarnessClient;
    /**
     * Start the subprocess and perform the `initialize` handshake once. On
     * failure, successful SDK-owned cleanup reaps the runtime and installs a
     * fresh client (`HarnessClient.close` is permanent), so a later call retries
     * with a new subprocess unless {@link close} already ended this harness. If
     * cleanup also fails, rejects with an `AggregateError` whose ordered errors
     * preserve both causes and retains the failed client rather than spawning
     * alongside a process whose exit was not proved.
     * @returns settlement of the (memoized) handshake.
     */
    start(): Promise<void>;
    /**
     * Open a session handle (no wire traffic; the runtime creates the session
     * on its first prompt).
     * @param sessionId - explicit id to reuse; omitted mints a fresh one.
     * @returns the session handle.
     */
    session(sessionId?: string): HarnessSession;
    /**
     * Run one prompt on a fresh (or named) session.
     * @param input - prompt text, or content blocks sent verbatim.
     * @param options - optional session id and per-notification observer.
     * @returns the owned activity interval.
     */
    run(input: string | SdkPromptContentBlock[], options?: RunOptions): Promise<RunResult>;
    /**
     * Shut down and reap the runtime subprocess. Idempotent and terminal —
     * a closed harness no longer retries a failed handshake.
     * @returns settlement of the complete teardown.
     */
    close(): Promise<void>;
    /**
     * `await using` support: {@link close}.
     * @returns settlement of the teardown.
     */
    [Symbol.asyncDispose](): Promise<void>;
}
/** Construct the high-level API against a generic process for package-local fake-runtime tests. */
export declare function createProcessDeepSeekHarness(runtime: RuntimeProcessOptions, options?: DeepSeekHarnessOptions): DeepSeekHarness;
/** Per-run options: target session and streaming observer. */
export interface RunOptions {
    /** Session id to run on; omitted mints a fresh session per call. */
    sessionId?: string;
    /** Observer invoked with every notification for this session tree, in wire order. */
    onNotification?: (notification: HarnessNotification) => void;
}
/**
 * One SDK session: a stable id plus owned activity intervals.
 */
export declare class HarnessSession {
    readonly harness: DeepSeekHarness;
    readonly id: string;
    /**
     * @param harness - the owning harness (supplies the client and handshake).
     * @param id - the wire session id this handle runs on.
     */
    constructor(harness: DeepSeekHarness, id: string);
    /**
     * Queue one prompt, then observe the whole session through its next idle.
     * @param input - prompt text, or content blocks sent verbatim.
     * @param options - optional per-notification observer.
     * @returns the owned activity interval; rejects on transport loss, timeout,
     * or a protocol error.
     */
    run(input: string | SdkPromptContentBlock[], options?: Pick<RunOptions, 'onNotification'>): Promise<RunResult>;
}
/**
 * Normalize run input: a string becomes one text block; blocks pass verbatim.
 * @param input - prompt text or content blocks.
 * @returns the content blocks to send.
 */
export declare function normalizeInput(input: string | SdkPromptContentBlock[]): SdkPromptContentBlock[];
/**
 * Extract the concatenated text of the last assistant message.
 * @param events - the activity interval's `session.event` payloads in wire order.
 * @returns the final response text, or `''` when no assistant message exists.
 */
export declare function finalResponse(events: SessionEvent[]): string;
//# sourceMappingURL=api.d.ts.map