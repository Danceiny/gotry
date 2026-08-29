//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-loader-smoke`.
* @module @deepseek-ai/dsh-loader-smoke/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-loader-smoke";
/** Cordis companion plugin name. */
const name = "loader-smoke-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this test-support package owns no production event stream or mutable data;
* consuming test suites exercise its behavior.
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
