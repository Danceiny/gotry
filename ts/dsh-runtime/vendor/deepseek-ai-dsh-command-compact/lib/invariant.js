//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-command-compact`.
* @module @deepseek-ai/dsh-command-compact/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-command-compact";
/** Cordis companion plugin name. */
const name = "command-compact-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this command adapter owns no state or event stream; the compaction seam owns
* the balanced durable transaction and the command registry owns registration and dispatch lifecycle.
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
