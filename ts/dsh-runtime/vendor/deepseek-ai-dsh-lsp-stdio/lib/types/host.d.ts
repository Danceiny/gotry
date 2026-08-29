/** Filesystem-seam source access for the generic stdio LSP provider. */
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs';
/** A canonical workspace in the filesystem/subprocess execution world. */
export interface HostWorkspace {
    /** Stable filesystem identity used for provider pooling. */
    readonly target: FsTarget;
    /** Canonical absolute path accepted as a subprocess cwd. */
    readonly canonicalPath: string;
    /** Canonical file URI sent during LSP initialization. */
    readonly fileUrl: string;
}
/** A validated source and the exact URI sent to the language server. */
export interface HostSource {
    /** Canonical file URI in the execution world's platform syntax. */
    readonly fileUrl: string;
    /** Current complete UTF-8 text. */
    readonly text: string;
}
/**
 * Resolve and validate one workspace through `ctx.fs`.
 * @param fs - filesystem provider sharing the language server's execution world.
 * @param workspaceRoot - caller-supplied workspace path.
 * @param signal - optional cancellation around provider operations.
 * @returns stable identity plus process path and file URI.
 */
export declare function canonicalizeWorkspace(fs: FileSystem, workspaceRoot: string, signal?: AbortSignal): Promise<HostWorkspace>;
/**
 * Resolve, contain, and read one byte-bounded query source through `ctx.fs`.
 * This layer owns the LSP-specific complete-document cap while the filesystem
 * provider owns streaming, regular-file checks, and UTF-8 validation.
 * @param fs - filesystem provider sharing the server's execution world.
 * @param filePath - absolute source path or path relative to `workspace`.
 * @param workspace - already-canonical workspace.
 * @param maxDocumentBytes - largest complete source accepted by this host.
 * @param signal - optional cancellation.
 * @returns canonical file URI and current text.
 */
export declare function readHostSource(fs: FileSystem, filePath: string, workspace: HostWorkspace, maxDocumentBytes: number, signal?: AbortSignal): Promise<HostSource>;
//# sourceMappingURL=host.d.ts.map