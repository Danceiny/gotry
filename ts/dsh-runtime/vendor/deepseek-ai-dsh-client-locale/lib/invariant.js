//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-locale`.
* @module @deepseek-ai/dsh-client-locale/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-locale";
/** Cordis companion plugin name. */
const name = "client-locale-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the locale catalog and dictionaries have no
* independent runtime source to compare against; registration disposal,
* preference resolution, and fallback lookup are asserted by behavior specs.
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
