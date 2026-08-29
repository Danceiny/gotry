import type { ChatSnapshot, ToolCallBlock } from '../contract/snapshot.ts';
/**
 * Find any root or nested Tool lifecycle through the internal Node store.
 * @param snapshot - current Conversation snapshot.
 * @param callId - root or nested call identity.
 * @returns current Tool lifecycle when materialized in the loaded window.
 */
export declare function findToolCall(snapshot: ChatSnapshot, callId: string): ToolCallBlock | undefined;
//# sourceMappingURL=tool-node-reader.d.ts.map