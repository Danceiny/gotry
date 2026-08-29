/**
 * Cordis catalog-specific projection over the compiler-independent Typert
 * model. This module owns Cordis validation and text projection mechanics;
 * callers supply repository-specific type classifications and inherited data.
 * @module @deepseek-ai/dsh-typert-generator
 */
import type { FaceModel, SourceDeclarationModel, TypertFace } from './model.ts';
type Mode = 'emit' | 'bail' | 'waterfall' | 'parallel' | 'serial';
/** One harness event, extracted from an `interface Events` block. */
export interface EventEntry {
    /** Scoped name, e.g. `agent/request`. */
    name: string;
    /** The scope prefix, e.g. `agent` (everything before the first `/`). */
    scope: string;
    /** Full signature text (the method-signature member, JSDoc stripped). */
    signature: string;
    /** Original declaration JSDoc, dedented from its containing interface. */
    jsDoc: string;
    /** Dispatch mode from the `@mode` tag. */
    mode: Mode;
    /** Description prose (JSDoc minus the `@mode` tag), one line per paragraph. */
    doc: string;
    /** Source pointer `packages/…/file.ts:line` of the declaration. */
    source: string;
}
/** One public service method and the source contract attached to it. */
export interface ServiceMethodEntry {
    /** Compiler member category; policy-supplied methods may omit it. */
    kind?: 'method' | 'property';
    /** Public method signature (body stripped). */
    signature: string;
    /** Original method JSDoc, dedented from its containing class. */
    jsDoc: string;
}
/** One harness service, extracted from an `interface Context` block. */
export interface ServiceEntry {
    /** The `ctx.<key>` name, e.g. `llm`. */
    key: string;
    /** The service class/interface name, e.g. `LlmRuntime`. */
    type: string;
    /** Whether the service class is abstract (a seam interface). */
    abstract: boolean;
    /** Class-level JSDoc prose, one line per paragraph. */
    doc: string;
    /** Public methods (bodies stripped), in source order. */
    methods: ServiceMethodEntry[];
    /** Source pointer of the class declaration. */
    source: string;
}
/** A terse inherited-tier entry supplied by the catalog policy. */
export interface InheritedEntry {
    /** Display name of the inherited event or context member group. */
    name: string;
    /** One-line description rendered into the catalog. */
    summary: string;
    /** Source pointer such as `vendor/…:line`. */
    source: string;
}
/** Repository policy consumed by the Cordis catalog parsing and rendering logic. */
export interface CordisCatalogPolicy {
    /** Type names linked from signatures to their documentation pages. */
    readonly linkedTypePages: Readonly<Record<string, string>>;
    /** TypeScript or framework types that need no repository documentation link. */
    readonly foundationTypeNames: ReadonlySet<string>;
    /** Repository types deliberately documented outside the linked data catalog. */
    readonly typeLinkExemptions: Readonly<Record<string, string>>;
    /** Framework Services included in the model-facing runtime catalog but not the harness documentation partition. */
    readonly runtimeServices?: readonly ServiceEntry[];
    /** Harness Services omitted from the model-facing runtime catalog because dynamic Plugins must not call them. */
    readonly runtimeServiceExclusions?: ReadonlySet<string>;
    /** Manually curated framework events inherited by every plugin. */
    readonly inheritedEvents: readonly InheritedEntry[];
    /** Manually curated framework context members inherited by every plugin. */
    readonly inheritedServices: readonly InheritedEntry[];
}
/** Complete model-level Cordis projection used by every text renderer. */
export interface CordisCatalogModel {
    readonly events: readonly EventEntry[];
    readonly services: readonly ServiceEntry[];
}
/** Repository-specific Cordis validation and projection over one Typert face. */
export declare class CordisCatalogProjector {
    private readonly face;
    private readonly sourceDeclarations;
    private readonly policy;
    private readonly renderer;
    /**
     * @param face - analyzed Host or Client face containing package business semantics.
     * @param sourceDeclarations - exported declarations available to the runtime type closure.
     * @param policy - caller-owned type classifications and inherited Cordis data.
     */
    constructor(face: FaceModel, sourceDeclarations: readonly SourceDeclarationModel[], policy: CordisCatalogPolicy);
    /**
     * Validate and project the host model's Cordis API.
     * @returns every validated service and event projected from the host model.
     */
    project(): CordisCatalogModel;
    /**
     * Render the model-facing static API consumed by `tool-cordis`.
     * @param model - validated Cordis catalog projection from this projector.
     * @returns the model-facing TypeScript catalog source.
     */
    renderRuntimeApi(model: CordisCatalogModel): string;
    private collectEvents;
    /**
     * The services this projection describes, one per `ctx.<key>`: those whose
     * Context merge sits one level under a package's `src` and whose declaration
     * belongs to that same package.
     *
     * Interfaces qualify beside classes, because an interface-typed key
     * (`lsp: LspService`) has its Service Definition — and, by repository
     * convention, its member documentation — on the interface; requiring a class
     * would drop a real injectable service from every catalog. The declaration may
     * live in any file of the package (`types.ts` is the usual home), while a
     * declaration from ANOTHER package is not this package's surface to document.
     *
     * One key can have both kinds of candidate across packages: `ctx.typert` is
     * typed by a merge-extensible interface in `type-meta` and implemented by a
     * class in `registry`. The CLASS wins — it carries the documentation and is the
     * object a caller meets — and picking before validating is what keeps a
     * discarded candidate's missing JSDoc from failing the gate.
     */
    private renderableServices;
    private collectServices;
    private runtimeTypes;
}
/**
 * Analyze the host project once and return both the model and its projection.
 * @param scanRoot - workspace root containing `tsconfig.host.json`.
 * @param policy - caller-owned type classifications and inherited Cordis data.
 * @param targetFace - Host or Client Typert face to project.
 * @returns the configured projector and its validated catalog model.
 */
