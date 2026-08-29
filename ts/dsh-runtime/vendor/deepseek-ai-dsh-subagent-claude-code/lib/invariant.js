//#region lib/types/invariant.js
/**
* Package-owned invariant companion for
* `@deepseek-ai/dsh-subagent-claude-code`.
* @module @deepseek-ai/dsh-subagent-claude-code/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-subagent-claude-code";
/** Cordis companion plugin name. */
const name = "subagent-claude-code-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: lifecycle pairing belongs to the shared subagent
* service and process-tree ownership belongs to the subprocess service.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - plugin context carrying the invariant registry.
* @returns the installed registration's disposer.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
