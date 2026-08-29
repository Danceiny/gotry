//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-plan`.
* @module @deepseek-ai/dsh-client-ui-plan/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-ui-plan";
/** Cordis companion plugin name. */
const name = "client-ui-plan-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: plan state and boundary ownership are
* audited by dsh-plan-mode, while the control is a slot effect whose
* declaration, registration, and teardown are exercised by this package.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns The installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
