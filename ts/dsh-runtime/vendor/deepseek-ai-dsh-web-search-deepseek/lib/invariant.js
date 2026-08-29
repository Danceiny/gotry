//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-web-search-deepseek`.
* @module @deepseek-ai/dsh-web-search-deepseek/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-web-search-deepseek";
/** Cordis companion plugin name. */
const name = "web-search-deepseek-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the package emits a pre-dispatch log event but owns no
* later authoritative dispatch event to relate it to. Exact envelope equality
* is pinned at the provider boundary instead.
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
