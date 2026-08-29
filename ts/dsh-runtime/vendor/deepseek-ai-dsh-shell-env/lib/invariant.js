//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-shell-env`.
* @module @deepseek-ai/dsh-shell-env/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-shell-env";
/** Cordis companion plugin name. */
const name = "shell-env-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the environment registry validates ownership and collected values at each
* registration/collection; it publishes no independent snapshot that a companion could cross-check.
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
