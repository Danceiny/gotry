//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-settings-plugins`.
* @module @deepseek-ai/dsh-client-ui-settings-plugins/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-ui-settings-plugins";
/** Cordis companion plugin name. */
const name = "client-ui-settings-plugins-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this is a browser-side settings surface whose node half owns no event
* stream or mutable runtime data; the layering and write refusals are Host contracts covered by
* the owning plugins and the api-proxy.
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
