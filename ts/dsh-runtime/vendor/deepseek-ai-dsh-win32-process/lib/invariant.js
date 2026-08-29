//#region lib/types/invariant.js
/** Package-owned invariant companion for `@deepseek-ai/dsh-win32-process`. */
const PACKAGE_NAME = "@deepseek-ai/dsh-win32-process";
const name = "win32-process-invariant";
const inject = ["invariants"];
/** No runtime invariant: operations own only call-local native handles. */
const install = () => {};
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
