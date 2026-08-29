//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-sdk-protocol`.
* @module @deepseek-ai/dsh-sdk-protocol/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-sdk-protocol";
/** Cordis companion plugin name. */
const name = "sdk-protocol-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: a pure wire library (transport class + type
* declarations) with no event stream or mutable data relation of its own;
* both wire ends own their protocol behavior.
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
