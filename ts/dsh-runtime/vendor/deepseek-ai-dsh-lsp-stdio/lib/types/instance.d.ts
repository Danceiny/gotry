/**
 * One language-server instance: a connection plus the initialize handshake, the serialized abortable
 * query queue, the transient `didOpen`→request→`didClose` lifecycle, and bounded teardown. One
 * instance owns one `(provider id, canonical workspace)` process. Queries serialize through a single
 * queue so a cancellation that fails to stop the server can terminate it without killing unrelated
 * work; distinct instances run in parallel.
 * @module @deepseek-ai/dsh-lsp-stdio/instance
 */
import type { LspProviderQuery, LspQueryResult } from '@deepseek-ai/dsh-lsp';
import type { ConnectionSpawner, ConnectionSpec, ConnectionWriter } from './connection.ts';
import type { HostSource } from './host.ts';
/** Everything an instance needs beyond the connection spec. */
export interface InstanceSpec extends ConnectionSpec {
    /** Canonical workspace file URI supplied by the filesystem provider. */
    readonly workspaceUri: string;
    /** Static `initialize` options forwarded to the server. */
    readonly initializationOptions: unknown;
    /** Graceful `shutdown`/`exit` budget before escalation (ms). */
    readonly shutdownTimeoutMs: number;
}
/**
 * A single initialized server process. Not exported as a provider — the provider single-flights and
 * pools these. `query()` serializes; `dispose()` rejects queued work and tears the process down.
 */
export declare class LspInstance {
    private readonly spec;
    private readonly connection;
    private capabilities;
    /** The serialization tail: each query awaits the prior one, so lifecycles never interleave. */
    private queue;
    private disposed;
    /** The one teardown transaction shared by abort, failure, and explicit disposal. */
    private teardownPromise;
    /** Set once the process closes, so the pool can synchronously skip a dead instance. */
    private processClosed;
    /** Populated once `initialize` succeeds; a failed handshake rejects every query. */
    private readonly ready;
    /**
     * @param spec - the launch, initialize, and teardown parameters.
     * @param spawner - the subprocess seam's spawn function.
     * @param writer - optional connection writer used by transport conformance tests.
     */
    constructor(spec: InstanceSpec, spawner: ConnectionSpawner, writer?: ConnectionWriter);
    /** Synchronous liveness check: true once the process has closed or the instance was disposed. */
    get dead(): boolean;
    /**
     * Test whether a caught query error came from this instance's transport.
     * @param error - error caught by the provider.
     * @returns `true` only for the connection's retained fatal transport cause.
     */
    isTransportFailure(error: unknown): boolean;
    /**
     * Run one query through the serialized queue.
     * @param request - the resolved provider query.
     * @param source - the pre-validated, already-read host source (the provider reads before spawning).
     * @param signal - optional cancellation for this query's full lifecycle.
     * @returns the normalized result.
     */
    query(request: LspProviderQuery, source: HostSource, signal?: AbortSignal): Promise<LspQueryResult>;
    private initialize;
    private runQuery;
    private sendRequest;
    /**
     * Race a pending request against abort. On abort, send `$/cancelRequest` and give the server a
     * bounded grace to acknowledge; if it does not settle in time, invalidate and tear down the
     * instance so the still-active request cannot overlap the next queued query's document lifecycle.
     */
    private raceAbort;
    private normalize;
    private answerServerRequest;
    /**
     * Reject queued work, attempt graceful `shutdown`/`exit`, then escalate SIGTERM→SIGKILL, awaiting
     * process close so nothing outlives disposal.
     */
    dispose(): Promise<void>;
    /** Publish disposal once and make every caller await the same quiescence boundary. */
    private startTeardown;
    private tearDown;
    /** Best-effort LSP `shutdown`/`exit`, including process close, bounded by `signal`. */
    private gracefulShutdown;
    /**
     * Terminate the tree (the seam escalates SIGTERM→`killGraceMs`→SIGKILL),
     * then await leader and helper exit. The awaits are unbounded on purpose:
     * the seam's escalation already committed to SIGKILL, so quiescence — not
     * another timer — is the postcondition disposal owes its callers.
     */
    private forceTerminate;
}
//# sourceMappingURL=instance.d.ts.map