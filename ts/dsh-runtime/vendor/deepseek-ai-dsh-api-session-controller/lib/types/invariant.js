/** Package-owned invariant companion. @module @deepseek-ai/dsh-api-session-controller/invariant */
const PACKAGE_NAME = '@deepseek-ai/dsh-api-session-controller';
/** Cordis companion plugin name. */
export const name = 'api-session-controller-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/** No runtime invariant: every page and frame is checked against the addressed durable Session. */
const install = () => { };
/** Register this package's invariant companion. */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
//# sourceMappingURL=invariant.js.map