import type { SnapshotSerializer } from 'vitest';
/**
 * The serializer plugin. Matches DOM elements whose subtree carries a scoped
 * class or svg internals; serializes a normalized clone, which no longer
 * matches, so printing falls through to the built-in DOM element serializer.
 */
export declare const domSnapshotSerializer: SnapshotSerializer;
/**
 * Register {@link domSnapshotSerializer} with vitest's expect (idempotent).
 * SlotTestRuntime.create() calls this; specs that snapshot DOM outside the
 * runtime import and call it themselves.
 */
export declare function registerDomSnapshotSerializer(): void;
//# sourceMappingURL=snapshot.d.ts.map