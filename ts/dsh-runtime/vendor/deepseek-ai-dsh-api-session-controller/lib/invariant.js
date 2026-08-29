//#region lib/types/invariant.js
/** Package-owned invariant companion. @module @deepseek-ai/dsh-api-session-controller/invariant */
const PACKAGE_NAME = "@deepseek-ai/dsh-api-session-controller";
/** Cordis companion plugin name. */
const name = "api-session-controller-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/** No runtime invariant: every page and frame is checked against the addressed durable Session. */
const install = () => {};
/** Register this package's invariant companion. */
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
