import type { ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts';
/** Props for one complete system prompt disclosure. */
export interface SystemPromptRowProps {
    /** Complete model-visible prompt text. */
    text: string;
    /** The owning view's locale seat. */
    t: ChatViewSlotProps['t'];
}
/**
 * Render one complete system prompt as a collapsed disclosure whose expanded
 * body is the same opaque context chrome: 141px code-block scrollport and
 * model-facing text with its real line breaks.
 * @param props - Complete prompt text and the locale seat.
 * @returns The system-prompt disclosure row.
 */
export declare function SystemPromptRow({ text, t }: SystemPromptRowProps): import("react").JSX.Element;
/** System-prompt keyed Chat renderer. */
export declare const SystemPromptNodeView: import("react").MemoExoticComponent<({ node, t, }: Pick<ChatNodeViewProps<"system-prompt">, "node" | "t">) => import("react").JSX.Element>;
//# sourceMappingURL=SystemPromptRow.d.ts.map