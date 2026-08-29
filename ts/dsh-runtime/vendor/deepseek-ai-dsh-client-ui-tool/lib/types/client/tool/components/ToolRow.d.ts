import { type ReactNode } from 'react';
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots';
import { type DiffCardModel } from '../models/diff-card-model.ts';
import { type ReadCardModel } from '../models/read-card-model.ts';
import { type SearchCardModel } from '../models/search-card-model.ts';
import { type TerminalCardModel } from '../models/terminal-card-model.ts';
import type { AskQuestionCardModel } from '../models/ask-question-card-model.ts';
import type { ToolRowState, ToolRowVariant } from '../models/tool-call-model.ts';
import type { WebCardModelProps } from '../models/web-card-model.ts';
export interface ToolRowProps {
    t: TranslateNS<'conversation'>;
    variant: ToolRowVariant;
    /** Wire tool name for tool-owned styling layered over the generic variant. */
    toolName?: string | undefined;
    icon: ReactNode;
    title: string;
    summary: string;
    /**
     * Trailing summary fragment rendered outside the ellipsized summary text, so
     * a narrow row clips the summary before this. For a fragment whose whole
     * value is surviving that clip — the todo row's parallel-active count.
     * null/absent = the summary is the whole collapsed content. Dropped on an
     * error row, whose collapsed summary is the failure line instead.
     */
    summarySuffix?: string | null | undefined;
    /** Expanded-body input text; null = no input section. */
    body: string | null;
    /** Flattened result text for the expanded Output section; null/absent = no output section. */
    output?: string | null | undefined;
    /** Ask-user transcript card; card fields are mutually exclusive and replace text sections. */
    askQuestion?: AskQuestionCardModel | null | undefined;
    /** Error first line shown as the collapsed summary on an error row; null/absent = keep `summary`. */
    errorSummary?: string | null | undefined;
    /** Terminal card; card fields are mutually exclusive and replace text sections. */
    terminal?: TerminalCardModel | null | undefined;
    diff?: DiffCardModel | null | undefined;
    read?: ReadCardModel | null | undefined;
    search?: SearchCardModel | null | undefined;
    web?: WebCardModelProps | null | undefined;
    state: ToolRowState;
    /**
     * Filesystem path from tool args; when set with onOpenFile, the summary
     * renders as a hover-underline link that opens the host default app.
     */
    filePath?: string | undefined;
    /** Open the path with the host OS default application (already cwd-resolved). */
    onOpenFile?: ((path: string) => void) | undefined;
    /**
     * Jump to this call in the trajectory view: a hover-revealed Inspect pill
     * over the expanded body. Absent = no affordance.
     */
    inspect?: (() => void) | undefined;
}
export declare function ToolRow({ t, variant, toolName, icon, title, summary, summarySuffix, body, output, askQuestion, errorSummary, terminal, diff, read, search, web, state, filePath, onOpenFile, inspect, }: ToolRowProps): import("react").JSX.Element;
//# sourceMappingURL=ToolRow.d.ts.map