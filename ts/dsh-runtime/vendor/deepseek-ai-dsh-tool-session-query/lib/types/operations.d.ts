/**
 * Tool operation orchestration over session-query service capabilities.
 *
 * @module @deepseek-ai/dsh-tool-session-query/operations
 */
import type { Context } from '@deepseek-ai/cordis';
import { type SessionEventSurface } from '@deepseek-ai/dsh-session-query';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { toolInput } from './input.ts';
type SessionSearchArgs = Parameters<typeof toolInput.buildSessionFilters>[0];
interface EventSearchArgs {
    session_id?: string;
    query: string;
    seq_from?: number;
    seq_to?: number;
    time_from?: string;
    time_to?: string;
    event_types?: string[];
    surfaces?: SessionEventSurface[];
}
interface SessionTargetArgs {
    session_id?: string;
}
interface EventTargetArgs extends SessionTargetArgs {
    seq: number;
}
interface EventReadArgs extends EventTargetArgs {
    before?: number;
    after?: number;
}
declare function executeSessionSearch(ctx: Context, args: SessionSearchArgs, exec: ToolRunContext, maxResults: number): Promise<string>;
declare function executeEventSearch(ctx: Context, args: EventSearchArgs, exec: ToolRunContext, maxResults: number): Promise<string>;
declare function executeSessionTrace(ctx: Context, args: SessionTargetArgs, exec: ToolRunContext): Promise<string>;
declare function executeEventTrace(ctx: Context, args: EventTargetArgs, exec: ToolRunContext): Promise<string>;
declare function executeEventRead(ctx: Context, args: EventReadArgs, exec: ToolRunContext): Promise<string>;
/** Five model-facing session-query operation implementations. */
export declare const operations: {
    executeSessionSearch: typeof executeSessionSearch;
    executeEventSearch: typeof executeEventSearch;
    executeSessionTrace: typeof executeSessionTrace;
    executeEventTrace: typeof executeEventTrace;
    executeEventRead: typeof executeEventRead;
};
export {};
//# sourceMappingURL=operations.d.ts.map