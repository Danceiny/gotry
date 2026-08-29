//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-client-connection`.
* @module @deepseek-ai/dsh-client-connection/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-client-connection";
/** Cordis companion plugin name. */
const name = "client-connection-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: browser-session verification reads the credential
* record asynchronously at the request that authorizes work, while the
* credentials companion owns record commit-event lifetime. Stream/reconnect
* sequencing and rpcId round-trip discipline are exercised directly by
* behavior specs, and route register/dispose symmetry is
* audited by the webserver companion.
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
