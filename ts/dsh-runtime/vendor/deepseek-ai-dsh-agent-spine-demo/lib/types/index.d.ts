/**
 * Default executor-less, UI-less agent spine. It bundles the common services,
 * background-job registry and controls, optional persisted goals, concrete loop, local skill and
 * agent-instructions providers, and model-facing shell/skill consumers;
 * deployments still choose the LLM adapter, bash executor, and presentation.
 * The plugin intentionally exposes named exports only because Loader default
 * unwrapping would discard its `Config` schema (see docs/postmortem/0001).
 * @module @deepseek-ai/dsh-agent-spine-demo
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type Config as SessionTitleConfig } from '@deepseek-ai/dsh-session-title';
import { type Config as SystemPromptConfig } from '@deepseek-ai/dsh-system-prompt';
import { type Config as ToolsConfig } from '@deepseek-ai/dsh-tools';
import { type Config as SkillRegistryConfig } from '@deepseek-ai/dsh-skill';
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem';
import { type Config as GoalDomainConfig } from '@deepseek-ai/dsh-goal';
import * as toolGoal from '@deepseek-ai/dsh-tool-goal';
import { type Config as JobsConfig } from '@deepseek-ai/dsh-jobs-local';
import { type Config as InvariantConfig } from '@deepseek-ai/dsh-invariants';
import * as toolBash from '@deepseek-ai/dsh-tool-bash';
import * as workspaceContext from '@deepseek-ai/dsh-agent-instructions';
import * as toolSkill from '@deepseek-ai/dsh-tool-skill';
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs';
import { type Config as AgentLoopConfig } from '@deepseek-ai/dsh-agent-loop';
export declare const name = "agent-spine-demo";
/** Skill bundle config forwarded to the registry, local provider, and model-facing consumer. */
export interface SkillConfig {
    /** Mount the bundled local skill provider and model-facing skill tool (default true). */
    enabled?: boolean;
    /** Registry-level discovery cache settings. */
    registry?: SkillRegistryConfig;
    /** Local filesystem skill provider settings. */
    filesystem?: SkillFileSystem.Config;
    /** Model-facing skill catalog and tool settings. */
    tool?: toolSkill.Config;
}
/** Persisted goal domain, model-tool policy, and same-session driver config. */
export interface GoalConfig {
    /** Goal-domain creation defaults. */
    domain?: GoalDomainConfig;
    /** Model-facing goal-tool authority policy. */
    tool?: toolGoal.Config;
}
/**
 * Bundle config: each field forwarded verbatim to the child that owns it —
 * `agents` to the agent loop (an app that pre-creates no agents, like the ACP
 * bridge, simply omits it), `includeHarnessIdentity`, `includeRuntimeContext`,
 * `persona`, and `toolOrder` to the system-prompt plugin (the fixed opener,
 * dynamic-context policy, deployment persona, and explicit model-facing tool
 * order), the `tools` object to the tool
 * registry (its presentation `mode`),
 * `dshHome` to bash environment and local skill discovery, `sessionTitle` to
 * the fallback title service, `skills` to the
 * skill registry/local provider/tool consumer, `workspaceContext` to the
 * agent-instructions loader, `jobs` to the process-local job provider, and
 * `toolBash`/`toolJobs` to the model-facing tool plugins this bundle owns.
 * Provider adapters own their `retryPolicy`; this bundle always mounts its
 * executor.
 * `goals` opts into and configures the persisted goal domain plus its model tool
 * and same-session driver; `invariants` configures global and package-filtered
 * relational checks. Owner schemas supply defaults for optional input;
 * workspace context instead requires an explicit byte budget or `false` because
 * it changes model-visible input. Producer opt-in stays producer-local:
 * `toolBash` configures bash only; independently composed producers keep their
 * own config. Set `toolBash: false` when another plugin owns the model-facing
 * `bash` name.
 */
