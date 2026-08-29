import "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
z.object({
	provider: z.string().min(1).required(),
	model: z.string().min(1).required()
});
/**
* Stable identity for one provider/model pair.
* @param route - Exact provider/model route.
* @returns Opaque key for equality checks.
*/
function modelRouteKey(route) {
	return `${route.provider}\0${route.model}`;
}
/**
* Reject malformed or duplicate route policy entries at a durable or configuration boundary.
* @param routes - Candidate exact routes to validate.
* @returns an assertion that the candidate is a validated exact-route array.
*/
function assertAllowedModelRoutes(routes) {
	if (!Array.isArray(routes)) throw new Error("subagent model selection requires an array of routes");
	const seen = /* @__PURE__ */ new Set();
	const candidates = routes;
	for (const candidate of candidates) {
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate) || !("provider" in candidate) || typeof candidate.provider !== "string" || !("model" in candidate) || typeof candidate.model !== "string" || candidate.provider.length === 0 || candidate.model.length === 0) throw new Error("subagent model selection requires non-empty provider and model ids");
		const route = {
			provider: candidate.provider,
			model: candidate.model
		};
		const key = modelRouteKey(route);
		if (seen.has(key)) throw new Error(`subagent model selection repeats route "${route.provider}/${route.model}"`);
		seen.add(key);
	}
}
//#endregion
//#region lib/types/model-selection-state.js
/** Durable per-session state for the user-controlled model-selection opt-in. */
/**
* Read the exact route list captured for a model-selectable definition.
* @param session - session whose durable decision is read.
* @returns a detached route list, or undefined for the fixed-route definition.
*/
function subagentModelSelectionPolicy(session) {
	const event = session.events.find((candidate) => candidate.type === "subagent/model-selection-policy");
	if (event?.type !== "subagent/model-selection-policy") return void 0;
	const { allowedModels } = event.data;
	assertAllowedModelRoutes(allowedModels);
	const routes = allowedModels.map((route) => ({ ...route }));
	if (routes.length === 0) throw new Error("subagent/model-selection-policy requires at least one route");
	return routes;
}
//#endregion
//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-tool-subagent`.
* @module @deepseek-ai/dsh-tool-subagent/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-tool-subagent";
/** Cordis companion plugin name. */
const name = "tool-subagent-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/** Assert that model-selectable definitions are complete and reconstructable. */
const install = Object.assign((ctx, fail) => {
	ctx.on("agent/pre-step", async ({ agent }, next) => {
		const schemas = ctx.tools.schemas(agent);
		const selectable = schemas.some((schema) => {
			const properties = schema.parameters.properties;
			return properties?.["provider"] !== void 0 && properties["model"] !== void 0 && properties["reasoning_effort"] !== void 0;
		});
		const discoverable = schemas.some((schema) => schema.name === "list_subagent_models");
		if ((selectable || discoverable) && (subagentModelSelectionPolicy(agent.session) === void 0 || !selectable || !discoverable)) fail("model-selectable subagent definitions require a durable policy, route fields, and list_subagent_models");
		return next();
	}, { global: true });
}, { inject: ["tools"] });
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
