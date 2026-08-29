//#region lib/types/invariant.js
const PACKAGE_NAME = "@deepseek-ai/dsh-client-ui-chat";
/** Cordis companion plugin name. */
const name = "client-ui-chat-invariant";
/** Service required before the companion reserves package ownership. */
const inject = ["invariants"];
/** No runtime invariant: Conversation and Slot registration enforce Chat target consistency. */
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
