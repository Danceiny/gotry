//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-web-app`.
* @module @deepseek-ai/dsh-web-app/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-web-app";
/** Cordis companion plugin name. */
const name = "web-app-invariant";
/** Service required before the companion can register. */
const inject = ["invariants"];
/**
* No runtime invariant: every contribution (frontend-static child plugin,
* prompt section, bashEnv registration) is registry-disposed with the fiber,
* and each owning registry's package carries that relation's invariant; the
* package holds no mutable state of its own to audit.
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