export interface Config {
    /** The agent-loop `agents` list (see dsh-agent-loop's `Config`). */
    agents?: AgentLoopConfig['agents'];
    /** Agent-loop concurrency cap; `1` is serial. */
    maxParallelToolCalls?: AgentLoopConfig['maxParallelToolCalls'];
    /** Whether the system prompt includes the fixed Harness identity (default true). */
    includeHarnessIdentity?: SystemPromptConfig['includeHarnessIdentity'];
    /** Whether model history includes dynamic runtime-context snapshots (default true). */
    includeRuntimeContext?: SystemPromptConfig['includeRuntimeContext'];
    /** The deployment persona (see dsh-system-prompt's `Config`). */
    persona?: SystemPromptConfig['persona'];
    /** The explicit model-facing tool order (see dsh-system-prompt's `Config`). */
    toolOrder?: SystemPromptConfig['toolOrder'];
    /** The tool registry's config — its presentation `mode` (see dsh-tools' `Config`). */
    tools?: ToolsConfig;
    /** DeepSeek Harness home directory shared by shell context and local skill discovery. */
    dshHome?: string;
    /** Deterministic fallback and accepted-title limits; omission uses the bundle's example policy. */
    sessionTitle?: SessionTitleConfig;
    /** Workspace-context loader controls with an explicit byte budget; set `false` for hermetic prompts. */
    workspaceContext: workspaceContext.Config | false;
    /**
     * Skill registry, local provider, and model-facing consumer config.
     * Skills use `enabled` because one nested config controls a provider stack;
     * single model-tool plugins use `Config | false` to disable that one consumer.
     */
    skills?: SkillConfig;
    /** Model-facing bash tool config, or false when another plugin owns `bash`. */
    toolBash?: toolBash.Config | false;
    /** Process-local background-job admission config. */
    jobs?: JobsConfig;
    /** Generic background-job controls; set false to keep the job service without model-facing job tools. */
    toolJobs?: toolJobs.Config | false;
    /** Global enablement and package-name filters for invariant companions. */
    invariants?: InvariantConfig;
    /** Opt-in persisted same-session goal stack; set false or omit to leave it unmounted. */
    goals?: GoalConfig | false;
}
/** The skill config schema exported for app packages that forward `skills`. */
export declare const SkillConfigSchema: z<SkillConfig>;
/** The session-title config schema with the shared bundle's overridable example limits. */
export declare const SessionTitleConfigSchema: z<SessionTitleConfig>;
/** The bash-tool config schema exported for app packages that forward `toolBash`. */
export declare const ToolBashConfigSchema: z<toolBash.Config | false>;
/** The process-local job registry schema exported for app packages that forward `jobs`. */
export declare const JobsConfigSchema: z<JobsConfig>;
/** The job-control-tool config schema exported for app packages that forward `toolJobs`. */
export declare const ToolJobsConfigSchema: z<toolJobs.Config>;
/** The persisted-goal config schema exported for app packages that opt in. */
export declare const GoalConfigSchema: z<GoalConfig>;
/** Intersect the owners' schemas so validation + defaulting stay identical. */
export declare const Config: z<Config>;
/**
 * Copy the bundle-owned fields from an app config without leaking entry-point settings.
 * @param config - App config containing the shared spine fields.
 * @returns The fields accepted by this bundle, preserving optional absence.
 */
export declare function pickSpineConfig(config: Omit<Config, 'agents'>): Omit<Config, 'agents'>;
/**
 * Load the spine. Each `ctx.plugin(...)` mounts one child of the bundle fiber;
 * `agent-loop` receives the forwarded `agents` list and `system-prompt` the
 * forwarded persona fields and `toolOrder`. Workspace-context receives its own
 * explicitly forwarded config. Load order is irrelevant (cordis
 * pends each fiber on its `inject` until the services it needs exist), but the
 * listing mirrors the dependency layering for readability: the LLM vocabulary
 * and core registries first, then extension plugins that wrap request/tool
 * seams, then the loop that drives them.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map