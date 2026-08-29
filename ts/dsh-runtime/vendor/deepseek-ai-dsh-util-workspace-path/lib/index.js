//#region lib/types/index.js
/**
* Browser-safe Workspace path and display helpers.
* @module @deepseek-ai/dsh-util-workspace-path
*/
/** Whether a path uses a Windows drive or UNC prefix. */
function isWindowsStylePath(value) {
	return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\");
}
/**
* Resolve a Workspace-relative path into the Host-facing spelling used by path operations.
* @param cwd - Session Workspace root, when known.
* @param path - Absolute or Workspace-relative path.
* @returns an absolute path when a Workspace root is available, otherwise the original path.
*/
function resolveWorkspacePath(cwd, path) {
	if (path.startsWith("/") || isWindowsStylePath(path)) return path;
	if (cwd === void 0 || cwd === "") return path;
	return `${cwd.replace(/[/\\]+$/, "")}/${path.replace(/^[/\\]+/, "")}`;
}
/**
* Abbreviate a POSIX home directory for display.
* @param path - Absolute or already-short display path.
* @param home - Host account home; absent skips abbreviation.
* @returns `~` or `~/…` for the POSIX home and its descendants, otherwise `path`.
*/
function abbreviateHomePath(path, home) {
	if (home === void 0 || home === "") return path;
	if (isWindowsStylePath(path) || isWindowsStylePath(home)) return path;
	const root = home.replace(/\/+$/, "");
	if (root === "" || root === "/") return path;
	if (path.replace(/\/+$/, "") === root) return "~";
	if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`;
	return path;
}
/**
* Read the final non-empty segment of a Workspace path for display.
* Workspace-label surfaces use this helper instead of deriving another basename.
* @param path - Workspace directory path using POSIX or Windows separators.
* @returns the final segment, or an empty string for a separator-only path.
*/
function workspaceTitleOf(path) {
	const trimmed = path.replace(/[/\\]+$/, "");
	const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return trimmed.slice(separator + 1);
}
//#endregion
export { abbreviateHomePath, resolveWorkspacePath, workspaceTitleOf };
