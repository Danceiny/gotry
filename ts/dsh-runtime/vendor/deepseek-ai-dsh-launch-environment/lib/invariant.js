//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-launch-environment`.
* @module @deepseek-ai/dsh-launch-environment/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-launch-environment";
/** Cordis companion plugin name. */
const name = "launch-environment-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the snapshot is frozen before any fiber starts and this package owns no
* event stream or mutable runtime data; its lookup and rejection rules are enforced by unit tests.
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
