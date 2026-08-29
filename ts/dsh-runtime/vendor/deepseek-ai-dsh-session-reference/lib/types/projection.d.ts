/** Current-surface projection and byte-bounded rendering. */
import type { SessionSurfaceSnapshot } from '@deepseek-ai/dsh-session-query';
import type { ReferencedConversationItem } from './types.ts';
/** Snapshot data serialized inside the untrusted prompt. */
export interface ReferencedSessionData {
    sessionId: string;
    label: string;
    cwd: string | null;
    capturedThroughSeq: number | null;
    conversation: ReferencedConversationItem[];
}
/** Retention facts stored beside the durable context. */
export interface ReferenceRetentionStats {
    compacted: boolean;
    originalMessages: number;
    retainedMessages: number;
    omittedMessages: number;
    omittedBytes: number;
    truncated: boolean;
}
/**
 * Fit one projected snapshot into an exact rendered JSON-object byte cap.
 * @param snapshot - current-surface source observation.
 * @param label - host-provided display label serialized with the source.
 * @param maxBytes - maximum UTF-8 bytes for the serialized data object.
 * @returns retained data and stats, or `undefined` when fixed data cannot fit.
 */
export declare function retainReferencedSession(snapshot: SessionSurfaceSnapshot, label: string, maxBytes: number): {
    data: ReferencedSessionData;
    stats: ReferenceRetentionStats;
} | undefined;
//# sourceMappingURL=projection.d.ts.map