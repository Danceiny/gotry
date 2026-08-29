//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-persona`.
* @module @deepseek-ai/dsh-persona/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-persona";
/** Cordis companion plugin name. */
const name = "persona-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this row owns no event stream or mutable runtime data — it registers one
* prompt section and the prompt registry owns identity, complete-prompt enforcement, shadowing,
* and disposal.
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
