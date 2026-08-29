/** Observable contiguous Session event window consumed by domain assemblers. */
import { type ObservableSnapshot } from '@deepseek-ai/dsh-client-store';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import type { ChunkRowEvent } from '../../types.ts';
/** Standard Session event or compact historical Assistant run. */
export type SessionEventLike = SessionEvent | ChunkRowEvent;
/** Client history entry retaining its coarse transport discriminator. */
export type SessionEventLikeEntry = {
    readonly type: 'event';
    readonly event: SessionEvent;
} | {
    readonly type: 'chunks';
    readonly event: ChunkRowEvent;
};
/** Scalar live entry accepted by append-only Client paths. */
export type SessionLiveEventEntry = Extract<SessionEventLikeEntry, {
    readonly type: 'event';
}>;
/** Exact delta that produced the latest event-window revision. */
export type SessionEventChange = {
    readonly kind: 'replace';
    readonly entries: readonly SessionEventLikeEntry[];
} | {
    readonly kind: 'prepend';
    readonly entries: readonly SessionEventLikeEntry[];
} | {
    readonly kind: 'append';
    readonly entries: readonly SessionLiveEventEntry[];
};
/** Current contiguous event window and its latest synchronous delta. */
export interface SessionEventWindow {
    readonly entries: readonly SessionEventLikeEntry[];
    readonly hasMore: boolean;
    readonly revision: number;
    readonly change: SessionEventChange;
}
/** Conversation-facing event source exposed by one Session binding. */
export type SessionEventSource = ObservableSnapshot<SessionEventWindow>;
/** Session-owned event feed; every accepted window mutation publishes synchronously. */
export declare class MutableSessionEventSource implements SessionEventSource {
    private readonly listeners;
    private window;
    private snapshot;
    /** @returns the cached event-window snapshot. */
    getSnapshot(): SessionEventWindow;
    /**
     * Subscribe to synchronous window publication.
     * @param listener - invalidation callback.
     * @returns unsubscribe function.
     */
    subscribe(listener: () => void): () => void;
    /**
     * Replace the complete contiguous window.
     * @param entries - complete window.
     * @param hasMore - whether older history remains.
     */
    replace(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void;
    /**
     * Prepend one older contiguous page.
     * @param entries - newly loaded older entries.
     * @param hasMore - whether still older history remains.
     */
    prepend(entries: readonly SessionEventLikeEntry[], hasMore: boolean): void;
    /**
     * Append one contiguous live entry.
     * @param entry - live tail entry.
     */
    append(entry: SessionLiveEventEntry): void;
    private publish;
}
//# sourceMappingURL=events.d.ts.map