//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-tool-subagent-control`.
* @module @deepseek-ai/dsh-tool-subagent-control/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-tool-subagent-control";
/** Cordis companion plugin name. */
const name = "tool-subagent-control-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this model-facing adapter has no independent lifecycle stream; delivery
* and activation relations are owned by the subagent service it calls.
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
