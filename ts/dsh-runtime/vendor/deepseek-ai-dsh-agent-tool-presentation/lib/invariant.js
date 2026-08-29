//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-agent-tool-presentation`.
* @module @deepseek-ai/dsh-agent-tool-presentation/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-agent-tool-presentation";
/** Cordis companion plugin name. */
const name = "tool-presentation-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this package makes exactly one scoped call into
* `ctx.tools` and owns no event or snapshot of its own; the relation it
* establishes — which presentation one agent's assembly uses — is the tool
* registry's to hold, and `dsh-tools` observes it there.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
