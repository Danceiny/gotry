//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-compaction-tool-result-pruner`.
* @module @deepseek-ai/dsh-compaction-tool-result-pruner/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-compaction-tool-result-pruner";
/** Cordis companion plugin name. */
const name = "compaction-tool-result-pruner-invariant";
/** Services required before the companion can register. */
const inject = ["invariants"];
/** No runtime invariant: Session validates each content-only rewrite and its companion owns cross-event enclosure. */
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
