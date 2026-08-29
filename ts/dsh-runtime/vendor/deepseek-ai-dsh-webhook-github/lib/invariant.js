//#region lib/types/invariant.js
/** Package-owned invariant companion for the GitHub webhook adapter. */
const PACKAGE_NAME = "@deepseek-ai/dsh-webhook-github";
/** Cordis invariant-companion plugin name. */
const name = "webhook-github-invariant";
/** Registry required before reserving this package's invariant ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: authentication and input validation occur at the exact
* HTTP operation; dsh-host-webserver owns route/disposer symmetry.
*/
const install = () => {};
/**
* Register this package's explained empty invariant.
* @param ctx - Cordis context carrying the invariant registry.
* @returns the invariant registration disposer.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
