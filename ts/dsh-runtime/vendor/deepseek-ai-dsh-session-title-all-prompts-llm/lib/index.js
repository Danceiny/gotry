import z from "@deepseek-ai/schemastery";
import { SessionTitleLlmConfigFields, registerSessionTitleLlmProvider } from "@deepseek-ai/dsh-session-title-llm";
//#region lib/types/index.js
/** All-human-messages model provider for `ctx.sessionTitle`. */
const name = "session-title-all-prompts-llm";
const inject = [
	"sessionTitle",
	"llm",
	"sessions"
];
/** Loader schema shared with the first-prompt provider. */
const Config = z.object({
	targetWords: SessionTitleLlmConfigFields.targetWords,
	targetCjkCharacters: SessionTitleLlmConfigFields.targetCjkCharacters,
	maxInputBytes: SessionTitleLlmConfigFields.maxInputBytes,
	maxOutputTokens: SessionTitleLlmConfigFields.maxOutputTokens,
	timeoutMs: SessionTitleLlmConfigFields.timeoutMs,
	provider: SessionTitleLlmConfigFields.provider,
	model: SessionTitleLlmConfigFields.model
});
/**
* Register the all-prompts model provider.
* @param ctx - context exposing session-title, LLM, and session services.
* @param config - required route, target, byte, token, and timeout policy.
*/
function apply(ctx, config) {
	registerSessionTitleLlmProvider(ctx, config, name, "all-prompts", (messages) => messages);
}
//#endregion
export { Config, apply, inject, name };
