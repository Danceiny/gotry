/**
 * Out-of-process ACP subagent backend. Each child has its own process, session, model, and
 * tools, so it shares no Cordis context and advertises no parent-enforced start capabilities;
 * the ONE thing it reads off `request.parent` is the session's workspace cwd (see
 * {@link resolveCwd}). This plugin uses named exports only; a default would hide its
 * loader metadata (see `docs/postmortem/0001-acp-default-export-drops-inject.md`).
 * @module @deepseek-ai/dsh-subagent-acp
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type PermissionPolicy } from './run.ts';
export declare const name = "subagent-acp";
export declare const inject: string[];
/** Config: how to spawn and drive the child ACP agent process. */
export interface Config {
    /** Provider name on `ctx.subagents` (default `acp`). */
    providerName: string;
    /** The executable to spawn for each run (the child ACP agent). */
    command: string;
    /** Arguments passed to {@link command}. */
    args: string[];
    /**
     * Working directory override for the child process and its ACP session.
     * Must be non-empty; a relative path resolves against the harness launch
     * directory at load, and the result must be an existing directory. When
     * omitted, each child inherits its delegating parent session's cwd — and
     * starting one from a parent session that has no cwd fails.
     */
    cwd?: string;
    /**
     * How to auto-answer the child's `session/request_permission` prompts:
     * `reject` (default — decline every prompt) or `allow` (approve via the first
     * `allow_once` or `allow_always` option). No prompt is surfaced to a human.
     */
    permission: PermissionPolicy;
    /**
     * Extra environment variables for the child process — e.g. the child
     * harness's own `DEEPSEEK_API_KEY`. Forwarded on top of a credential-scrubbed
     * copy of the parent env, so an explicit key here reaches the child while
     * ambient secrets do not leak implicitly.
     */
    env: Record<string, string>;
    /**
     * Grace period (ms) for the child's EOF-driven quiesce on dispose — its
     * window to flush persistence and tear down its own nested subprocesses
     * before the parent escalates to a signal. Must not exceed
     * `MAX_TIMER_DELAY_MS`.
     */
    disposeEofGraceMs?: number;
    /** Failure-observation and termination-escalation grace (ms); must not exceed `MAX_TIMER_DELAY_MS`. */
    disposeGraceMs?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map