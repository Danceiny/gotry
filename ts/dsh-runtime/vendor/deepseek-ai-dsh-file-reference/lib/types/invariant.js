/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-file-reference`.
 * @module @deepseek-ai/dsh-file-reference/invariant
 */
const PACKAGE_NAME = '@deepseek-ai/dsh-file-reference';
/** Cordis companion plugin name. */
export const name = 'file-reference-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: the interface retains no candidate or lifecycle
 * state; concrete providers own their cache and invalidation relationships.
 */
const install = () => { };
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
//# sourceMappingURL=invariant.js.map