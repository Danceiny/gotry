//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-e2b`.
* @module @deepseek-ai/dsh-e2b/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-e2b";
/** Cordis companion plugin name. */
const name = "e2b-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: sandbox creation and teardown have one SDK promise and
* no independent event or mutable-data relationship to cross-check.
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
