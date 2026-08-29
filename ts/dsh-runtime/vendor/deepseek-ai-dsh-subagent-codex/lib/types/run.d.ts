/**
 * One-shot Codex child lifecycle: spawn the real app-server through the
 * subprocess seam, publish only after initialization and ephemeral thread
 * creation, flatten post-publication failures, and dispose to whole-tree
 * quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-codex/run
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { type SubagentRun, type SubagentStartRequest, type SubagentStopReason } from '@deepseek-ai/dsh-subagent';
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { CodexAppServerWire } from './wire.ts';
/** Default POSIX grace between subprocess termination tiers. */
export declare const DEFAULT_DISPOSE_GRACE_MS = 3000;
/** Profile-selectable non-interactive Codex permission mode. */
export type CodexPermissionMode = 'never' | 'approve-for-me' | 'dangerously-bypass-approvals-and-sandbox';
/** Native non-interactive Codex modes mapped to official `thread/start` fields. */
export declare const CODEX_PERMISSION_MODES: readonly ["never", "approve-for-me", "dangerously-bypass-approvals-and-sandbox"];
/** Safe default for unattended Codex runs. */
export declare const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode;
/**
 * Hide an unpublished Host failure behind fixed safe startup facts.
 * @param cause Original Host failure retained for internal diagnostics.
 * @returns A startup failure whose message contains only fixed safe facts.
 */
export declare function codexStartupFailure(cause: unknown): Error;
/**
 * Fixed package-local app-server command, independent of the host `PATH`.
 * @returns Node, the official wrapper, and the fixed app-server arguments.
 */
export declare function codexAppServerArgv(): string[];
/** Fully resolved inputs for one Codex app-server run. */
export interface CodexRunSpec {
    /** Parent Session workspace, also supplied to `thread/start`. */
    readonly cwd: string;
    /** Profile-selected native model; omitted to preserve Codex settings. */
    readonly model?: string;
    /** Profile-selected native non-interactive permission mode. */
    readonly permissionMode: CodexPermissionMode;
    /** Explicit deployment/test environment layered after the shared scrub. */
    readonly env: Record<string, string>;
    /** Subprocess termination grace passed to the shared process-tree owner. */
    readonly disposeGraceMs: number;
    /** Shared subprocess service spawn operation. */
    readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle;
    /** Diagnostic sink for a post-publication error flattened into a result. */
    readonly onError?: (error: Error, stopReason: SubagentStopReason) => void;
}
/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact non-empty text block sequence.
 */
export declare function textTask(prompt: readonly ContentBlock[]): string[];
/**
 * Close the private wire, terminate the managed process tree, and wait for the
 * subprocess owner to prove it is gone.
 * @param wire - private app-server protocol connection.
 * @param child - shared-service handle that owns the process tree.
 */
export declare function disposeCodexChild(wire: CodexAppServerWire, child: SubprocessHandle): Promise<void>;
/**
 * Start the real `codex app-server --stdio` child and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after initialization and ephemeral thread creation.
 */
export declare function startCodexRun(request: SubagentStartRequest, spec: CodexRunSpec): Promise<SubagentRun>;
//# sourceMappingURL=run.d.ts.map