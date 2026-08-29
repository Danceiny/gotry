import AgentRegistry from "@deepseek-ai/dsh-agent";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import SessionStore from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
//#region lib/types/index.js
/**
* Shared mounting for the services required before tests load the concrete
* agent loop. The caller retains ownership of the context, loop, adapters,
* optional plugins, and teardown.
* @module @deepseek-ai/dsh-agent-loop-testkit
*/
/**
* Mount the standard prerequisite services for an AgentLoop test.
*
* The function deliberately does not mount AgentLoop or register an adapter,
* so tests retain control of load order and the topology under test. The
* context owns every mounted service and remains responsible for disposal. A
* plugin-load failure rejects the promise; services activated earlier in the
* sequence remain context-owned and unwind with that context.
* @param ctx - test context that owns the mounted services.
* @param options - optional service configuration forwarded without mutation.
* @returns after every prerequisite service has activated.
*/
async function mountAgentLoopTestDependencies(ctx, options = {}) {
	await ctx.plugin(LlmRuntime);
	await ctx.plugin(SessionStore);
	await ctx.plugin(SystemPrompt, options.systemPrompt ?? {});
	await ctx.plugin(ToolRuntime, options.tools ?? {});
	await ctx.plugin(AgentRegistry);
}
//#endregion
export { mountAgentLoopTestDependencies };
