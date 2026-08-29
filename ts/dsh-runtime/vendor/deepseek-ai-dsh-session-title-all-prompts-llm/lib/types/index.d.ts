/** All-human-messages model provider for `ctx.sessionTitle`. */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { SessionTitleLlmConfig } from '@deepseek-ai/dsh-session-title-llm';
export declare const name = "session-title-all-prompts-llm";
export declare const inject: string[];
/** Required LLM policy; this plugin adds no defaults. */
export type Config = SessionTitleLlmConfig;
/** Loader schema shared with the first-prompt provider. */
export declare const Config: z<Config>;
/**
 * Register the all-prompts model provider.
 * @param ctx - context exposing session-title, LLM, and session services.
 * @param config - required route, target, byte, token, and timeout policy.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map