/**
 * Scriptable OpenAI-compatible HTTP/SSE server for transport, protocol, and
 * semantic-empty LLM recovery tests. Each accepted chat-completions request
 * consumes one behavior; the server never retries or interprets harness policy.
 *
 * @module @deepseek-ai/dsh-llm-mock-server
 */
import type { IncomingHttpHeaders } from 'node:http';
/** Request-scoped behaviors accepted by {@link startMockLlmServer}. */
export declare const MOCK_LLM_BEHAVIORS: readonly ["connection_reset", "stream_disconnect", "empty", "empty_body", "stream_eof", "partial_eof", "partial_disconnect", "stall", "malformed_json", "malformed_event", "wrong_content_type", "rate_limit", "server_error", "service_unavailable", "auth_error", "invalid_request", "context_overflow", "quota_exceeded", "success", "reasoning_success", "tool_call_success", "max_tokens", "slow_success", "random"];
/** One scripted mock behavior name; `random` selects a concrete behavior per request. */
export type MockLlmBehavior = typeof MOCK_LLM_BEHAVIORS[number];
/** One concrete request behavior after resolving a `random` script entry. */
export type ConcreteMockLlmBehavior = Exclude<MockLlmBehavior, 'random'>;
/** Relative non-negative weights for random request behavior selection. */
export type MockLlmRandomWeights = Partial<Record<ConcreteMockLlmBehavior, number>>;
/**
 * Default stress profile for `random`. Weights are configurable test pressure,
 * not a claim about production incident frequency.
 */
export declare const DEFAULT_MOCK_LLM_RANDOM_WEIGHTS: Readonly<MockLlmRandomWeights>;
/** Largest millisecond delay accepted by Node timers without truncation. */
export declare const MAX_MOCK_LLM_TIMER_DELAY_MS = 2147483647;
/** How one accepted request ended at the mock boundary. */
export type MockLlmRequestOutcome = 'completed' | 'reset' | 'stalled' | 'client_closed' | 'server_error';
/** Immutable telemetry emitted when a request starts or reaches an outcome. */
export type MockLlmServerEvent = {
    readonly type: 'request';
    readonly attempt: number;
    readonly scriptBehavior: MockLlmBehavior | 'script_exhausted';
    readonly behavior: ConcreteMockLlmBehavior | 'script_exhausted';
    readonly path: string;
} | {
    readonly type: 'result';
    readonly attempt: number;
    readonly scriptBehavior: MockLlmBehavior | 'script_exhausted';
    readonly behavior: ConcreteMockLlmBehavior | 'script_exhausted';
    readonly outcome: MockLlmRequestOutcome;
    readonly chunksSent: number;
};
/** Captured wire request and its final server-side outcome. */
export interface MockLlmRequestRecord {
    /** One-based accepted chat-completions request number. */
    readonly attempt: number;
    /** Script entry consumed for this request before random resolution. */
    readonly scriptBehavior: MockLlmBehavior | 'script_exhausted';
    /** Concrete behavior selected for this request, or exhaustion after the configured script. */
    readonly behavior: ConcreteMockLlmBehavior | 'script_exhausted';
    /** Original request path, including a `/v1` prefix when the client supplied one. */
    readonly path: string;
    /** Detached request headers. */
    readonly headers: Readonly<IncomingHttpHeaders>;
    /** Parsed JSON request body. */
    readonly body: unknown;
    /** Number of SSE `data:` events handed to Node before the outcome. */
    chunksSent: number;
    /** Final server-side outcome; absent while a stalled request remains open. */
    outcome?: MockLlmRequestOutcome;
}
/** Configuration for one mock server instance. */
export interface MockLlmServerOptions {
    /** Loopback host by default. */
    readonly host?: string;
    /** TCP port; zero requests an OS-assigned port. */
    readonly port?: number;
    /** Optional exact bearer token; omission accepts any authorization header. */
    readonly apiKey?: string;
    /** Ordered request behaviors; exhaustion fails loud unless `repeatLast` is true. */
    readonly sequence: readonly MockLlmBehavior[];
    /** Reuse the final behavior after the sequence is consumed. */
    readonly repeatLast?: boolean;
    /** Optional deterministic unsigned 32-bit seed; omission generates and exposes one. */
    readonly randomSeed?: number;
    /** Relative weights used whenever a script entry is `random`. */
    readonly randomWeights?: Readonly<MockLlmRandomWeights>;
    /** Complete text returned by success-shaped behaviors. */
    readonly successText?: string;
    /** Text emitted before partial EOF/reset behaviors terminate. */
    readonly partialText?: string;
    /** Reasoning text emitted by `reasoning_success`. */
    readonly reasoningText?: string;
    /** Unicode code-point count per text or reasoning SSE delta. */
    readonly chunkSize?: number;
    /** Inter-chunk delay for `slow_success`, in milliseconds. */
    readonly chunkDelayMs?: number;
    /** Delay after headers/deltas before a forced disconnect, in milliseconds. */
    readonly disconnectDelayMs?: number;
    /** Provider retry delay; the wire `Retry-After` value rounds up to whole seconds. */
    readonly retryAfterMs?: number;
    /** Optional provider request id returned on HTTP failures. */
    readonly requestId?: string;
    /** Tool name emitted by `tool_call_success`. */
    readonly toolName?: string;
    /** Raw JSON arguments emitted by `tool_call_success`. */
    readonly toolArguments?: string;
    /** Optional observer for JSONL CLI telemetry; observer failures never affect wire behavior. */
    readonly onEvent?: (event: MockLlmServerEvent) => void;
}
/** Running mock server and captured request state. */
export interface MockLlmServer {
    /** Base URL without `/v1`; both root and `/v1` chat-completions paths are accepted. */
    readonly baseURL: string;
    /** Actual bound port, including an OS-assigned value. */
    readonly port: number;
    /** Seed used for random behavior selection, including the generated default. */
    readonly randomSeed: number;
    /** Live request records in arrival order. */
    readonly requests: readonly MockLlmRequestRecord[];
    /** Stop accepting requests and force-close stalled/streaming connections; idempotent. */
    close(): Promise<void>;
}
/**
 * Start a local chat-completions server that consumes one configured behavior
 * per accepted request. Only a `POST` path ending in `/chat/completions` consumes the script;
 * invalid routes, methods, authorization, and JSON receive ordinary 4xx
 * responses. Closing the handle terminates stalled connections.
 *
 * @param options - listener, script, response content, timing, and telemetry options.
 * @returns the listening handle after the port is bound.
 */
export declare function startMockLlmServer(options: MockLlmServerOptions): Promise<MockLlmServer>;
//# sourceMappingURL=index.d.ts.map