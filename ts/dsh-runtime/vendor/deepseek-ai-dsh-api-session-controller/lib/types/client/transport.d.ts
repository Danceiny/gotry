/** Session-specific adapters for Gateway-owned Remote stream lifecycles. */
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol';
import { RemoteJournalStream, RemoteSnapshotStream, RemoteStreamCarrierError, type ClientRemote, type RemoteJournalFrame } from '@deepseek-ai/dsh-api-gateway/client';
import type { SessionAddress, SessionControlFrame, SessionHistoryRecord, SessionPage, SessionPageRequest, SessionProjectionBaseline } from '../types.ts';
import type { SessionEventLikeEntry, SessionLiveEventEntry } from './contract/events.ts';
export { SESSION_SEARCH_RESULT_LIMIT, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS, } from '../types.ts';
/** Pagination fields bound to an already-addressed Session journal. */
export type ClientSessionPageRequest = Omit<SessionPageRequest, 'address' | 'throughSeq'>;
/** Complete generated `ctx.remote.session` namespace. */
export type SessionRemote = ClientRemote['session'];
/** Opening metadata carried only by a follow snapshot, never by loadOlder pages. */
interface SessionJournalPage extends SessionPage {
    readonly projections?: SessionProjectionBaseline;
}
/** One complete publication from the Session journal stream. */
export type SessionJournalChange = {
    readonly type: 'replace' | 'prepend';
    readonly page: SessionJournalPage;
    readonly entries: readonly SessionEventLikeEntry[];
    readonly hasMore: boolean;
} | {
    readonly type: 'append';
    readonly entry: SessionLiveEventEntry;
};
type SessionControlBaselineFrame = Extract<SessionControlFrame, {
    type: 'baseline';
}>;
type SessionControlDeltaFrame = Exclude<SessionControlFrame, SessionControlBaselineFrame>;
/** Gateway-owned control snapshot stream configured for Session frames. */
export type SessionControlStream = RemoteSnapshotStream<SessionControlBaselineFrame, SessionControlDeltaFrame>;
type SessionStreamRemote = Pick<ClientRemote, '$stream' | 'session'>;
/** Domain sinks used by the Host-wide Session control stream. */
export interface SessionControlStreamOptions {
    /** Apply a complete baseline or one later update. */
    readonly accept: (frame: SessionControlFrame) => void;
    /** Observe a retryable carrier loss before reconnection. */
    readonly carrierFailed?: (error: RemoteStreamCarrierError) => void;
    /** Publish a terminal business or protocol failure. */
    readonly failed: (error: unknown) => void;
}
/** Domain sinks used by one addressed Session event journal. */
export interface SessionEventStreamOptions {
    /** Apply one complete event-window change. */
    readonly publish: (change: SessionJournalChange) => void;
    /** Observe a retryable carrier loss before reconnection. */
    readonly carrierFailed?: (error: RemoteStreamCarrierError) => void;
    /** Publish a terminal stream, page, or protocol failure after opening. */
    readonly failed: (error: unknown) => void;
}
/**
 * Create the Host-wide Session control snapshot stream.
 * @param remote - generated Session namespace and Gateway stream factory.
 * @param options - Session state destinations.
 * @returns an unstarted stream owned by the Client Session runtime.
 */
export declare function createSessionControlStream(remote: SessionStreamRemote, options: SessionControlStreamOptions): SessionControlStream;
/** Gateway-owned event journal bound to one ordinary or direct-subagent Session address. */
export declare class SessionEventStream extends RemoteJournalStream<SessionJournalPage, SessionHistoryRecord, number, ClientSessionPageRequest> {
    private readonly remote;
    private readonly address;
    /**
     * @param remote - generated Session namespace and Gateway stream factory.
     * @param address - durable ordinary-Session or direct-subagent address.
     * @param options - Session event-window destinations.
     */
    constructor(remote: SessionStreamRemote, address: SessionAddress, options: SessionEventStreamOptions);
    /** @inheritdoc */
    protected follow(request: ClientSessionPageRequest, signal: AbortSignal): AsyncIterable<RemoteJournalFrame<SessionHistoryRecord, number, SessionJournalPage>>;
    /** @inheritdoc */
    protected readPage(request: ClientSessionPageRequest, throughSeq: number, signal: AbortSignal): Promise<SessionJournalPage>;
    /** @inheritdoc */
    protected repairRequest(request: ClientSessionPageRequest): ClientSessionPageRequest;
}
/**
 * Recover a Host Session failure from a Remote stream terminal error.
 * @param error - value thrown while opening or consuming a Session stream.
 * @returns the Host failure, or `undefined` for carrier and local failures.
 */
export declare function sessionStreamFailure(error: unknown): RemoteFailure | undefined;
//# sourceMappingURL=transport.d.ts.map