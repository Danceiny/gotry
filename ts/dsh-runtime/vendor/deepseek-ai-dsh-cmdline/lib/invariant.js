//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-cmdline`.
* @module @deepseek-ai/dsh-cmdline/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-cmdline";
/** Cordis companion plugin name. */
const name = "cmdline-invariant";
/** Service required before the companion can register. */
const inject = ["invariants"];
/**
* No runtime invariant: `cmdlineArgs` is an immutable launcher fact that any
* number of ordinary plugins may read. App-owned providers and consumers use
* normal Cordis service injection, whose missing dependencies are already
* reported by Loader settlement.
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
