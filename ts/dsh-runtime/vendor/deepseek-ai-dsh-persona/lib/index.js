import z from "@deepseek-ai/schemastery";
import { PERSONA_ORDER, PERSONA_SECTION } from "@deepseek-ai/dsh-system-prompt";
//#region lib/types/index.js
/**
* A per-agent persona as a composable row.
*
* `dsh-system-prompt` owns the global persona as its own config, and registers
* that section unconditionally — so this row is **scope-only**. Mounted inside
* an agent preset it shadows the deployment persona for that one session,
* exactly like the per-child persona `dsh-subagent` installs; mounted globally
* it collides with the registry's own registration and fails loud.
*
* That constraint is the reason the row exists. An agent preset cannot mount
* the prompt registry itself, so without a row of its own a preset could
* change an agent's tools but never its identity.
* @module @deepseek-ai/dsh-persona
*/
/** Cordis plugin name. */
const name = "persona";
/** The prompt registry this row contributes to. */
const inject = ["systemPrompt"];
/** Runtime schema for the persona row. */
const Config = z.object({
	text: z.string().required(),
	complete: z.boolean().default(false),
	includeRuntimeContext: z.boolean().default(true)
});
/**
* Register the persona section for the mounting context's scope.
* @param ctx - an agent scope context; an unscoped context collides with the
* prompt registry's own persona registration and rejects.
* @param config - the persona text and complete-prompt policy.
*/
function apply(ctx, config) {
	ctx.effect(() => ctx.systemPrompt.section({
		name: PERSONA_SECTION,
		order: PERSONA_ORDER,
		text: config.text,
		...config.complete ? { complete: true } : {}
	}), "persona.section()");
	if (!(config.includeRuntimeContext ?? true)) ctx.systemPrompt.suppressRuntimeContext();
}
//#endregion
export { Config, PERSONA_ORDER, PERSONA_SECTION, apply, inject, name };
