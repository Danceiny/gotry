//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-lsp-stdio`.
* @module @deepseek-ai/dsh-lsp-stdio/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-lsp-stdio";
/** Cordis companion plugin name. */
const name = "lsp-stdio-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: process pools and per-workspace queues are private implementation state,
* and this provider publishes no independent lifecycle event stream or enumerable snapshot.
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
