//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-skill-badge`.
* @module @deepseek-ai/dsh-skill-badge/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-skill-badge";
/** Cordis companion plugin name. */
const name = "skill-badge-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the package owns one immutable provider registration,
* while the skill registry owns registration uniqueness and lifecycle checks.
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
