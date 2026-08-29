//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-jobs-local`.
* @module @deepseek-ai/dsh-jobs-local/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-jobs-local";
/** Cordis companion plugin name. */
const name = "jobs-local-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: `@deepseek-ai/dsh-jobs/invariant` owns per-snapshot identity, status,
* timestamp, and owner checks. This provider's admission decision uses private configuration and
* must fail before a backend starter runs; `LocalJobRegistry.start()` enforces it synchronously
* for current producers. Repeating an aggregate after publication would expose private
* configuration solely to this companion and would not verify the fail-closed pre-start guarantee.
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
