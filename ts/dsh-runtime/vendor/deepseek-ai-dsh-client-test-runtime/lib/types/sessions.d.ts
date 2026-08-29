/** Test-owned Session Controller faces over declarative fixtures. */
import type { Context } from '@deepseek-ai/cordis';
import type { AttachmentIdType } from '@deepseek-ai/dsh-attachment';
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client';
import type { AgentContext, ISessions, ProjectionsFace, SessionBinding, SessionFace, SessionListState, SessionEventLikeEntry, SessionLiveEventEntry, SessionSearchResultItem, SessionSnapshot, SessionSummary, SubmissionHandle } from '@deepseek-ai/dsh-api-session-controller/client';
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { SessionFixture, SessionFixtureSnapshot, Stabilizer } from './fixtures.ts';
/**
 * The fixture-backed session face: lifecycle reads delegate to the fixture's
 * snapshot store; Session verbs are fail-loud stubs unless the
 * fixture supplies them (the runtime never fakes behavior a test did not
 * declare — an unstubbed call names itself instead of half-working). Extra
 * fixture methods are grafted verbatim for feature-side casts.
 */
export declare class FixtureSession implements SessionFace {
    readonly sessionId: SessionId;
    private readonly store;
    /** Mutable event source consumed only by Conversation assembly. */
    readonly eventSource: MutableSessionEventSource;
    /**
     * Identity-stable per-key faces over fixture-controlled projection values.
     */
    readonly projections: ProjectionsFace & {
        set(key: string, value: unknown): void;
    };
    /**
     * @param sessionId - host identity (branded view of the fixture id).
     * @param store - Session Controller snapshot store.
     * @param overrides - fixture-declared behavior face, grafted over the stubs.
     */
    constructor(sessionId: SessionId, store: SnapshotStore<SessionFixtureSnapshot>, overrides: Record<string, unknown>);
    /** @returns the fixture Session Controller snapshot (useSession read side). */
    getSnapshot(): SessionSnapshot;
    /**
     * Subscribe to fixture snapshot changes.
     * @param fn - change callback.
     * @returns unsubscribe.
     */
    subscribe(fn: () => void): () => void;
    /**
     * Fail-loud stub; supply `prompt` on the fixture's session face to exercise it.
     * @returns never — always throws.
     */
    prompt(): never;
    /**
     * Minimal local-echo registration: mints an identity without touching the
     * fixture snapshot (submission echoes are client-only presentation state).
     * Supply `beginSubmission` on the fixture's session face to observe echoes.
     * @returns a handle whose abandon is a no-op.
     */
    beginSubmission(): SubmissionHandle;
    private submissionSeq;
    /**
     * Fail-loud stub; supply `readAttachment` on the fixture's session face to exercise it.
     * @param _attachmentId - opaque durable attachment id.
     * @returns never — always throws.
     */
    readAttachment(_attachmentId: AttachmentIdType): never;
    /**
     * Fail-loud stub; supply `updateQueue` on the fixture's session face to exercise it.
     * @returns never — always throws.
     */
    updateQueue(): never;
    /**
     * Fail-loud stub; supply `cancel` on the fixture's session face to exercise it.
     * @returns never — always throws.
     */
    cancel(): never;
    /**
     * Fail-loud stub; supply `command` on the fixture's session face to exercise it.
     * @returns never — always throws.
     */
    command(): never;
    /**
     * Fail-loud stub; supply `loadOlder` on the fixture's session face to exercise it.
     * @returns never — always throws.
     */
    loadOlder(): never;
    /**
     * Fail-loud stub; supply `rename` on the fixture's session face to exercise it.
     * @returns never — always throws.
     */
    rename(): never;
}
/**
 * Sessions test double behind the renderer host and feature injects: owns the
 * list/current observable, scope minting through the production `createScope`,
 * stable Controller bindings, and the session behavior face supplied per
 * fixture. `ui-session` owns standard-source materialization.
 *
 * Implements the same ISessions face features receive as `ctx.sessions`, so
 * a production face change breaks this double at compile time; the extra
 * members (add/updateSessionSnapshot/event-window drivers/setCurrent/remove/
 * behavior/calls/stubs) are bench-only surface.
 */
