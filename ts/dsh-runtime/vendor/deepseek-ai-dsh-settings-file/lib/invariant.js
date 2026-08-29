//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-settings-file`.
* @module @deepseek-ai/dsh-settings-file/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-settings-file";
/** Cordis companion plugin name. */
const name = "settings-file-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this provider's contracts are file round-trip,
* watcher timing, and atomic-write behavior — IO effects proven by package
* tests; the in-process commit relation is owned by `@deepseek-ai/dsh-settings`.
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
