//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-session-query-sqlite`.
* @module @deepseek-ai/dsh-session-query-sqlite/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-session-query-sqlite";
/** Cordis companion plugin name. */
const name = "session-query-sqlite-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: reconciliation, cursor generations, and derived-index
* ownership are validated at each serialized query boundary.
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
