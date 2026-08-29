//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-session-persistence-sqlite`.
* @module @deepseek-ai/dsh-session-persistence-sqlite/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-session-persistence-sqlite";
/** Cordis companion plugin name. */
const name = "session-persistence-sqlite-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: physical packing is observable only by database
* round-trip and row-count checks, not a continuous in-process relation.
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
