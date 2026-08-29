//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-headless`.
* @module @deepseek-ai/dsh-headless/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-headless";
/** Cordis companion plugin name. */
const name = "headless-invariant";
/** Service required before the companion can register. */
const inject = ["invariants"];
/**
* No runtime invariant: the runner's observable contract (provider reasoning
* on stderr, final text on stdout, exit code by turn-end reason) is
* process-level and owned by the launcher e2e; it registers nothing and holds
* no mutable relation to audit inside the tree.
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
