/** Browser owner for the Gateway multiplexed Remote stream socket. */
/** One Host-reported Remote stream failure. */
export declare class RemoteStreamError extends Error {
    /** Stable carrier or Gateway error category. */
    readonly code: string;
    /** Host-provided structured failure context. */
    readonly details: object;
    /**
     * @param code - stable Gateway or business error category.
     * @param message - Host-provided failure description.
     * @param details - Host-provided structured failure context.
     */
    constructor(code: string, message: string, details: object);
}
/** Physical Remote stream socket failure that may be retried by a domain transport. */
export declare class RemoteStreamCarrierError extends Error {
    /**
     * @param message - physical carrier failure description.
     * @param options - optional causal error.
     */
    constructor(message: string, options?: ErrorOptions);
}
/** Keep one physical WebSocket and share it among independently cancellable Remote streams. */
export declare class RemoteStreamMuxClient {
    private socket;
    private cancelCandidate;
    private keepAlive;
    private keepAliveAbort;
    private readonly streams;
    private readonly waiters;
    private running;
    private disposed;
    /** Start the persistent physical connection; repeated calls are inert. */
    start(): void;
    /**
     * Open one logical stream on the persistent physical connection.
     * @param endpoint - Typert Remote stream endpoint.
     * @param payload - endpoint request encoded on the wire.
     * @param signal - cancellation for this logical stream.
     * @returns Host items until completion, cancellation, or failure.
     */
    open(endpoint: string, payload: unknown, signal: AbortSignal): AsyncGenerator;
    /**
     * Permanently stop reconnecting, close the physical socket, and fail every active logical stream.
     * @returns once the background connection loop has stopped.
     */
    close(): Promise<void>;
    private connect;
    private waitForSocket;
    private receive;
    private lost;
    private maintain;
    private reconnect;
    private isRunning;
    private failAll;
    private send;
}
//# sourceMappingURL=stream-client.d.ts.map