/**
 * Profile-named Claude Code one-shot subagent provider. Every accepted run
 * invokes the official Agent SDK in the delegating Session's workspace and
 * places the SDK-spawned real CLI under the shared subprocess owner.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type ClaudeCodePermissionMode } from './run.ts';
export declare const name = "subagent-claude-code";
export declare const inject: string[];
/** Deployment-owned model, permission, environment, and process-release settings. */
export interface Config {
    /** Provider name on `ctx.subagents` (default `claude-code`). */
    providerName?: string;
    /** Native Claude model fixed for this instance; omitted to inherit Claude settings. */
    model?: string;
    /**
     * Explicit environment entries layered over the subprocess seam's
     * credential-scrubbed parent environment.
     */
    env?: Record<string, string>;
    /**
     * Native non-interactive mode fixed for this Provider instance. Defaults to
     * `dontAsk`; `acceptEdits` accepts edits, `auto` uses the native classifier,
     * `plan` returns a plan without approving execution, and
     * `bypassPermissions` explicitly skips permission checks.
     */
    permissionMode?: ClaudeCodePermissionMode;
    /** Grace in milliseconds for Claude Code process-tree termination. */
    disposeGraceMs?: number;
}
export declare const Config: z<Config>;
/**
 * Register one Profile-named Claude Code provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional model, permission mode, child environment, and disposal grace.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map