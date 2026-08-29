/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-subagent-control`.
 * @module @deepseek-ai/dsh-tool-subagent-control/invariant
 */
const PACKAGE_NAME = '@deepseek-ai/dsh-tool-subagent-control';
/** Cordis companion plugin name. */
export const name = 'tool-subagent-control-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: this model-facing adapter has no independent lifecycle stream; delivery
 * and activation relations are owned by the subagent service it calls.
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