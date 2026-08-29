export interface CodeBlockProps {
    /** The source text, rendered verbatim (trailing newline trimmed for display). */
    code: string;
    /** Grammar hint (markdown fence info string or a fixed caller id); unknown = plain. */
    lang?: string | undefined;
    /**
     * The code is still growing (a streaming markdown fence): highlight through
     * a per-instance {@link StreamingHighlightSession}, which re-tokenizes only
     * appended text and keeps completed lines' elements (and DOM) untouched.
     * The caller must keep the component instance stable across growth (a
     * stream-stable React key); settled callers omit this and get shiki's HTML.
     */
    streaming?: boolean | undefined;
    /** Extra class merged onto the wrapper (callers position; this component draws). */
    className?: string | undefined;
    /** Copy-button idle label; the owner passes localized copy (this package is cordis-free, so copy arrives via props). */
    copyLabel: string;
    /** Copy-button label during the post-copy confirmation window. */
    copiedLabel: string;
}
export declare function CodeBlock({ code, lang, streaming, className, copyLabel, copiedLabel }: CodeBlockProps): import("react").JSX.Element;
//# sourceMappingURL=CodeBlock.d.ts.map