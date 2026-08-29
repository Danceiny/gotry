import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { ToolCallViewProps } from '../../contract/slots.ts';
type ReadRowProps = ToolCallViewProps & PropsLocale<'conversation'>;
/**
 * Lets users expand a completed read result and open its reported path.
 */
export declare function ReadRow({ toolName, block, cwd, home, openFile, inspect, t }: ReadRowProps): import("react").JSX.Element;
/** Registers the read tool's conversation row. */
export declare const readToolview: {
    name: string;
    inject: string[];
    apply(ctx: Context): void;
};
export {};
//# sourceMappingURL=read-row.d.ts.map