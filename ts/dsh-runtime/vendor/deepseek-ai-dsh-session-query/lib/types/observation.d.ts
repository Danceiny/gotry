/** Shared live/prepared observations for Session page and lifecycle consumers. */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence';
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection';
/** One exact immutable Session cut retained for the caller's read lifetime. */
export interface SessionObservation extends Disposable {
    /** Whether the cut came from an attached Session or a retained preparation. */
    readonly source: 'live' | 'prepared';
    /** Immutable Session identity metadata. */
    readonly header: SessionHeader;
    /** Immutable contiguous events at {@link cursor}. */
    readonly events: readonly SessionEvent[];
    /** Last observed event seq, or -1 for an empty log. */
    readonly cursor: number;
    /** Durable source revision for a cold prepared observation. */
    readonly revision?: SessionPersistenceRevision;
    /** Exact projection baseline at {@link cursor}, when the registry is mounted. */
    readonly projections?: ProjectionSnapshot;
    /**
     * Retain the same immutable cut for another Host owner.
     * @returns an independently disposable lease over this observation.
     */
    retain(): SessionObservation;
}
/** Projection work and cancellation requested for one exact observation. */
export interface SessionObservationOptions {
    /** Optional cancellation while resolving a cold source. */
    readonly signal?: AbortSignal;
    /** Whether to compute every projection or leave projection state untouched. */
    readonly projectionMode?: 'all' | 'none';
}
/** Builds point observations without a corpus listing preflight. */
export declare class SessionObservationReader {
    private readonly ctx;
    /** @param ctx - context carrying Session and optional persistence/projection services. */
    constructor(ctx: Context);
    /**
     * Observe one live-preferred Session and retain a cold preparation until disposal.
     * @param sessionId - logical Session identity.
     * @param options - cancellation and all-or-none projection computation for this read.
     * @returns one exact immutable observation.
     */
    read(sessionId: SessionId, options?: SessionObservationOptions): Promise<SessionObservation>;
    private live;
    private preparedProjections;
}
//# sourceMappingURL=observation.d.ts.map