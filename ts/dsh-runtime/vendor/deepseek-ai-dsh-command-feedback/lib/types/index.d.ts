/**
 * Session feedback event plus the human-facing `/feedback` producer. Recording
 * appends one authoritative log-only event and does not start model work. The
 * append is eager but unflushed, so acknowledgement reports that the entry is
 * logged, not that it reached disk.
 * @module @deepseek-ai/dsh-command-feedback
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
export declare const name = "command-feedback";
export declare const inject: string[];
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /**
         * One recorded human remark about this session. Log-only and independent
         * of its trigger; it never enters model context or derived history.
         */
        'feedback/record': {
            text: string;
        };
    }
}
/**
 * Record feedback independently of any UI trigger.
 * @param session - session the feedback describes.
 * @param text - human-authored feedback; surrounding whitespace is discarded.
 * @throws {TypeError} when the normalized text is empty.
 */
export declare function recordFeedback(session: Session, text: string): void;
/** Register the global `/feedback` command for every composed command adapter. */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map