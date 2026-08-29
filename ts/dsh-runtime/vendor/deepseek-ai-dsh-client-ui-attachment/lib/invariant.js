//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-attachment`.
* @module @deepseek-ai/dsh-client-ui-attachment/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-ui-attachment";
/** Cordis companion plugin name. */
const name = "client-ui-attachment-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the package contributes only effect-owned slot entries;
* the slot registry owns their lifecycle and validates their declarations.
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
