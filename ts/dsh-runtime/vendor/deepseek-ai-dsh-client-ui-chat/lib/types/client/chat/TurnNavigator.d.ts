import type { ChatViewSlotProps } from '../contract/slots.ts';
import type { TurnNavigationItem } from '../contract/snapshot.ts';
interface TurnNavigatorProps {
    readonly items: readonly TurnNavigationItem[];
    readonly activeTurn: number | null;
    readonly onNavigate: (item: TurnNavigationItem) => void;
    readonly t: ChatViewSlotProps['t'];
}
declare function TurnNavigatorRail({ items, activeTurn, onNavigate, t }: TurnNavigatorProps): import("react").JSX.Element | null;
/**
 * Compact rail of the currently loaded Turns with hover and focus previews.
 *
 * Memoized because it renders two host elements per loaded Turn while the
 * enclosing view re-renders on every streaming delta: without the guard a long
 * session rebuilds hundreds of marks per commit for a rail that only changes
 * when a Turn is added, removed, or becomes active. Its props must therefore
 * stay referentially stable across those commits.
 */
export declare const TurnNavigator: import("react").MemoExoticComponent<typeof TurnNavigatorRail>;
export {};
//# sourceMappingURL=TurnNavigator.d.ts.map