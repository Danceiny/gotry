/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-typert-generator`.
 * @module @deepseek-ai/dsh-typert-generator/invariant
 */
const PACKAGE_NAME = '@deepseek-ai/dsh-typert-generator';
/** Cordis companion plugin name. */
export const name = 'typert-generator-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: this source-project analyzer and build-time emitter
 * runs outside any cordis runtime; model snapshots, executable artifacts, and
 * consuming-package typechecks enforce its output contract.
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