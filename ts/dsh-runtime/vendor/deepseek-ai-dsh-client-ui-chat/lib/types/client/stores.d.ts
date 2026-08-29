/** Per-Session Chat selection store shared by the transcript and details panel. */
import { type EngineStoreHandle } from '@deepseek-ai/dsh-client-store';
import type { TurnProcessGeneration } from './contract/turn-process.ts';
import type { ChatStoreState, SelectionTarget, TurnProcessViewEntry } from './contract/store.ts';
type ChatActions = {
    select: (draft: ChatStoreState, target: SelectionTarget | null) => void;
    setTurnProcessOpen: (draft: ChatStoreState, turn: number, generation: TurnProcessGeneration, open: boolean) => void;
};
/**
 * Resolve any stored generation for one Turn.
 * @param state - Chat store snapshot.
 * @param turn - owning Turn.
 * @returns the Turn's stored entry, when present.
 */
export declare function storedTurnProcessEntry(state: Readonly<ChatStoreState>, turn: number): Readonly<TurnProcessViewEntry> | undefined;
/**
 * Create the Chat selection store handle.
 * @returns a handle instantiated once per rendered Session scope.
 */
export declare function createChatStore(): EngineStoreHandle<ChatStoreState, ChatActions>;
export {};
//# sourceMappingURL=stores.d.ts.map