import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts';
interface ChatNodeSeatProps extends ChatNodeOwnerProps {
    readonly nodeKey: string;
    readonly historyIncomplete: boolean;
    readonly compactTranscript: boolean;
    readonly useChat: ChatViewSlotProps['useChat'];
    readonly useStore: ChatViewSlotProps['useStore'];
    readonly actions: ChatViewSlotProps['actions'];
    readonly renderSlot: ChatViewSlotProps['renderSlot'];
    readonly t: ChatViewSlotProps['t'];
}
/** Subscribe, apply Turn-process visibility, and dispatch one stable Context key. */
export declare const ChatNodeSeat: import("react").MemoExoticComponent<({ nodeKey, historyIncomplete, compactTranscript, selectedCallId, cwd, openFile, inspectCall, forkAt, renderMessageImages, fileMentions, useChat, useStore, actions, renderSlot, t, }: ChatNodeSeatProps) => import("react").JSX.Element | null>;
export {};
//# sourceMappingURL=ChatNodeSeat.d.ts.map