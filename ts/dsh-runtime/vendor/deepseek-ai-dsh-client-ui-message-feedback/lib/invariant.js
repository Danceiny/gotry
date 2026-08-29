//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-message-feedback`.
* @module @deepseek-ai/dsh-client-ui-message-feedback/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-ui-message-feedback";
/** Cordis companion plugin name. */
const name = "client-ui-feedback-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the plugin owns one slot registration and one
* per-session controller map, both released by the same effect disposer. The
* lifecycle spec proves the registration is withdrawn and every controller is
* dropped when the owning fiber is disposed, so no second authority exists to
* check at runtime.
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
