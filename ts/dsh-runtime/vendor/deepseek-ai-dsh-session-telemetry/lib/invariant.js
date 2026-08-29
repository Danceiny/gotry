//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-session-telemetry`.
* @module @deepseek-ai/dsh-session-telemetry/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-session-telemetry";
/** Cordis companion plugin name. */
const name = "session-telemetry-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the package's whole output is the backend handoff — a
* synchronous `emit()` call outside every authoritative event stream — and its
* capture side never appends session events, so no event/data relation exists
* for an independent companion to observe.
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
