//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-anonymous-user-id`.
* @module @deepseek-ai/dsh-anonymous-user-id/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-anonymous-user-id";
/** Cordis companion plugin name. */
const name = "anonymous-user-id-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the API owns one private memo and one best-effort
* file, with no independent event stream or public mutable relation for a
* companion to compare without creating the identity as a side effect.
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
