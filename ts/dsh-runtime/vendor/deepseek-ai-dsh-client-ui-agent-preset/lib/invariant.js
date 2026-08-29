//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-agent-preset`.
* @module @deepseek-ai/dsh-client-ui-agent-preset/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-ui-agent-preset";
/** Cordis companion plugin name. */
const name = "client-ui-agent-preset-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this is a browser-side surface plugin whose node half owns no event stream
* or mutable runtime data; the roster and the settings write are host contracts covered there.
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
