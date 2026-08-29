import type { IWorkspaces, WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store';
import type { FixtureSnapshot, Stabilizer } from './fixtures.ts';
/** Writable test representation of the immutable Workspace Controller snapshot. */
type WorkspaceFixtureSnapshot = FixtureSnapshot<WorkspaceSnapshot>;
/** Callable command names on the production Workspace Controller face. */
type WorkspaceAction = {
    [Key in keyof IWorkspaces]: IWorkspaces[Key] extends (...args: never[]) => unknown ? Key : never;
}[keyof IWorkspaces];
/** Test replacement retaining one Controller command's parameters and result. */
type WorkspaceStub<Key extends WorkspaceAction> = (...args: Parameters<IWorkspaces[Key]>) => ReturnType<IWorkspaces[Key]>;
/**
 * Workspaces test double. Implements the same IWorkspaces face features
 * receive as `ctx.workspaces`, so a production face change breaks this
 * double at compile time. Every action records into {@link
 * TestWorkspaces.calls}; defaults are inert echoes — feature tests needing
 * richer behavior replace them via {@link TestWorkspaces.stub}.
 */
export declare class TestWorkspaces implements IWorkspaces {
    private readonly stabilize;
    /** The useWorkspaces standard feed. */
    readonly list: SnapshotStore<WorkspaceFixtureSnapshot>;
    /** Calls observed on the action face, newest last. */
    readonly calls: {
        method: string;
        args: unknown[];
    }[];
    /** Replaceable action seat: feature tests may stub richer behavior. */
    private readonly stubs;
    /**
     * @param stabilize - the owning runtime's act wrapper.
     */
    constructor(stabilize: Stabilizer);
    /**
     * Update the workspace list state through an immer draft.
     * @param mutate - draft mutator.
     */
    update(mutate: (draft: WorkspaceFixtureSnapshot) => void): Promise<void>;
    /**
     * Replace an action's behavior (the recorded call is still appended first).
     * @param method - Controller action name (e.g. 'create').
     * @param impl - replacement behavior.
     */
    stub<Key extends WorkspaceAction>(method: Key, impl: WorkspaceStub<Key>): void;
    /**
     * Create a Workspace (recorded). The default echoes a view derived from
     * the input; stub for failure or list-coupled flows.
     * @param input - the Host create payload.
     * @returns the created Workspace view.
     */
    create(input: {
        path: string;
    }): Promise<WorkspaceView>;
    /**
     * Rename a Workspace (recorded). The default echoes a minimal view.
     * @param workspaceId - target workspace.
     * @param title - new title.
     * @returns the updated view.
     */
    rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView>;
    /**
     * Delete a Workspace (recorded; default no-op).
     * @param workspaceId - target workspace.
     */
    delete(workspaceId: WorkspaceId): Promise<void>;
    /**
     * Move a Workspace in display order (recorded; default no-op).
     * @param workspaceId - Workspace to move.
     * @param beforeWorkspaceId - Anchor; omitted appends.
     */
    insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void>;
    /**
     * Move an accounted session (recorded). The default echoes a minimal view.
     * @param workspaceId - target workspace.
     * @param sessionId - session to move.
     * @param beforeSessionId - anchor; omitted appends.
     * @returns the updated view.
     */
    insertSessionBefore(workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId): Promise<WorkspaceView>;
    /**
     * Archive a session (recorded). The default mirrors the production face's
     * observable effect: the id joins the list state's archive set.
     * @param sessionId - session to archive.
     */
    archiveSession(sessionId: SessionId): Promise<void>;
}
export {};
//# sourceMappingURL=workspaces.d.ts.map