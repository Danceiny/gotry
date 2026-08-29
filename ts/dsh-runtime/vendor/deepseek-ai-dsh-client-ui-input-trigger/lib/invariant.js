//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-input-trigger`.
* @module @deepseek-ai/dsh-client-ui-input-trigger/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-ui-input-trigger";
/** Cordis companion plugin name. */
const name = "client-ui-input-trigger-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the trigger pipeline is a browser-side pure core
* (detect/reduce/match) plus a registry whose disposal is proven by the
* HMR-safety spec; it emits no cordis events and owns no cross-plugin
* mutable state.
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
