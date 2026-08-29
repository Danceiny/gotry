/**
 * Browser-safe Workspace path and display helpers.
 * @module @deepseek-ai/dsh-util-workspace-path
 */
/**
 * Resolve a Workspace-relative path into the Host-facing spelling used by path operations.
 * @param cwd - Session Workspace root, when known.
 * @param path - Absolute or Workspace-relative path.
 * @returns an absolute path when a Workspace root is available, otherwise the original path.
 */
export declare function resolveWorkspacePath(cwd: string | undefined, path: string): string;
/**
 * Abbreviate a POSIX home directory for display.
 * @param path - Absolute or already-short display path.
 * @param home - Host account home; absent skips abbreviation.
 * @returns `~` or `~/…` for the POSIX home and its descendants, otherwise `path`.
 */
export declare function abbreviateHomePath(path: string, home?: string): string;
/**
 * Read the final non-empty segment of a Workspace path for display.
 * Workspace-label surfaces use this helper instead of deriving another basename.
 * @param path - Workspace directory path using POSIX or Windows separators.
 * @returns the final segment, or an empty string for a separator-only path.
 */
export declare function workspaceTitleOf(path: string): string;
//# sourceMappingURL=index.d.ts.map