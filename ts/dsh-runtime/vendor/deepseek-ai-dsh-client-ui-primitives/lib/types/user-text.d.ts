/**
 * Display projection of reference forms in sent user text (bubble and queue
 * rows). The logged model text remains the single truth; this is presentation
 * only, and every part renders inline so a single-line message never breaks
 * across lines. Three decoration sources, by precedence: the wire session form
 * `@[label](dsh-session:...)` folds to its label; exact session labels
 * supplied by an adjacent recall decorate their bare `@label` mention; and
 * plain `/name` / `@name` word-boundary tokens decorate by shape alone (sent
 * tokens were validated at compose time).
 */
import type { ReactNode } from 'react';
/**
 * Split one sent text into inline plain runs and reference chips.
 * @param text - the logged model text of the message or queue row.
 * @param sessionLabels - exact session mention labels associated by an adjacent recall.
 * @returns inline nodes covering the whole text.
 */
export declare function projectUserText(text: string, sessionLabels: readonly string[]): ReactNode;
//# sourceMappingURL=user-text.d.ts.map