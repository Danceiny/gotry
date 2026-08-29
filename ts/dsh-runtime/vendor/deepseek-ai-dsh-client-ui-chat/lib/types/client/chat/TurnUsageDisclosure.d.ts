import type { TurnTokenUsage } from '../contract/chat-nodes.ts';
import type { ChatViewSlotProps } from '../contract/slots.ts';
export interface TurnUsageDisclosureProps {
    usage: TurnTokenUsage;
    t: ChatViewSlotProps['t'];
}
/** Compact per-Turn usage summary with an opt-in bucket breakdown. */
export declare function TurnUsageDisclosure({ usage, t }: TurnUsageDisclosureProps): import("react").JSX.Element;
//# sourceMappingURL=TurnUsageDisclosure.d.ts.map