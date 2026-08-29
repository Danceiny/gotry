//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-workspace`.
* @module @deepseek-ai/dsh-client-ui-workspace/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-ui-workspace";
/** Cordis companion plugin name. */
const name = "client-ui-workspace-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: a pure-consumer plugin registering presentational
* components into two host-declared slots plus its locale dictionaries — its
* inject face is stateless RPC wrappers plus a create-and-open call; it
* emits no cordis events and owns no cross-plugin mutable state.
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
