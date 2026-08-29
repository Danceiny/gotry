//#region lib/types/invariant.js
/**
* Package-owned invariant companion for the adaptive directory-picker chooser.
* @module @deepseek-ai/dsh-host-directory-picker-auto/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-host-directory-picker-auto";
/** Cordis companion plugin name. */
const name = "host-directory-picker-auto-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/** No runtime invariant: the sole effect is one boot-time Loader-entry mount owned by the plugin fiber; the store is authoritative. */
const install = () => {};
/**
* Register the adaptive directory-picker invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
