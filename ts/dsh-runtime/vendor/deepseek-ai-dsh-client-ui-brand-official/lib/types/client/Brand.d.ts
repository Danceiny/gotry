import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client';
type OfficialBrandMarkProps = HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps;
/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the official whale mark.
 */
export declare function OfficialBrandMark({ size, className }: OfficialBrandMarkProps): import("react").JSX.Element;
/**
 * Render the official name artwork without its independently slotted mark.
 * @returns the official name wordmark.
 */
export declare function OfficialBrandName(): import("react").JSX.Element;
export {};
//# sourceMappingURL=Brand.d.ts.map