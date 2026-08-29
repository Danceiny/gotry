/**
 * Model text rendering and generic tool-call presentation.
 *
 * @module @deepseek-ai/dsh-tool-session-query/presentation
 */
import { type SessionEventSearchHit, type SessionEventTraceObservation, type SessionEventWindow, type SessionLineageTrace, type SessionRecord, type SessionSearchHit } from '@deepseek-ai/dsh-session-query';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { GenericCallView } from '@deepseek-ai/dsh-tools';
import { workspaceAccess } from './workspace-access.ts';
type TitleView = Awaited<ReturnType<typeof workspaceAccess.readTitle>>;
type CompleteTitleMap = Awaited<ReturnType<typeof workspaceAccess.readTitles>>;
type AuthorizedDescendants = ReturnType<typeof workspaceAccess.authorizeDescendants>;
interface SearchCollection<T> {
    readonly items: T[];
    readonly capped: boolean;
}
interface SessionSearchCallArgs {
    readonly query: string;
}
interface EventSearchCallArgs {
    readonly query: string;
}
interface SessionTargetCallArgs {
    readonly session_id?: string;
}
interface EventTargetCallArgs extends SessionTargetCallArgs {
    readonly seq: number;
}
declare function formatSessionSearch(collected: SearchCollection<SessionSearchHit>, titles: CompleteTitleMap, authorizedParents: ReadonlySet<SessionId>): string;
declare function formatEmptySessionSearch(): string;
declare function formatEventSearch(sessionId: SessionId, title: TitleView, collected: SearchCollection<SessionEventSearchHit>): string;
declare function formatSessionTrace(trace: SessionLineageTrace, ancestors: readonly SessionRecord[], ancestorBoundary: boolean, descendants: AuthorizedDescendants, titles: CompleteTitleMap): string;
declare function formatEventTrace(sessionId: SessionId, title: TitleView, trace: SessionEventTraceObservation): string;
declare function formatEventRead(sessionId: SessionId, title: TitleView, window: SessionEventWindow): string;
declare function presentSessionSearchCall(args: SessionSearchCallArgs): GenericCallView;
declare function presentEventSearchCall(args: EventSearchCallArgs): GenericCallView;
declare function presentSessionTraceCall(args: SessionTargetCallArgs): GenericCallView;
declare function presentEventTargetCall(action: string, args: EventTargetCallArgs): GenericCallView;
/** Text output and call-card presentation for every session-query tool. */
export declare const presentation: {
    formatSessionSearch: typeof formatSessionSearch;
    formatEmptySessionSearch: typeof formatEmptySessionSearch;
    formatEventSearch: typeof formatEventSearch;
    formatSessionTrace: typeof formatSessionTrace;
    formatEventTrace: typeof formatEventTrace;
    formatEventRead: typeof formatEventRead;
    presentSessionSearchCall: typeof presentSessionSearchCall;
    presentEventSearchCall: typeof presentEventSearchCall;
    presentSessionTraceCall: typeof presentSessionTraceCall;
    presentEventTargetCall: typeof presentEventTargetCall;
};
export {};
//# sourceMappingURL=presentation.d.ts.map