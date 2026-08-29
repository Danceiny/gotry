/**
 * Low-level JSON-RPC client for a DeepSeek Harness SDK runtime subprocess.
 * {@link HarnessClient} owns the child process: it spawns the runtime, speaks
 * the `@deepseek-ai/dsh-sdk-protocol` wire over the child's stdio, fans
 * server notifications out to subscriptions, and tears the child down to
 * quiescence through a private EOF → SIGTERM → SIGKILL ladder. The design
 * twin is the Python SDK's `HarnessClient` (`python/sdk`); both drive the
 * same runtime protocol. This client runs OUTSIDE any harness context, so it
 * spawns directly rather than through the `dsh-subprocess` service — the
 * seam's documented exception for SDK-managed transports.
 *
 * @module @deepseek-ai/dsh-sdk-client/client
 */
import { type InitializeParams, type InitializeResult, type SdkPromptContentBlock } from '@deepseek-ai/dsh-sdk-protocol';
import { type RuntimeProcessOptions } from './launch.ts';
import type { HarnessClientOptions, HarnessNotification, NotificationFilter } from './types.ts';
/**
 * The runtime subprocess is gone or unusable: it exited, its stdio closed, or
 * it was never launchable. The message carries the exit code and a stderr
 * tail when available.
 */
export declare class TransportClosedError extends Error {
    /** @param message - the failure description, including any stderr tail. */
    constructor(message: string);
}
/** A request exceeded {@link HarnessClientOptions.requestTimeoutMs}. */
export declare class RequestTimeoutError extends Error {
    /** @param message - which method timed out. */
    constructor(message: string);
}
/**
 * The runtime answered outside its documented protocol (for example a
 * `session/prompt` response without `accepted: true`).
 */
export declare class SdkProtocolError extends Error {
    /** @param message - the protocol violation description. */
    constructor(message: string);
}
/** One client-side notification stream returned by {@link HarnessClient.subscribe}. */
export interface NotificationSubscription extends AsyncIterable<HarnessNotification> {
    /**
     * Await the next matching notification.
     * @returns the notification; after the runtime died, drains what was
     * already delivered and then rejects; after {@link close}, rejects
     * immediately (the queue is dropped).
     */
    next(): Promise<HarnessNotification>;
    /**
     * Drain one already-delivered notification without waiting.
     * @returns the next queued notification, or `undefined` when none is queued.
     */
    tryNext(): HarnessNotification | undefined;
    /** Detach from the client; queued items drop and pending waiters reject. */
    close(): void;
}
/**
 * JSON-RPC client for the DeepSeek Harness SDK runtime over subprocess stdio.
 *
 * The subprocess starts lazily on {@link start} and is owned by this instance
 * until {@link close}, which requests protocol `shutdown` and then walks the
 * shared EOF → SIGTERM → SIGKILL dispose ladder to quiescence. There is no
 * wire-level cancel: a timed-out request stays running server-side until the
 * runtime is closed.
 */
export declare class HarnessClient {
    /** Original public dsh launch and timeout options for this client. */
    readonly options: HarnessClientOptions;
    private readonly runtime;
    private child;
    private transport;
    private readonly stderrTail;
    private readonly subscriptions;
    private readonly sessionParents;
    private subscriptionSerial;
    private exitCode;
    private spawnError;
    private streamsSettled;
    private closeTask;
    /** @param options - dsh profile, patch, home, process, environment, and timeout options. */
    constructor(options?: HarnessClientOptions);
    /**
     * Spawn the runtime subprocess and start reading frames. Idempotent while
     * the process is live; rejects reuse after {@link close}.
     */
    start(): void;
    /**
     * Perform the process-wide handshake.
     * @param params - workspace cwd plus the provider/model route.
     * @returns the runtime's wire identity.
     */
    initialize(params: InitializeParams): Promise<InitializeResult>;
    /**
     * Queue one prompt and return its durable inbox identity.
     * @param sessionId - target session; an unknown id creates it.
     * @param contentBlocks - the user message, sent verbatim.
     * @returns the queued message id.
     */
    prompt(sessionId: string, contentBlocks: SdkPromptContentBlock[]): Promise<string>;
    /**
     * Send one JSON-RPC request and await its result.
     * @param method - the wire method name.
     * @param params - the params object; omitted params send `{}`.
     * @param timeoutMs - per-call override of {@link HarnessClientOptions.requestTimeoutMs}.
     * @returns the raw result; rejects with {@link JsonRpcResponseError} on a
     * protocol error response, {@link RequestTimeoutError} on timeout, and
     * {@link TransportClosedError} when the runtime is gone.
     */
    request(method: string, params?: object, timeoutMs?: number): Promise<unknown>;
    /**
     * Subscribe to server notifications.
     * @param filter - optional predicate; omitted means every notification.
     * @returns the subscription handle; close it to stop delivery. After
     * {@link close} or runtime death the handle is born failed — there is no
     * producer left, so `next()` rejects instead of waiting forever.
     */
    subscribe(filter?: NotificationFilter): NotificationSubscription;
    /**
     * Subscribe to one session and the descendants discovered from
     * `subagent.started` lineage edges. The runtime notifies for every session
     * in its context, so this client applies the scope.
     * @param sessionId - the root session id.
     * @returns the filtered subscription handle.
     */
    subscribeSessionTree(sessionId: string): NotificationSubscription;
    /**
     * Shut the runtime down and reap it: a best-effort protocol `shutdown`
     * bounded by `shutdownTimeoutMs`, then the shared stdin-EOF → SIGTERM →
     * SIGKILL ladder until the process actually exited. Idempotent.
     * @returns settlement of the complete teardown.
     */
    close(): Promise<void>;
    private performClose;
    private dispatchNotification;
    private recordSessionRelationship;
    private isDescendantOf;
    private failSubscriptions;
    private appendStderr;
    private settleStreams;
    private closedError;
}
/** Construct the transport against a generic process for package-local fake-runtime tests. */
export declare function createProcessHarnessClient(options: RuntimeProcessOptions): HarnessClient;
/**
 * Whether `value` is a plain JSON object (the wire-boundary shape probe).
 * @param value - the wire value to probe.
 * @returns `true` iff `value` is a non-null, non-array object.
 */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
//# sourceMappingURL=client.d.ts.map