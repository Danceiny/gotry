import type { Context } from '@deepseek-ai/cordis';
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { UnknownSurfaceNode } from '../contract/snapshot.ts';
declare module '../contract/chat-nodes.ts' {
    interface ChatNodeDataMap {
        /** Generic presentation of an unclaimed append-surface event. */
        unknown: UnknownSurfaceNode;
    }
}
/** Unclaimed append-surface fallback Definition. */
export declare const unknownFallbackDefinition: ConversationNodeDefinition<UnknownSurfaceNode>;
/**
 * Register the unmatched append-surface fallback contribution.
 * @param ctx - owning UI Conversation context.
 */
export declare function registerUnknownConversationFallback(ctx: Context): void;
//# sourceMappingURL=fallback.d.ts.map