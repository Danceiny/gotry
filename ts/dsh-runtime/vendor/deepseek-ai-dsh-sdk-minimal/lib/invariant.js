//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-sdk-minimal`.
* @module @deepseek-ai/dsh-sdk-minimal/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-sdk-minimal";
/** Cordis companion plugin name. */
const name = "sdk-minimal-bundle-invariant";
/** Service required before the companion can register. */
const inject = ["invariants"];
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
