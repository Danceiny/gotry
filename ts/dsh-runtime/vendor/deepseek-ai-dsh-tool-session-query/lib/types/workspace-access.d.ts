/**
 * Caller identity, workspace authorization, and visible lineage projection.
 *
 * @module @deepseek-ai/dsh-tool-session-query/workspace-access
 */
import type { Context } from '@deepseek-ai/cordis';
import { type SessionEvent, type SessionHeader, type SessionId as SessionIdValue } from '@deepseek-ai/dsh-session';
import type { SessionLineageNode, SessionRecord } from '@deepseek-ai/dsh-session-query';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
interface Caller {
    readonly id: SessionIdValue;
    readonly header: SessionHeader;
    readonly events: readonly SessionEvent[];
}
interface TitleView {
    readonly text: string;
    readonly unavailableCode?: string;
}
interface CompleteTitleMap extends ReadonlyMap<SessionIdValue, TitleView> {
    get(id: SessionIdValue): TitleView;
}
interface AuthorizedDescendant {
    readonly record: SessionRecord;
    readonly descendants: Array<AuthorizedDescendant | null>;
}
interface DescendantVisit {
    readonly node: AuthorizedDescendant | null;
    readonly depth: number;
    readonly next: DescendantVisit | undefined;
}
declare function callerOf(exec: ToolRunContext): Caller;
declare function targetId(args: {
    readonly session_id?: string;
}, caller: Caller): SessionIdValue;
declare function authorizeTarget(ctx: Context, caller: Caller, target: SessionIdValue, signal: AbortSignal): Promise<void>;
declare function recordAuthorized(record: SessionRecord, caller: Caller): boolean;
declare function assertObservedTargetAuthorized(caller: Caller, target: SessionIdValue, observed: SessionHeader): void;
declare function authorizeSessionIds(ctx: Context, caller: Caller, ids: readonly SessionIdValue[], signal: AbortSignal): Promise<ReadonlySet<SessionIdValue>>;
declare function readTitles(ctx: Context, caller: Caller, ids: readonly SessionIdValue[], signal: AbortSignal): Promise<CompleteTitleMap>;
declare function readTitle(ctx: Context, caller: Caller, id: SessionIdValue, signal: AbortSignal): Promise<TitleView>;
declare function authorizeDescendants(nodes: readonly SessionLineageNode[], caller: Caller): Array<AuthorizedDescendant | null>;
declare function visitDescendants(nodes: readonly (AuthorizedDescendant | null)[]): Generator<DescendantVisit>;
declare function descendantIds(nodes: readonly (AuthorizedDescendant | null)[]): SessionIdValue[];
declare function titleText(view: TitleView): string;
/** Workspace-scoped caller authorization, title access, and lineage projection. */
export declare const workspaceAccess: {
    callerOf: typeof callerOf;
    targetId: typeof targetId;
    authorizeTarget: typeof authorizeTarget;
    recordAuthorized: typeof recordAuthorized;
    assertObservedTargetAuthorized: typeof assertObservedTargetAuthorized;
    authorizeSessionIds: typeof authorizeSessionIds;
    readTitles: typeof readTitles;
    readTitle: typeof readTitle;
    authorizeDescendants: typeof authorizeDescendants;
    visitDescendants: typeof visitDescendants;
    descendantIds: typeof descendantIds;
    titleText: typeof titleText;
};
export {};
//# sourceMappingURL=workspace-access.d.ts.map