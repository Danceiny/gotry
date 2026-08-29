//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-terminal-bash`.
* @module @deepseek-ai/dsh-terminal-bash/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-terminal-bash";
/** Cordis companion plugin name. */
const name = "terminal-bash-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: readiness, terminal buffers, and process-tree state are private per-session
* implementation state, and the backend publishes no independent lifecycle stream or snapshot.
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
