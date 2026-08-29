//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-tool-fs-search`.
* @module @deepseek-ai/dsh-tool-fs-search/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-tool-fs-search";
/** Cordis companion plugin name. */
const name = "tool-fs-search-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this model-facing adapter has no independent lifecycle stream; execution
* relations are owned by the capability seam it calls.
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