export declare function projectCordisCatalog(scanRoot: string, policy: CordisCatalogPolicy, targetFace?: TypertFace): {
    readonly projector: CordisCatalogProjector;
    readonly model: CordisCatalogModel;
};
/**
 * Collect all modeled events for relationship-document consumers.
 * @param scanRoot - workspace root containing `tsconfig.host.json`.
 * @param policy - caller-owned Cordis catalog policy.
 * @returns all validated event entries.
 */
export declare function collectEvents(scanRoot: string, policy: CordisCatalogPolicy): EventEntry[];
/**
 * Collect all modeled services for relationship-document consumers.
 * @param scanRoot - workspace root containing `tsconfig.host.json`.
 * @param policy - caller-owned Cordis catalog policy.
 * @returns all validated service entries.
 */
export declare function collectServices(scanRoot: string, policy: CordisCatalogPolicy): ServiceEntry[];
/** Opening region delimiter; injected content lives between the pair and the page owns everything outside. */
export declare const REGION_BEGIN = "<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) \u2014 do not edit between markers -->";
/** Closing region delimiter matching {@link REGION_BEGIN}. */
export declare const REGION_END = "<!-- END GENERATED cordis-surface -->";
/**
 * Render one page's generated Cordis API region: the services mapped to
 * the page, then the event scopes mapped to it, markers included. Pure and
 * deterministic given sorted inputs; identical bytes land in both pair sides.
 * @param page - the owning `docs/subsystems/` page basename, e.g. `core.md`.
 * @param services - validated services mapped to this page.
 * @param events - validated events whose scopes map to this page.
 * @param policy - type links supplied by the caller.
 * @returns the complete marker-delimited region text.
 */
export declare function renderPageRegion(page: string, services: ServiceEntry[], events: EventEntry[], policy: CordisCatalogPolicy): string;
/**
 * Render the inherited (pinned vendor) tier as its own generated page.
 * @param policy - inherited events and services supplied by the caller.
 * @returns the complete generated Markdown document.
 */
export declare function renderInheritedPage(policy: CordisCatalogPolicy): string;
export {};
//# sourceMappingURL=cordis-catalog.d.ts.map