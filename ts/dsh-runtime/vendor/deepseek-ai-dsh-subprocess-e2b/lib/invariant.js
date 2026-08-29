//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-subprocess-e2b`.
* @module @deepseek-ai/dsh-subprocess-e2b/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-subprocess-e2b";
/** Cordis companion plugin name. */
const name = "subprocess-e2b-invariant";
/** Service required before reserving package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: live remote handles are private teardown ownership,
* and the E2B command event stream is the sole outcome authority.
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
