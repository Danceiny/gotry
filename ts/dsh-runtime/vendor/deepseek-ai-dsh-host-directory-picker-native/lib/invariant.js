//#region lib/types/invariant.js
/**
* Package-owned invariant companion for the native directory-picker backend.
* @module @deepseek-ai/dsh-host-directory-picker-native/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-host-directory-picker-native";
/** Cordis companion plugin name. */
const name = "host-directory-picker-native-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/** No runtime invariant: each pick is one stateless subprocess round trip; the chooser outcome is only the returned path. */
const install = () => {};
/**
* Register the native directory-picker invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
