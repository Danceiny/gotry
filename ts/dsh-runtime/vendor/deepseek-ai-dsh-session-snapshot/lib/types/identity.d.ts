/** Relationship-preserving identity redaction for committed session snapshots. */
/**
 * Replace volatile opaque ids while preserving equality relationships across a parent and its child logs.
 * @param logs - one scenario's primary-first session JSONL fixtures.
 * @returns compact JSONL with typed first-seen identity tokens.
 */
export declare function redactSessionSnapshotIds(logs: readonly string[]): string[];
//# sourceMappingURL=identity.d.ts.map