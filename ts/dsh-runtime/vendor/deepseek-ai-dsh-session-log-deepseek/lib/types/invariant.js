/** Package-owned invariants for DeepSeek session-log acceptance watermarks. */
const PACKAGE_NAME = '@deepseek-ai/dsh-session-log-deepseek';
/** Cordis companion plugin name. */
export const name = 'session-log-deepseek-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/** Validate one acceptance watermark against its containing event and session. */
function validateDeliveryAccepted(session, event, fail) {
    const { sessionId, throughSeq } = event.data;
    const inherited = session.header.parentSession !== undefined
        && session.header.seedLength !== undefined
        && event.seq < session.header.seedLength;
    if (sessionId !== session.id && !inherited) {
        fail('a non-inherited session-log-deepseek/delivery-accepted event must name its containing session');
    }
    if (!Number.isSafeInteger(throughSeq) || throughSeq < 0 || throughSeq >= event.seq) {
        fail(`session-log-deepseek/delivery-accepted throughSeq must identify an earlier event, got ${throughSeq} at seq ${event.seq}`);
    }
}
/** Validate acceptance watermarks already present in one Session. */
function validateSession(session, fail) {
    for (const event of session.events) {
        if (event.type === 'session-log-deepseek/delivery-accepted')
            validateDeliveryAccepted(session, event, fail);
    }
}
/** Validate one live session-event dispatch. */
function validateDispatched(args, fail) {
    const [session, event] = args;
    if (event.type === 'session-log-deepseek/delivery-accepted')
        validateDeliveryAccepted(session, event, fail);
}
/** Install validation for restored, newly created, and newly appended watermarks. */
const install = Object.assign((ctx, fail) => {
    const validateExisting = (session) => { validateSession(session, fail); };
    ctx.sessions.list().forEach(validateExisting);
    ctx.on('session/created', validateExisting, { global: true });
    ctx.on('internal/dispatch', (_mode, eventName, args) => {
        if (eventName === 'session/event')
            validateDispatched(args, fail);
    }, { global: true });
}, { inject: ['sessions'] });
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//# sourceMappingURL=invariant.js.map