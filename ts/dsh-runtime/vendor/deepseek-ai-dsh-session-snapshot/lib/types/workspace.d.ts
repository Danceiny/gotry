/** Capture readable, path-stable workspace state for recorded-session tests. */
/** Marker that lets Git retain an expected empty directory without becoming expected workspace state. */
export declare const EMPTY_WORKSPACE_MARKER = ".empty";
/** One UTF-8 file in a captured workspace. */
export interface WorkspaceTextFileSnapshot {
    /** Cwd-relative POSIX path. */
    readonly path: string;
    /** Entry discriminator. */
    readonly kind: 'text';
    /** Exact UTF-8 contents. */
    readonly content: string;
}
/** One non-text file in a captured workspace. */
export interface WorkspaceBinaryFileSnapshot {
    /** Cwd-relative POSIX path. */
    readonly path: string;
    /** Entry discriminator. */
    readonly kind: 'binary';
    /** Exact bytes encoded for deterministic diffs. */
    readonly base64: string;
}
/** One symbolic link in a captured workspace. */
export interface WorkspaceSymlinkSnapshot {
    /** Cwd-relative POSIX path. */
    readonly path: string;
    /** Entry discriminator. */
    readonly kind: 'symlink';
    /** Exact link text without resolving the target. */
    readonly target: string;
}
/** One empty directory in a captured workspace. */
export interface WorkspaceEmptyDirectorySnapshot {
    /** Cwd-relative POSIX path. */
    readonly path: string;
    /** Entry discriminator. */
    readonly kind: 'empty-directory';
}
/** Stable complete file, link, and empty-directory state below one workspace root. */
export type WorkspaceSnapshotEntry = WorkspaceTextFileSnapshot | WorkspaceBinaryFileSnapshot | WorkspaceSymlinkSnapshot | WorkspaceEmptyDirectorySnapshot;
/** Options for excluding harness-owned root entries from a runtime workspace. */
export interface CaptureWorkspaceSnapshotOptions {
    /** Exact immediate children of the workspace root to omit. */
    readonly ignoredRootEntries?: readonly string[];
}
/**
 * Capture one workspace without resolving links or depending on host path separators.
 * @param root - Absolute directory whose user-visible state is captured.
 * @param options - Harness-owned immediate children to omit.
 * @returns Stable entries sorted by relative path.
 */
export declare function captureWorkspaceSnapshot(root: string, options?: CaptureWorkspaceSnapshotOptions): Promise<WorkspaceSnapshotEntry[]>;
/**
 * Capture a committed `workspace.expected/` tree, excluding its Git-only empty marker.
 * @param root - Absolute expected-workspace directory.
 * @returns Stable expected entries.
 */
export declare function captureExpectedWorkspaceSnapshot(root: string): Promise<WorkspaceSnapshotEntry[]>;
//# sourceMappingURL=workspace.d.ts.map