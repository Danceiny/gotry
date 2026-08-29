//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-acp`.
* @module @deepseek-ai/dsh-acp/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-acp";
/** Cordis companion plugin name. */
const name = "acp-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this transport owns no durable package-local event stream;
* protocol and lifecycle tests cover its mapping.
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
