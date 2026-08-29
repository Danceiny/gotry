//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-sandbox-windows-acl`.
* @module @deepseek-ai/dsh-sandbox-windows-acl/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-sandbox-windows-acl";
/** Cordis companion plugin name. */
const name = "sandbox-windows-acl-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this package exposes no independent event sequence or
* mutable data relation beyond the fail-closed contracts it enforces at each
* Win32 call boundary.
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
