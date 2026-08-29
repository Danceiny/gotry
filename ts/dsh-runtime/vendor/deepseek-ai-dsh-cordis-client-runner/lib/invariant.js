//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-cordis-client-runner`.
* @module @deepseek-ai/dsh-cordis-client-runner/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-cordis-client-runner";
/** Cordis companion plugin name. */
const name = "cordis-client-runner-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the owned relation (a live
* Plugin's loader entry exists exactly while one Plugin Run ID is live) is
* browser-only state reachable through the client half's service, which the
* node-plane companion cannot observe. The relation is asserted by the
* package's own load/teardown coverage instead.
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
