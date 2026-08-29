//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-commands`.
* @module @deepseek-ai/dsh-client-ui-commands/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-ui-commands";
/** Cordis companion plugin name. */
const name = "client-ui-commands-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: a browser-side source over the wire command
* directory — it emits no cordis events and owns no cross-plugin mutable
* state; dispatch and cache behavior are asserted by this package's specs.
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
