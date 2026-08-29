//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-directory-picker-native`.
* @module @deepseek-ai/dsh-client-ui-directory-picker-native/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-ui-directory-picker-native";
/** Cordis companion plugin name. */
const name = "client-ui-directory-picker-native-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the plugin registers a renderless flow occupant into
* two workspace holes as one transactional effect, whose disposal the
* HMR-safety spec proves, and it retains no state between picks.
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
