//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-command-feedback`.
* @module @deepseek-ai/dsh-command-feedback/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-command-feedback";
/** Cordis companion plugin name. */
const name = "command-feedback-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: each `feedback/record` is an independent append-only
* fact with no cross-event or mutable-data relationship.
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
