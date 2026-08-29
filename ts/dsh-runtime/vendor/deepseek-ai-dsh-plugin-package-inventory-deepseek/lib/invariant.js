//#region lib/types/invariant.js
/** Package-owned invariant companion for `@deepseek-ai/dsh-plugin-package-inventory-deepseek`. */
const PACKAGE_NAME = "@deepseek-ai/dsh-plugin-package-inventory-deepseek";
/** Cordis companion plugin name. */
const name = "plugin-package-inventory-deepseek-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: each request reads authoritative Loader fiber state and
* package manifests directly; the plugin retains no independently mutable inventory.
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
