/**
 * Workspace-level discovery and model-driven Typert generation.
 * @module @deepseek-ai/dsh-typert-generator/workspace
 */
import type { DiscoveredTypertPackage } from './analyzer.ts';
import type { ModelEmitResult } from './emitter.ts';
import type { TypertFace } from './model.ts';
/** One emitted artifact paired with its source package root. */
export interface WorkspaceEmitResult extends ModelEmitResult {
    readonly packageRoot: string;
}
/** Behavior switches for one {@link WorkspaceTypertGenerator}. */
export interface WorkspaceTypertGeneratorOptions {
    /**
     * Run the per-package syntactic/semantic diagnostic pass before analysis
     * (default true). Pass false only when the same orchestration already
     * verified the workspace with tsc; the Typert-specific analysis checks
     * (annotation coverage, private cross-package references, unretainable
     * merges) run regardless.
     */
    readonly checkDiagnostics?: boolean;
}
/** Discover, analyze, and emit package reflection from independent faces. */
export declare class WorkspaceTypertGenerator {
    private readonly root;
    private readonly options;
    /** Parsed-config and program-host state shared by every analyzer this generator creates. */
    private readonly caches;
    /**
     * Bind generation to one workspace root.
     * @param root - directory containing face aggregate tsconfigs.
     * @param options - behavior switches applied to every pass of this generator.
     */
    constructor(root: string, options?: WorkspaceTypertGeneratorOptions);
    /**
     * Find public package faces that contribute Cordis services/events or
     * explicitly tagged Typert roots.
     * @param faces - optional independent program faces to inspect.
     * @returns discovered packages in stable package-name order.
     */
    discover(faces?: readonly TypertFace[]): DiscoveredTypertPackage[];
    /**
     * Generate all discovered contributors, or an explicit package subset.
     * @param packages - optional exact package names for a focused pass.
     * @param faces - optional independent program faces to analyze.
     * @returns one artifact per package face.
     */
    generate(packages?: readonly string[], faces?: readonly TypertFace[]): WorkspaceEmitResult[];
    private validateExport;
}
//# sourceMappingURL=workspace.d.ts.map