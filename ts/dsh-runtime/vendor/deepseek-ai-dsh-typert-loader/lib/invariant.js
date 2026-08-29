//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-typert-loader`.
* @module @deepseek-ai/dsh-typert-loader/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-typert-loader";
/** Cordis companion plugin name. */
const name = "typert-loader-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the Loader entry lifecycle directly owns each exact
* registry disposer, and integration tests observe registration and removal.
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
