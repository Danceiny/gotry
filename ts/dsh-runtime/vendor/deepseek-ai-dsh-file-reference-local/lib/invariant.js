//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-file-reference-local`.
* @module @deepseek-ai/dsh-file-reference-local/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-file-reference-local";
/** Cordis companion plugin name. */
const name = "file-reference-local-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: per-agent indexes are private advisory caches whose
* invalidation and disposal are observed directly through service tests.
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
