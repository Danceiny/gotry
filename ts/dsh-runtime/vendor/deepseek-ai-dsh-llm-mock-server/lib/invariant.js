//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-llm-mock-server`.
* @module @deepseek-ai/dsh-llm-mock-server/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-llm-mock-server";
/** Cordis companion plugin name. */
const name = "llm-mock-server-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this standalone test server owns no Cordis event stream or shared data;
* its wire behavior and lifecycle are exercised through direct HTTP and assembled-loop tests.
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
