/**
 * Out-of-process SDK subagent backend. Each child is a complete DeepSeek
 * Harness runtime in its own process — own named profile and patch composition,
 * session, model route, and tools — driven over stdio JSON-RPC through the
 * TypeScript SDK client, so it shares no Cordis context. It accepts the
 * provider/model/reasoning/maxTokens subset of `agentOptions`; other start
 * features remain unsupported. The ONE thing it reads off `request.parent`
 * is the session's workspace cwd. This plugin uses named
 * exports only; a default would hide its loader metadata (see
 * `docs/postmortem/0001-acp-default-export-drops-inject.md`).
 * @module @deepseek-ai/dsh-subagent-dsh-sdk
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "subagent-dsh-sdk";
export declare const inject: string[];
/** Config: how to spawn and drive the child SDK runtime process. */
export interface Config {
    /** Provider name on `ctx.subagents` (default `dsh-sdk`). */
    providerName: string;
    /** Explicit dsh CLI module, resolved and checked at plugin load; omission uses the SDK dependency. */
    dshBin?: string;
    /** Named child profile (default `sdk`). */
    profile: string;
    /** Ordered per-launch profile patch files, resolved and checked at plugin load. */
    patches: string[];
    /** Absolute isolated Harness home for every nested child process. */
    dshHome: string;
    /**
     * Working directory override for the child process and its SDK session
     * workspace. Must be non-empty; a relative path resolves against the
     * harness launch directory at load, and the result must be an existing
     * directory. When omitted, each child inherits its delegating parent
     * session's cwd — and starting one from a parent session that has no cwd
     * fails.
     */
    cwd?: string;
    /** Provider route the child runtime initializes with (default `deepseek-official`). */
    provider: string;
    /** Model the child runtime initializes with (default `deepseek-v4-flash`). */
    model: string;
    /** Optional per-request output-token cap for the child runtime. */
    maxTokens?: number;
    /**
     * Extra environment variables for the child process — e.g. the child
     * runtime's own `DEEPSEEK_API_KEY`. Forwarded on top of a credential-scrubbed copy of the parent
     * env, so an explicit key here reaches the child while ambient secrets do
     * not leak implicitly.
     */
    env: Record<string, string>;
    /** Bound (ms) on the protocol `shutdown` exchange during dispose. */
    shutdownTimeoutMs?: number;
    /**
     * Grace period (ms) for the child's EOF-driven quiesce on dispose — its
     * window to flush persistence and tear down its own nested subprocesses
     * before the parent escalates to a signal.
     */
    disposeEofGraceMs?: number;
    /** Termination confirmation window (ms), including forced exit on every platform. */
    disposeGraceMs?: number;
}
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map