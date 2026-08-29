/**
 * Incremental session-log contribution for official DeepSeek LLM API requests.
 * Accepted sequence watermarks live in the canonical log, so restart recovery
 * can conservatively resend uncertain tails without maintaining another store.
 * @module @deepseek-ai/dsh-session-log-deepseek
 */
import z from '@deepseek-ai/schemastery';
import { SessionId } from '@deepseek-ai/dsh-session';
/** Cordis plugin name. */
export const name = 'session-log-deepseek';
/** Services required to resolve sessions and contribute the provider request field. */
export const inject = ['deepseekLlmApiExtensions', 'sessions'];
/** Validated Session-log request contribution configuration. */
export const Config = z.object({
    enabled: z.boolean().default(false),
});
const acceptanceFolds = new WeakMap();
/**
 * Highest confirmed sequence for this exact session identity.
 * @param session - canonical log whose matching acceptance events are folded.
 * @returns greatest accepted sequence, or `-1` before any accepted request.
 */
export function acceptedThrough(session) {
    const previous = acceptanceFolds.get(session);
    let throughSeq = previous?.throughSeq ?? -1;
    const events = session.events;
    const start = previous?.scannedEvents ?? 0;
    for (let index = start; index < events.length; index++) {
        const event = events[index];
        if (event.type !== 'session-log-deepseek/delivery-accepted')
            continue;
        if (typeof event.data.sessionId !== 'string' || event.data.sessionId.length === 0
            || !Number.isSafeInteger(event.data.throughSeq) || event.data.throughSeq < 0
            || event.data.throughSeq >= event.seq) {
            throw new Error(`session-log-deepseek: malformed acceptance watermark at seq ${event.seq}`);
        }
        if (event.data.sessionId !== session.id)
            continue;
        throughSeq = Math.max(throughSeq, event.data.throughSeq);
    }
    acceptanceFolds.set(session, { scannedEvents: events.length, throughSeq });
    return throughSeq;
}
/**
 * Register the incremental `dsh_session_log` request contribution when enabled.
 * @param ctx - plugin context carrying Sessions and the DeepSeek request-extension registry.
 * @param config - validated opt-in configuration.
 */
export function apply(ctx, config) {
    if (config.enabled !== true)
        return;
    ctx.deepseekLlmApiExtensions.register('dsh_session_log', {
        prepare: (request) => {
            // TODO: Define an explicit wire result for direct or stale-session calls if they become a supported product path.
            if (request.sessionId === undefined)
                return undefined;
            const session = ctx.sessions.get(SessionId(request.sessionId));
            if (session === undefined)
                return undefined;
            const afterSeq = acceptedThrough(session);
            const snapshot = session.events;
            const throughSeq = snapshot.length - 1;
            if (throughSeq < 0)
                return undefined;
            const suffix = snapshot.slice(afterSeq + 1);
            const value = {
                version: 1,
                session: session.header,
                afterSeq,
                throughSeq,
                events: suffix,
            };
            return {
                value,
                accept: () => {
                    session.append('session-log-deepseek/delivery-accepted', { sessionId: session.id, throughSeq });
                    // TODO: Add an immediate lightweight checkpoint if duplicate replay after a 2xx crash window becomes unacceptable.
                },
            };
        },
    });
}
//# sourceMappingURL=index.js.map