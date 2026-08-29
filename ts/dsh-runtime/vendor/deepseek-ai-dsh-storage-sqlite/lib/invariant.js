//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-storage-sqlite`.
* @module @deepseek-ai/dsh-storage-sqlite/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-storage-sqlite";
/** Cordis companion plugin name. */
const name = "storage-sqlite-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: schema-version and unit-version consistency are
* open-time checks that reject before a unit exists, and durability needs the
* backend round-trip tests in the shared KV conformance suite; this package
* exposes no continuously observable in-process relation.
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
