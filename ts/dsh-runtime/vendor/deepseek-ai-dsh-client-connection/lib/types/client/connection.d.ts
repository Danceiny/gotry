/** Stable Host facts delivered by one established Remote event generation. */
export interface ConnectionHostInfo {
    /** Host account home used only to abbreviate displayed filesystem paths. */
    readonly home: string;
}
/** One successfully established Host generation. */
export interface ConnectionGeneration {
    /** Monotone generation number within this Client runtime. */
    readonly id: number;
    /** Host facts carried by this generation's opening frame. */
    readonly host: ConnectionHostInfo;
}
/** Reconnect/backoff tunables (deployment-varying — no hardcoded tunables; these become the
 *  future `ctx.connection` plugin's Config). All fields optional; defaults below. */
export interface ConnectionConfig {
    /** First-retry backoff cap in ms (jittered: actual delay is cap/2..cap). */
    backoffBaseMs?: number;
    /** Exponential growth factor per consecutive failed attempt. */
    backoffFactor?: number;
    /** Upper bound for the backoff cap in ms. */
    backoffMaxMs?: number;
    /** Maximum wait for the registered generation source's ready signal. */
    generationReadyTimeoutMs?: number;
}
/** Coarse connection state for the UI: 'connected' after each generation's handshake,
 *  'reconnecting' the moment the generation fails (covers the whole backoff+retry span). */
export type ConnectionState = 'connected' | 'reconnecting';
/** Connection-generation callbacks owned by API Gateway. */
export interface ConnectionSinks {
    /** After the generation source reports ready, first connect included. */
    onConnected?: (host: ConnectionHostInfo) => void;
    /** Coarse state transitions (deduplicated: fires only on change). The initial pre-connect
     *  span reports nothing — the UI treats "no state yet" as connecting, not as an outage. */
    onStateChange?: (state: ConnectionState) => void;
}
/**
 * One long-lived source defining a Connection generation. The source must
 * attach its incremental listeners before calling `ready`, then remain pending
 * until the generation is lost or `signal` aborts.
 * @param signal - cancellation for the current generation.
 * @param ready - one-shot report that incremental delivery is attached.
 * @returns a promise settling only when this generation ends or fails.
 */
export type ConnectionGenerationSource = (signal: AbortSignal, ready: (host: ConnectionHostInfo) => void) => Promise<void>;
/**
 * Opens the registered generation source, reconnecting with exponential backoff on loss.
 * State (generation/attempt) is instance-private, never in the store.
 * Sink exceptions do not kill the generation loop.
 */
export declare class ConnectionController {
    private readonly source;
    private readonly sinks;
    private generation;
    private attempt;
    private current;
    private running;
    private lastState;
    private readonly config;
    constructor(source: ConnectionGenerationSource, sinks?: ConnectionSinks, config?: ConnectionConfig);
    /** Idempotent: begin the connect/pump/reconnect loop. */
    start(): void;
    /** Stop the loop and abort the current generation source. */
    stop(): void;
    private backoffDelay;
    /** Read through a method: stop() flips the flag across awaits, so narrowing from the loop condition must not stick. */
    private isRunning;
    /** Re-read both mutable liveness guards after a potentially reentrant sink. */
    private isGenerationActive;
    private loop;
    /** Deduplicated state emission (sink isolation applies). */
    private emitState;
    /** Sink exception isolation: a business-layer throw is logged only, never affecting pump or reconnect semantics. */
    private callSink;
}
//# sourceMappingURL=connection.d.ts.map