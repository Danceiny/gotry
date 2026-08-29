//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-settings-models`.
* @module @deepseek-ai/dsh-client-ui-settings-models/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-ui-settings-models";
/** Cordis companion plugin name. */
const name = "client-ui-settings-models-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: a nav-entry-only section plugin rendering a fixed
* empty content column — it emits no cordis events and owns no cross-plugin
* mutable relation.
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
