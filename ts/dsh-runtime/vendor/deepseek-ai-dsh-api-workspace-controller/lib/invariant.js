//#region lib/types/invariant.js
/** Package-owned invariant companion. @module @deepseek-ai/dsh-api-workspace-controller/invariant */
const PACKAGE_NAME = "@deepseek-ai/dsh-api-workspace-controller";
/** Cordis companion plugin name. */
const name = "api-workspace-controller-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/** No runtime invariant: Workspace Registry owns persistence; every stream generation is a full projection. */
const install = () => {};
/** Register this package's invariant companion. */
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
