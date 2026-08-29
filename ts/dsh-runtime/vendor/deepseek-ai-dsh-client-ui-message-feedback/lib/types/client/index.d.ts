/**
 * Message feedback plugin, browser half: the Like/Dislike entry in the
 * conversation.chat.assistant-actions strip. One MessageFeedbackController per
 * Session backs every message control in that Session, so a single list read
 * seeds the whole transcript. Mutations go through the generated
 * messageFeedback Remote; the Host owns per-item compare-and-set.
 * @module @deepseek-ai/dsh-client-ui-message-feedback/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
export type { MessageFeedbackActionResult, MessageFeedbackStatus, MessageFeedbackView, MessageFeedbackRemote, } from './controller.ts';
export type { MessageFeedbackActionProps, MessageFeedbackInjected } from './slots.ts';
export type { MessageFeedbackKey } from './locales.ts';
/** Required services: the slot registry, the Remote namespace, and the copy. */
export declare const inject: string[];
/**
 * Client plugin body: the per-message feedback entry and its per-session
 * object layer.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map