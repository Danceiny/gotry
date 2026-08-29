//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-directory-picker-browse`.
* @module @deepseek-ai/dsh-client-ui-directory-picker-browse/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-ui-directory-picker-browse";
/** Cordis companion plugin name. */
const name = "client-ui-directory-picker-browse-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the plugin registers one workspace directory-flow
* owner whose disposal the HMR-safety spec proves, and every listing it shows
* is re-read from the Host on demand rather than held here.
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
