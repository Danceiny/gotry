//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-session-checkpoint-policy`.
* @module @deepseek-ai/dsh-session-checkpoint-policy/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-session-checkpoint-policy";
/** Cordis companion plugin name. */
const name = "session-checkpoint-policy-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: checkpoint ordering is enforced at the intercepted waterfall and
* persistence seams; this stateless policy owns no independent mutable relation.
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
