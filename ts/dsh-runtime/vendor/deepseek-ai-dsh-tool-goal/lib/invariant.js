//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-tool-goal`.
* @module @deepseek-ai/dsh-tool-goal/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-tool-goal";
/** Cordis companion plugin name. */
const name = "tool-goal-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this model-facing adapter owns no independent state or event protocol;
* accepted mutations are checked by the goal domain and authority behavior is package-tested.
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
