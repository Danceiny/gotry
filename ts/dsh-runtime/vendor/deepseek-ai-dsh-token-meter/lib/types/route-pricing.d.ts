/**
 * Route-aware surface pricing: projects the fold's fixed-heuristic nodes onto
 * the routed model's request, replacing every image occurrence's structural
 * price with the route's declared visual tokens plus the model-visible text it
 * actually sends. Without declared pricing every node keeps its fixed
 * heuristic price, so provider-neutral behavior is unchanged.
 *
 * @module @deepseek-ai/dsh-token-meter/route-pricing
 */
import type { LlmImageRequestPricing } from '@deepseek-ai/dsh-llm';
import type { MeterSurfaceNode } from './surface-fold.ts';
import type { TokenSurfaceNode } from './types.ts';
/** One surface priced for a request route: public nodes plus their total. */
export interface PricedSurface {
    /** Positional nodes carrying both the route price and the fixed-heuristic price. */
    readonly nodes: TokenSurfaceNode[];
    /** Sum of the route prices across the surface. */
    readonly surfaceTokens: number;
}
/**
 * Price one ordered surface under a route's request-image pricing.
 * @param nodes - the fold's current or snapshotted surface, in model-visible order.
 * @param pricing - the routed model's image pricing, or undefined to keep the fixed heuristic.
 * @returns detached public nodes and their route-priced total.
 * @throws when the pricing answers a different occurrence count than it was
 *   asked — misalignment would silently misprice nodes, so it must fail loud.
 */
export declare function priceSurface(nodes: readonly MeterSurfaceNode[], pricing: LlmImageRequestPricing | undefined): PricedSurface;
//# sourceMappingURL=route-pricing.d.ts.map