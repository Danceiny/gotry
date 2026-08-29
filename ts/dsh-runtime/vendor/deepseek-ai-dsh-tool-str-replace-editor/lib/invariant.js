//#region lib/types/invariant.js
/**
* Package-owned invariant companion for `@deepseek-ai/dsh-tool-str-replace-editor`.
* @module @deepseek-ai/dsh-tool-str-replace-editor/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-tool-str-replace-editor";
/** Cordis companion plugin name. */
const name = "tool-str-replace-editor-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: the tool adapter owns no independent durable state;
* filesystem mutation relations stay with the provider and policy plugins.
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
