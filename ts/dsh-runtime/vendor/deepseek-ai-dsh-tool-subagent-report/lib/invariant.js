//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-tool-subagent-report`.
* @module @deepseek-ai/dsh-tool-subagent-report/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-tool-subagent-report";
/** Cordis companion plugin name. */
const name = "tool-subagent-report-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this adapter has no independent lifecycle stream;
* sender authorization and delivery relations belong to the subagent service.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - context carrying the invariant service.
* @returns the registration disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
