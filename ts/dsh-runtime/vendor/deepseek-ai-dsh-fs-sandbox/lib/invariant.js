//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-fs-sandbox`.
* @module @deepseek-ai/dsh-fs-sandbox/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-fs-sandbox";
/** Cordis companion plugin name. */
const name = "fs-sandbox-invariant";
/** Services required before the companion can register. */
const inject = ["invariants"];
/** No runtime invariant: this stateless adapter delegates policy and filesystem relations to their owning seams. */
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
