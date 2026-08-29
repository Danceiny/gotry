/**
 * Pure ACP transcript and session-log normalizers. They scrub session ids, run cwd, RPC ids,
 * timestamps, goal lifecycle clocks, and hook duration while preserving semantic payload values.
 * Request-header scrubbers stay composable so one scenario per header class can pin prompt and
 * tool-schema sidecars.
 * @module @deepseek-ai/dsh-session-snapshot/normalize
 */
/**
 * Extract every snapshot-mode spill path from a session log, keyed by spill
 * filename. Used by refresh write-back to keep spill paths stable across runs.
 * @param content - the raw session log text to scan.
 * @returns spill filename → the full matched spill path, last match wins per name.
 */
export declare function extractSnapshotSpillPaths(content: string): Map<string, string>;
/** Inputs the normalizers need to recognize a run's volatile values. */
export interface NormalizeContext {
    /** The session id(s) the run issued — replaced with `{{sessionId}}`. */
    sessionIds: string[];
    /** The generated cwd the run used — replaced with `{{cwd}}`. */
    cwd: string;
    /** Other filesystem spellings of the same cwd (for example Windows short and long paths). */
    cwdAliases?: readonly string[];
}
/** How cwd-rooted path separators are represented after the cwd is tokenized. */
export type CwdPathMode = 'canonical' | 'native';
/** Optional controls shared by stdout and session-log normalization. */
export interface NormalizeOptions {
    /** Use `/` for shared goldens, or preserve captured separators for a platform-specific golden. */
    cwdPathMode?: CwdPathMode;
    /** Keep already-redacted typed ids and arbitrary UUID-like prose unchanged. */
    identityMode?: 'legacy' | 'preserve';
}
/**
 * Store one generated workspace as `{{cwd}}` while retaining every other
 * session value. The caller opts in only for workspaces created under a
 * platform temporary root; explicitly relocated workspaces keep their real
 * path.
 *
 * @param rawLog The raw or refresh-stabilized session JSONL fixture.
 * @returns Compact JSONL whose known cwd spellings become `{{cwd}}`.
 * @throws If a non-empty line is invalid JSON or the session cwd has no basename.
 */
export declare function tokenizeSessionFixtureCwd(rawLog: string): string;
/**
 * Normalize a raw stdout transcript (newline-delimited JSON-RPC frames) into a stable expected output
 * in the same shape as the wire: one compact JSON frame per line (NDJSON), with the JSON-RPC
 * `id` rewritten to a per-transcript sequence (1, 2, 3, …) and all volatile strings scrubbed.
 * Invalid JSON throws, doubling as a protocol-stdout purity check.
 *
 * @param rawStdout The captured stdout bytes, decoded utf8.
 * @param ctx The run's volatile values to scrub.
 * @param options Separator output controls; shared canonical paths are the default.
 * @returns The normalized NDJSON transcript, one frame per line.
 */
export declare function normalizeStdout(rawStdout: string, ctx: NormalizeContext, options?: NormalizeOptions): string;
/**
 * Normalize a session JSONL log into a stable expected output: the header line's
 * volatile fields (`createdAt`, `id`, `cwd`) are zeroed/scrubbed, ordinary
 * event `time`, packed-row `time0`, and goal-change lifecycle clock values are
 * zeroed, and all volatile strings are scrubbed. Projected inputs remain
 * projected. Packed `data.dt` gaps are normalized even when the projected row
 * omits its `time0` anchor.
 * Output is JSONL in the same shape as the input — one compact record per
 * line.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @param ctx The run's volatile values to scrub.
 * @param options Separator output controls; shared canonical paths are the default.
 * @returns The normalized JSONL log, one record per line.
 */
export declare function normalizeSessionLog(rawLog: string, ctx: NormalizeContext, options?: NormalizeOptions): string;
/**
 * Normalize and project persisted session JSONL for a committed fixture.
 * This composes ordinary log normalization with request-header scrubbing and
 * persistence-envelope projection, then packs the logical event stream into a
 * canonical layout independent of persistence flush boundaries.
 *
 * @param rawLog - persisted or already-projected session JSONL.
 * @param ctx - the run's volatile values to scrub.
 * @param options - separator output controls.
 * @returns normalized committed session snapshot JSONL.
 */
export declare function normalizeSessionSnapshot(rawLog: string, ctx: NormalizeContext, options?: NormalizeOptions): string;
/**
 * Normalize one scenario's primary and child logs with shared typed identity redaction.
 * @param rawLogs - primary-first persisted or projected session JSONL.
 * @param ctx - generated cwd spellings and other volatile run facts.
 * @param options - separator controls; relationship-preserving identity mode is mandatory.
 * @returns normalized session fixtures in input order.
 */
export declare function normalizeSessionSnapshots(rawLogs: readonly string[], ctx: NormalizeContext, options?: Omit<NormalizeOptions, 'identityMode'>): string[];
/**
 * Replace system-prompt content in request headers with `{{system}}` tokens
 * while retaining field presence.
 * Other header content stays verbatim, so a header-pinning fixture can keep
 * its complete tool schemas while every JSONL fixture omits the prompt text.
 * Lines without a system payload pass through byte-for-byte; the transform is
 * idempotent.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @returns The JSONL with system-prompt content tokenized.
 */
export declare function scrubSystemPrompts(rawLog: string): string;
/**
 * Replace tool schemas in full request-header snapshots with `{{tools}}`
 * tokens while retaining field presence. System prompts and session-prefix
 * messages stay verbatim so pinning fixtures can move only schema bulk into
 * their dedicated JSON sidecar. Lines without a tool payload pass through
 * byte-for-byte; the transform is idempotent.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @returns The JSONL with tool-schema content tokenized.
 */
export declare function scrubToolSchemas(rawLog: string): string;
/**
 * Replace all bulky request-header content in a session JSONL with stable
 * tokens. This includes the system-prompt fields handled by
 * {@link scrubSystemPrompts}, tool schemas, and session-prefix messages. It
 * keeps prefix message counts, field presence, config, and reason. Lines
 * without content to scrub pass through byte-for-byte, and the transform is
 * idempotent.
 *
 * @param rawLog The raw session `.jsonl` content.
 * @returns The JSONL with all header bulk tokenized, other lines byte-identical.
 */
export declare function scrubRequestHeaders(rawLog: string): string;
/**
 * Project a persisted session log while tokenizing all request-header bulk.
 * Each non-empty line is parsed at most once; the session header stays
 * byte-identical. Body records omit their persistence-only envelopes, and
 * request-header payloads are tokenized.
 *
 * @param rawLog - persisted or already-projected session JSONL.
 * @returns committed snapshot JSONL with request headers tokenized.
 */
export declare function scrubSessionSnapshot(rawLog: string): string;
//# sourceMappingURL=normalize.d.ts.map