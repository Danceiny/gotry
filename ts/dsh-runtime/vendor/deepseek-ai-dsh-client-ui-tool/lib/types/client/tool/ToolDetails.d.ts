import type { ToolDetailsProps } from '../contract/slots.ts';
/**
 * Render the selected Tool call's structured output when its raw fields form a
 * supported root card, otherwise preserve the flattened result text.
 * @param props - selected call slice, workspace root, host home, and locale seat.
 * @returns the details output body.
 */
export declare function ToolDetails({ block, cwd, useConnectionGeneration, t, }: Pick<ToolDetailsProps, 'block' | 'cwd' | 'useConnectionGeneration' | 't'>): import("react").JSX.Element;
//# sourceMappingURL=ToolDetails.d.ts.map