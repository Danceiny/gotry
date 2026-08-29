/**
 * Shared cancellation helpers for the local LSP provider's host-I/O, queue, and protocol phases.
 * @module @deepseek-ai/dsh-lsp-stdio/abort
 */
/**
 * Build an abort Error carrying the signal's reason and preserving timeout classification.
 * @param signal - the aborted signal whose reason to surface.
 * @returns the timeout reason if present, else the Error reason, else a generic aborted Error.
 */
export declare function abortError(signal: AbortSignal): Error;
/**
 * Throw the signal's classified abort error when it has already fired.
 * @param signal - the optional query cancellation signal.
 */
export declare function throwIfAborted(signal?: AbortSignal): void;
/**
 * Await work while allowing a query signal to abandon its wait; the underlying work keeps its own
 * handlers and continues to its owner-defined quiescence boundary.
 * @param work - the owned asynchronous work.
 * @param signal - optional query cancellation.
 * @returns the work result, or a rejection carrying the classified abort reason.
 */
export declare function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T>;
//# sourceMappingURL=abort.d.ts.map