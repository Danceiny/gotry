import type { Context } from '@deepseek-ai/cordis';
import type { ConversationTimelineSnapshot, ConversationViewBuilder, ConversationViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ChatConversationViewNode } from '../contract/chat-nodes.ts';
import type { ChatSnapshot } from '../contract/snapshot.ts';
/**
 * Order visible Chat Nodes without changing existing relative order as process
 * eligibility changes. Opening human input precedes process candidates, while
 * each synthetic process control sits between them.
 * @param nodes - currently materialized Chat Nodes.
 * @returns visible Nodes in presentation order.
 */
export declare function orderedVisibleChatNodes(nodes: readonly ChatConversationViewNode[]): ChatConversationViewNode[];
/** Incremental keyed Chat builder registered under the `chat` target. */
export declare class ChatSnapshotBuilder implements ConversationViewBuilder<ChatConversationViewNode, ChatSnapshot> {
    private readonly store;
    private readonly locations;
    private readonly navigation;
    private readonly legacy;
    private readonly referenceLabels;
    private order;
    /** Last published timeline: a Turn boundary can land without a new node. */
    private timeline;
    readonly empty: ChatSnapshot;
    constructor();
    replace(input: {
        readonly nodes: readonly ChatConversationViewNode[];
        readonly timeline: ConversationTimelineSnapshot;
    }): ChatSnapshot;
    apply(input: {
        readonly upserts: readonly ChatConversationViewNode[];
        readonly timeline: ConversationTimelineSnapshot;
    }): ChatSnapshot;
    private snapshot;
}
/** Chat target factory contributed to the Conversation view registry. */
export declare const chatViewDefinition: ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot>;
/**
 * Register the incremental Chat target builder.
 * @param ctx - owning UI Conversation context.
 */
export declare function registerChatConversationView(ctx: Context): void;
//# sourceMappingURL=chat-snapshot-builder.d.ts.map