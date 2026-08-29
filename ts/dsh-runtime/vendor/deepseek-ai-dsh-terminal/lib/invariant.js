//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-terminal`.
* @module @deepseek-ai/dsh-terminal/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-terminal";
/** Cordis companion plugin name. */
const name = "terminal-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: backend and owner-scoped session registries are private mutable state,
* and the service exposes neither an independent lifecycle stream nor an unscoped snapshot.
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
