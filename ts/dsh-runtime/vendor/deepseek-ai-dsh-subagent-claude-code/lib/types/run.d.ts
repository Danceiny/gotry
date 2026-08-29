/**
 * One-shot Claude Code lifecycle: invoke the official Agent SDK, place its
 * real CLI process under the shared subprocess owner, map only strict SDK
 * success to completion, and dispose to whole-tree quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/run
 */
import { type Options, type Query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { type SubagentResult, type SubagentRun, type SubagentStartRequest, type SubagentStopReason } from '@deepseek-ai/dsh-subagent';
import { type SubprocessHandle, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import { ManagedClaudeCodeProcess } from './process.ts';
/** Default POSIX grace between subprocess termination tiers. */
export declare const DEFAULT_DISPOSE_GRACE_MS = 3000;
/** Claude Code permission modes that cannot wait for a human response. */
export declare const CLAUDE_CODE_PERMISSION_MODES: readonly ["dontAsk", "acceptEdits", "auto", "plan", "bypassPermissions"];
/** Profile-selectable non-interactive Claude Code permission mode. */
export type ClaudeCodePermissionMode = typeof CLAUDE_CODE_PERMISSION_MODES[number];
/** Safe default for unattended Claude Code runs. */
export declare const DEFAULT_CLAUDE_CODE_PERMISSION_MODE: ClaudeCodePermissionMode;
/**
 * Hide an unpublished product startup failure behind fixed safe facts.
 * @param cause - original host-side failure retained only on the Error cause chain.
 * @returns a rejection safe to expose through the subagent start boundary.
 */
export declare function claudeCodeStartupFailure(cause: unknown): Error;
/** Fully resolved inputs for one official Claude Agent SDK query. */
export interface ClaudeCodeRunSpec {
    /** Parent Session workspace supplied to the SDK and real CLI. */
    readonly cwd: string;
    /** Profile-selected native model; omitted to preserve Claude settings. */
    readonly model?: string;
    /** Profile-selected native non-interactive permission mode. */
    readonly permissionMode: ClaudeCodePermissionMode;
    /** Explicit deployment/test environment layered after shared scrubbing. */
    readonly env: Record<string, string>;
    /** Subprocess termination grace passed to the shared process-tree owner. */
    readonly disposeGraceMs: number;
    /** Shared subprocess service spawn operation. */
    readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle;
    /** Host diagnostic sink for a product failure kept outside model-visible text. */
    readonly onError?: (error: Error, stopReason: SubagentStopReason) => void;
}
/**
 * Validate and preserve the one-shot task before crossing the SDK boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact text sequence as one SDK prompt.
 */
export declare function textTask(prompt: readonly ContentBlock[]): string;
/**
 * Strictly derive the only SDK result that can complete a shared run.
 * @param message - an official discriminated result union.
 * @returns exact final text for a successful, non-error result.
 */
export declare function successfulResult(message: SDKResultMessage): string;
/**
 * Consume the complete SDK stream and require one strict success plus normal
 * iterator completion.
 * @param query - published official SDK query.
 * @param onPermissionDenied - records a safe fact when the SDK reports native denial.
 * @param onResult - records that the SDK supplied a terminal result message.
 * @returns the completed shared result.
 */
export declare function consumeClaudeQuery(query: AsyncIterable<SDKMessage>, onPermissionDenied?: () => void, onResult?: () => void): Promise<SubagentResult>;
/**
 * Close the official query, terminate the managed process tree, and wait for
 * the subprocess owner to prove it is gone.
 * @param query - official SDK query, when creation reached that point.
 * @param child - live shared-service handle that owns the CLI process tree;
 * spawn-failed handles settle at the startup boundary instead.
 */
export declare function disposeClaudeCodeChild(query: Pick<Query, 'close'> | undefined, child: SubprocessHandle): Promise<void>;
/**
 * Build the fixed official SDK options for one one-shot provider run.
 * @param spec - Workspace, environment, process service, and disposal policy.
 * @param controller - per-run cancellation owner.
 * @param capture - receives the shared child and SDK-facing process synchronously.
 * @param captureDiagnostic - receives safe facts from unattended interaction callbacks.
 * @returns options that inherit native settings while disabling persistence and user questions.
 */
export declare function claudeQueryOptions(spec: ClaudeCodeRunSpec, controller: AbortController, capture: (child: SubprocessHandle, process: ManagedClaudeCodeProcess) => void, captureDiagnostic: (diagnostic: string) => void): Options;
/**
 * Start one official Claude Agent SDK query and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after both Query and real CLI handle exist.
 */
export declare function startClaudeCodeRun(request: SubagentStartRequest, spec: ClaudeCodeRunSpec): Promise<SubagentRun>;
//# sourceMappingURL=run.d.ts.map