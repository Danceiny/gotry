//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-session-stats`.
* @module @deepseek-ai/dsh-session-stats/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-session-stats";
/** Cordis companion plugin name. */
const name = "session-stats-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the package owns a single pure projection fold whose
* wire payload is schema-validated by the projection registry at every
* snapshot and change-feed emission, and the event relations the fold relies
* on (`step/end` exactly once per entered step, monotonic host-assigned turn
* numbers, chunk and tool events carrying their step coordinates and call
* ids) are owned and runtime-checked by dsh-agent-loop and the session
* surface, not here.
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
