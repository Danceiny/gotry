/**
 * Durable projection state for dynamic runtime context.
 * @module @deepseek-ai/dsh-agent-loop/runtime-context
 */
import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm';
import type { Session, UserMessage } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
/** Tracks the last retained runtime-context snapshot without owning its commit. */
export declare class RuntimeContextProjection {
    /** `undefined` means no snapshot ever existed; `null` means none is retained. */
    private retained;
    /**
     * Restore projection state once, then follow authoritative session events.
     * @param ctx - agent-scoped event context.
     * @param session - session receiving projected messages.
     */
    constructor(ctx: Context, session: Session);
    /**
     * Create an uncommitted snapshot only when the retained value differs.
     * @param current - fully rendered dynamic context.
     * @param sections - named contributions that formed the current snapshot.
     * @returns a candidate user message, or `undefined` when no update is needed.
     */
    project(current: string, sections: readonly ContextSnapshotSection[]): UserMessage | undefined;
}
//# sourceMappingURL=runtime-context.d.ts.map