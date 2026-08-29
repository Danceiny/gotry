//#region lib/types/invariant.js
/** Package-owned invariant companion. @module @deepseek-ai/dsh-client-ui-settings-plugin-inventory/invariant */
const PACKAGE_NAME = "@deepseek-ai/dsh-client-ui-settings-plugin-inventory";
/** Cordis companion plugin name. */
const name = "client-ui-settings-plugin-inventory-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/** No runtime invariant: this package owns a read-only Settings contribution. */
const install = () => {};
/** Register this package's invariant companion. */
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
