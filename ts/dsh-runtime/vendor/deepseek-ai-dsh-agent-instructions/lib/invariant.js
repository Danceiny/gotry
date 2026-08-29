//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-agent-instructions`.
* @module @deepseek-ai/dsh-agent-instructions/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-agent-instructions";
/** Cordis companion plugin name. */
const name = "workspace-context-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: replay intentionally tolerates unknown or malformed workspace sources,
* while focused pipeline tests own its private pending/cache state transitions.
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
