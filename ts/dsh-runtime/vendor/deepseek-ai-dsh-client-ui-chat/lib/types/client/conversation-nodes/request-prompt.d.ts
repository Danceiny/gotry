import type { Context } from '@deepseek-ai/cordis';
import type { ConversationNodeDefinition, RequestPromptInspector } from '@deepseek-ai/dsh-client-ui-conversation/client';
declare module '../contract/chat-nodes.ts' {
    interface ChatNodeDataMap {
        /** Complete system prompt rendered for one model request. */
        'system-prompt': {
            readonly text: string;
        };
    }
}
interface RequestPromptState extends ReturnType<RequestPromptInspector> {
    readonly anchorSeq: number;
    readonly showsPrompt: boolean;
    readonly turn?: number;
    readonly step?: number;
}
/**
 * Request-header prompt Definition for the Chat target.
 * @param inspect - the shared prompt interpretation, supplied by the
 * uiConversation service (a client bundle cannot value-import it).
 * @returns the Chat request-prompt Definition.
 */
export declare function requestPromptDefinition(inspect: RequestPromptInspector): ConversationNodeDefinition<RequestPromptState>;
/**
 * Register model-request system prompts in the Chat flow.
 * @param ctx - Owning UI Conversation context.
 */
export declare function registerRequestPromptConversationNode(ctx: Context): void;
export {};
//# sourceMappingURL=request-prompt.d.ts.map