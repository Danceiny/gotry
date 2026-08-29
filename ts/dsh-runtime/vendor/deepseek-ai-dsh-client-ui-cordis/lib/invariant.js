//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-cordis`.
* @module @deepseek-ai/dsh-client-ui-cordis/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-ui-cordis";
/** Cordis companion plugin name. */
const name = "client-ui-cordis-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: a single keyed toolview registration whose disposal is
* proven by the HMR-safety spec. The one mutable relation this package owns —
* the per-definition run-state observable — lives in the browser process, out
* of reach of the host invariant service, and the node half emits no cordis
* events and holds no cross-plugin state.
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
