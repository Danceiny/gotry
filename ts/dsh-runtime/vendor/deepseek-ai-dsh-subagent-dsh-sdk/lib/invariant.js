//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-subagent-dsh-sdk`.
* @module @deepseek-ai/dsh-subagent-dsh-sdk/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-subagent-dsh-sdk";
/** Cordis companion plugin name. */
const name = "subagent-dsh-sdk-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: run lifecycle pairing is owned and checked by the
* subagent seam's invariant; this backend's own state lives in the child
* process beyond this context's event streams.
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
