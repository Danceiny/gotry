//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-code-runtime-worker-thread`.
* @module @deepseek-ai/dsh-code-runtime-worker-thread/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-code-runtime-worker-thread";
/** Cordis companion plugin name. */
const name = "code-runtime-worker-thread-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this process-boundary implementation exposes no same-process event relation;
* worker protocol and built-worker tests cover it.
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
