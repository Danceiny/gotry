//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-tool-ralph`.
* @module @deepseek-ai/dsh-tool-ralph/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-tool-ralph";
/** Cordis companion plugin name. */
const name = "tool-ralph-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: this model-facing orchestration adapter owns no independent event stream;
* workflow and subagent owners validate the runs and child lifecycles it starts.
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
