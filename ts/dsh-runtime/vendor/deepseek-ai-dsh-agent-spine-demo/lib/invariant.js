//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-agent-spine-demo`.
* @module @deepseek-ai/dsh-agent-spine-demo/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-agent-spine-demo";
/** Cordis companion plugin name. */
const name = "agent-spine-demo-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this composition package owns no independent event stream or mutable data;
* Loader and built-entry tests cover its wiring.
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
