/** Stable failures exposed by the session-persistence service. */
import type { SessionId } from '@deepseek-ai/dsh-session';
/** The requested Session identity has no materialized durable log. */
export declare class SessionPersistenceNotFoundError extends Error {
    readonly sessionId: SessionId;
    /** @param sessionId - absent durable Session identity. */
    constructor(sessionId: SessionId);
}
//# sourceMappingURL=errors.d.ts.map