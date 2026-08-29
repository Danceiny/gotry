//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-store`.
* @module @deepseek-ai/dsh-client-store/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-store";
/** Cordis companion plugin name. */
const name = "client-store-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the package exports a library engine and creates no
* process-global state; each store instance is covered by its owning tests.
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

//# sourceMappingURL=invariant.js.map