/**
 * A JSON-RPC endpoint over one language server spawned through the subprocess
 * capability. Owns id correlation, outbound requests/notifications, and inbound
 * server→client requests: it answers `workspace/configuration` from static
 * config, and rejects `workspace/applyEdit` (this host never applies edits or
 * runs commands). It caps stderr, surfaces framing/decoder failures as a
 * fatal close, and exposes tree-scoped termination through the handle so the
 * instance owns teardown; group/tree mechanics live in the subprocess
 * Service Provider.
 * @module @deepseek-ai/dsh-lsp-stdio/connection
 */
import type { Writable } from 'node:stream';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
/** How to launch the server and answer its config requests. */
export interface ConnectionSpec {
    /** The resolved absolute executable path (no shell). */
    readonly command: string;
    /** Arguments passed to the executable. */
    readonly args: readonly string[];
    /** The child's working directory (the canonical workspace). */
    readonly cwd: string;
    /** Explicit child environment overrides; the subprocess provider owns its ambient scrub. */
    readonly env: Record<string, string>;
    /** Largest single framed message accepted from the server. */
    readonly maxMessageBytes: number;
    /** Largest stderr tail retained for diagnostics. */
    readonly maxStderrBytes: number;
    /**
     * The subprocess spec's `graceMs`: the SIGTERM→SIGKILL window of
     * {@link LspConnection.terminate}'s escalation, and the bound for draining
     * pipes a surviving helper still holds after the server exits.
     */
    readonly killGraceMs: number;
    /** Static answer to every `workspace/configuration` item. */
    readonly configuration: unknown;
}
/**
 * Write one JSON-RPC message to the child stdin.
 * @param stdin - the spawned server stdin.
 * @param message - the unencoded JSON-RPC message.
 * @param done - callback that reports asynchronous stream settlement.
 */
export type ConnectionWriter = (stdin: Writable, message: unknown, done: (error?: Error | null) => void) => void;
/** Spawn one subprocess for this connection (the provider passes `ctx.subprocess.spawn`). */
export type ConnectionSpawner = (spec: SubprocessSpawnSpec) => SubprocessHandle;
/** A live JSON-RPC endpoint bound to one child process. */
export declare class LspConnection {
    private readonly onServerRequest;
    private readonly writer;
    private readonly handle;
    private readonly stdin;
    private readonly decoder;
    private readonly pending;
    private nextId;
    private closeReason;
    /** Set once the process has fully exited; the instance awaits it during teardown. */
    readonly closed: Promise<void>;
    /**
     * @param spec - how to launch the server and answer its config requests.
     * @param spawner - the subprocess seam's spawn (the provider passes `ctx.subprocess.spawn`).
     * @param onServerRequest - answers a server→client request; rejects to send an error response.
     * @param writer - message writer; tests inject callback failures without relying on OS pipe races.
     */
    constructor(spec: ConnectionSpec, spawner: ConnectionSpawner, onServerRequest: (method: string, params: unknown) => Promise<unknown>, writer?: ConnectionWriter);
    /** The child's pid, or `-1` when the spawn produced no pid (so signalling is a no-op). */
    get pid(): number;
    /** The retained stderr tail, for diagnostics on a failed server. */
    get stderrTail(): string;
    /** Whether the transport has failed even if the child close event has not arrived yet. */
    get failed(): boolean;
    /**
     * Test whether a caught error is this connection's retained fatal transport cause.
     * @param error - error caught by the instance or provider.
     * @returns `true` only when this connection produced that exact failure.
     */
    failedWith(error: unknown): boolean;
    /**
     * Send a request and await its result.
     * @param method - the JSON-RPC method.
     * @param params - the request params.
     * @returns the response result; rejects on an error response, write failure, or close.
     */
    request(method: string, params: unknown): Promise<unknown>;
    /**
     * Send a notification (no id, no response).
     * @param method - the JSON-RPC method.
     * @param params - the notification params.
     * @returns a promise that settles when the framed notification has been written.
     */
    notify(method: string, params: unknown): Promise<void>;
    /**
     * Send a `$/cancelRequest` for an in-flight request id (best-effort; ignores write failure).
     * @param requestId - the numeric id of the request to cancel.
     */
    cancel(requestId: number): void;
    /**
     * The id the NEXT `request()` will use, so the instance can pre-arm a cancel.
     * @returns the numeric id the next request will be assigned.
     */
    peekNextId(): number;
    /** Terminate the server's process tree (the seam's SIGTERM→grace→SIGKILL escalation; idempotent). */
    terminate(): void;
    /**
     * Wait until the owned process tree has exited.
     * @param signal - optional bound for the wait.
     * @returns `true` when the tree exited, or `false` when the signal aborted first.
     */
    waitForProcessTreeExit(signal?: AbortSignal): Promise<boolean>;
    private onStdout;
    private dispatch;
    private handleServerRequest;
    private handleResponse;
    private write;
    /** The exit-close error message, appending the retained stderr tail when the server wrote any. */
    private exitMessage;
    private fail;
    private failAll;
}
//# sourceMappingURL=connection.d.ts.map