//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-hooks-codex`.
* @module @deepseek-ai/dsh-hooks-codex/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-hooks-codex";
/** Cordis companion plugin name. */
const name = "hooks-codex-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this bridge publishes hook-protocol session events, whose companion owns
* which invocation event each result cites.
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
