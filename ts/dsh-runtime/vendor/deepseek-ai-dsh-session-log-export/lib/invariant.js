//#region lib/types/invariant.js
/** Package invariant companion for `@deepseek-ai/dsh-session-log-export`. */
const PACKAGE_NAME = "@deepseek-ai/dsh-session-log-export";
const name = "session-export-invariant";
const inject = ["invariants"];
/**
* No runtime invariant: Connection and the command registry own both
* registrations, while each export reads authoritative Session services.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Host context carrying the invariant registry.
* @returns the registration disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
