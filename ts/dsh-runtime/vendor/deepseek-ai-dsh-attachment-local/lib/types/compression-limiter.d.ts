/** Instance-owned concurrency bound for native image transformations. */
/** FIFO limiter for asynchronous compression work. */
export declare class CompressionLimiter {
    readonly concurrency: number;
    private active;
    private readonly waiting;
    /**
     * @param concurrency - positive maximum number of active tasks.
     */
    constructor(concurrency: number);
    /**
     * Run one task after an instance slot becomes available.
     * @param task - compression operation occupying one slot until settlement.
     * @returns the task result.
     */
    run<T>(task: () => Promise<T>): Promise<T>;
}
//# sourceMappingURL=compression-limiter.d.ts.map