/**
 * Profile-named Codex one-shot subagent provider. Every accepted run starts a
 * fresh official package-local Codex wrapper with `app-server --stdio` in the
 * delegating Session's workspace and publishes only after an ephemeral thread exists.
 *
 * @module @deepseek-ai/dsh-subagent-codex
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type CodexPermissionMode } from './run.ts';
export declare const name = "subagent-codex";
export declare const inject: string[];
/** Deployment-owned model, permission, environment, and process-release settings. */
export interface Config {
    /** Provider name on `ctx.subagents` (default `codex`). */
    providerName?: string;
    /** Native Codex model fixed for this instance; omitted to inherit Codex settings. */
    model?: string;
    /**
     * Explicit environment entries layered over the subprocess seam's
     * credential-scrubbed parent environment.
     */
    env?: Record<string, string>;
    /** Native non-interactive permission mode fixed for this Provider instance. */
    permissionMode?: CodexPermissionMode;
    /** Grace in milliseconds for app-server process-tree termination. */
    disposeGraceMs?: number;
}
export declare const Config: z<Config>;
/**
 * Register one Profile-named Codex provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional model, permission mode, child environment, and disposal grace.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map