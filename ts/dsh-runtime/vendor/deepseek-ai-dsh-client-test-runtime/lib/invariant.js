//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-test-runtime`.
* @module @deepseek-ai/dsh-client-test-runtime/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-test-runtime";
/** Cordis companion plugin name. */
const name = "client-test-runtime-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this test-support package owns no production event
* stream or mutable data — it assembles the runtime SlotRegistry and renderer
* (whose packages own their invariants) around test doubles; its own behavior
* is exercised by its package tests.
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
