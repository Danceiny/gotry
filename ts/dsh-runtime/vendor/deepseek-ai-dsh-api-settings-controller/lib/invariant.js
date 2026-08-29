//#region lib/types/invariant.js
/** Package-owned invariant companion. @module @deepseek-ai/dsh-api-settings-controller/invariant */
const PACKAGE_NAME = "@deepseek-ai/dsh-api-settings-controller";
/** Cordis companion plugin name. */
const name = "api-settings-controller-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the settings and credential seams own storage and
* update events, while this package only projects their methods onto the wire.
*/
const install = () => {};
/** Register this package's invariant companion. */
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