export declare class TestSessions implements ISessions {
    private readonly stabilize;
    private readonly rootCtx;
    /** The useSessions standard feed (list rows + current selection). */
    readonly list: SnapshotStore<SessionListState>;
    private readonly records;
    /** Calls observed on the service-level face, newest last. */
    readonly calls: {
        method: 'create' | 'open' | 'openSubagent' | 'setSubagentCatalogOpen' | 'refreshSubagents' | 'clear' | 'refresh' | 'search' | 'fork';
        args: unknown[];
    }[];
    /** The wire schema's `session.search` result bound (production parity). */
    readonly searchResultLimit = 20;
    /** Replaceable search behavior (see {@link TestSessions.stubSearch}). */
    private searchStub;
    private createStub;
    /**
     * @param stabilize - the owning runtime's act wrapper.
     * @param rootCtx - the runtime's Cordis root; scope fibers mount under it.
     */
    constructor(stabilize: Stabilizer, rootCtx: Context);
    /**
     * Add a session from a fixture and (by default) make it current.
     * @param fixture - identity + snapshot/summary overrides + behavior face.
     * @param opts - pass `current: false` to add without selecting.
     * @returns the stable session id (branded view of `fixture.id`).
     */
    add(fixture: SessionFixture, opts?: {
        current?: boolean;
    }): Promise<SessionId>;
    /**
     * Update Session Controller lifecycle state through an immer draft.
     * @param id - session id.
     * @param mutate - draft mutator.
     */
    updateSessionSnapshot(id: string, mutate: (draft: SessionFixtureSnapshot) => void): Promise<void>;
    /**
     * Replace a Session's complete contiguous event window.
     * @param id - Session identity.
     * @param entries - complete event window.
     * @param hasMore - whether older history remains.
     */
    replaceEvents(id: string, entries: readonly SessionEventLikeEntry[], hasMore?: boolean): Promise<void>;
    /**
     * Prepend one older contiguous event page.
     * @param id - Session identity.
     * @param entries - older entries.
     * @param hasMore - whether another older page remains.
     */
    prependEvents(id: string, entries: readonly SessionEventLikeEntry[], hasMore?: boolean): Promise<void>;
    /**
     * Append one live event to a Session's contiguous window.
     * @param id - Session identity.
     * @param entry - live event entry.
     */
    appendEvent(id: string, entry: SessionLiveEventEntry): Promise<void>;
    /**
     * Update a session's list row (the wire-echo stand-in: title settles,
     * running flips — components subscribed via useSessions re-render).
     * @param id - session id.
     * @param patch - summary fields to merge over the row.
     */
    updateSummary(id: string, patch: Partial<Omit<SessionSummary, 'id'>>): Promise<void>;
    /**
     * Switch the current selection (undefined = the no-session empty state).
     * @param id - session id to select, or undefined to clear.
     */
    setCurrent(id: string | undefined): Promise<void>;
    /**
     * Remove a session: list row, scope fiber, and per-session store instances
     * (with persisted state) die together — the same single lifecycle axis the
     * production Client Sessions service drives on session death, minus staging.
     * @param id - session id.
     */
    remove(id: string): Promise<void>;
    /**
     * Resolve (mint on first touch) the session-scoped Cordis context through
     * the production `createScope`, so real `scopeOf`/scope-addressed services
     * resolve it.
     * @param id - session id.
     * @returns the scoped context, or undefined for unknown sessions.
     */
    scope(id: string): AgentContext | undefined;
    /**
     * Session assembly binding (inject factories and provide resolvers receive it).
     * @param id - session id.
     * @returns sessionId + behavior face + scoped ctx, or undefined when unknown.
     */
    binding(id: string): SessionBinding | undefined;
    /**
     * Read the session scope tag off a context (service-method boundary mirror).
     * @param ctx - any client context.
     * @returns the session id, or undefined on root contexts.
     */
    scopeOf(ctx: Context): SessionId | undefined;
    /**
     * Resolve the scoped session face off a context (production `sessionOf`
     * mirror).
     * @param ctx - any client context.
     * @returns the fixture session face, or undefined off-scope.
     */
    sessionOf(ctx: Context): SessionFace | undefined;
    /**
     * Install Session creation behavior for navigation tests.
     * @param impl - implementation that must return an already-added fixture id.
     */
    stubCreate(impl: (opts: Parameters<ISessions['create']>[0]) => Promise<SessionId>): void;
    /** Create through the installed test behavior and require an addressable binding. */
    create(opts?: Parameters<ISessions['create']>[0]): Promise<SessionId>;
    /**
     * Service-level selection call (recorded, then applied to the list store
     * synchronously — inject callbacks call this outside any act window; the
     * store notify is microtask-batched so the next stabilized step observes it).
     * @param id - session id.
     */
    open(id: SessionId): void;
    /** Open an existing fixture through its catalog address. */
    openSubagent(address: SubagentAddress): void;
    /** Resolve the current fixture's retained catalog address. */
    subagentAddress(id: SessionId): SubagentAddress | undefined;
    /** Record catalog consumption; fixture callers drive snapshots explicitly. */
    setSubagentCatalogOpen(parentSessionId: SessionId, open: boolean): void;
    /** Record a catalog refresh; fixture callers drive snapshots explicitly. */
    refreshSubagents(parentSessionId: SessionId): Promise<void>;
    /** Clear the current selection (recorded; the production no-session flow). */
    clear(): void;
    /** Record a list refresh; fixture callers publish list state explicitly. */
    refresh(): Promise<void>;
    /**
     * Replace the sidebar-search result page (the call is still recorded).
     * @param impl - hits for a query, as the Host would rank them.
     */
    stubSearch(impl: (query: string, signal: AbortSignal) => {
        items: SessionSearchResultItem[];
        hasMore: boolean;
    }): void;
    /**
     * Content search over the fixture corpus (recorded). The default answers an
     * empty page: content ranking is Host behavior, so a scenario that asserts
     * hits declares them through {@link TestSessions.stubSearch}.
     * @param query - non-blank literal phrase.
     * @param signal - cancellation for a superseded search (recorded and forwarded).
     * @returns the stubbed or empty result page.
     */
    search(query: string, signal: AbortSignal): ReturnType<ISessions['search']>;
    /**
     * Recorded fork stub: no child materializes (benches asserting the full
     * fork flow drive the production service; this face only proves the call).
     * @param opts - source session id, optional cut anchor, and client title policy.
     * @returns the source id (no child record is created).
     */
    fork(opts: {
        sessionId: SessionId;
        atSeq?: number;
        increaseTitle?: boolean;
    }): Promise<SessionId>;
    /**
     * The session face of a fixture (typed view for assertions; fixture
     * behavior methods are grafted onto it).
     * @param id - session id.
     * @returns the FixtureSession carried by the Controller binding.
     */
    behavior(id: string): FixtureSession;
    /** Dispose minted scope fibers (runtime dispose path). */
    disposeScopes(): Promise<void>;
    private bindingOf;
    private require;
}
//# sourceMappingURL=sessions.d.ts.map