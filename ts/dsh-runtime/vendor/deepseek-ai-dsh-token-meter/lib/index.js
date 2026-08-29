import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { BlockAssembler, deepFreeze } from "@deepseek-ai/dsh-llm";
import { canonicalHeader, deriveEventMessage, headerEquals, isSurfaceEvent } from "@deepseek-ai/dsh-session";
import { z as z$1 } from "zod";
//#region lib/types/estimate.js
/**
* Fixed-density heuristic token pricing shared by the meter service and the
* pure context-breakdown projection, so both surfaces price identical content
* to identical numbers.
*
* @module @deepseek-ai/dsh-token-meter/estimate
*/
/** Fixed text-density estimate used until exact tokenization is needed. */
const CHARS_PER_TOKEN = 4;
/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4;
/**
* Structural JSON price of one block outside the typed pricing arms: the
* fixed heuristic for merge-extended blocks and for image references, whose
* request price is route-owned rather than fixed.
* @param block - block to price without mutation.
* @returns heuristic tokens for the block's JSON structure.
*/
function estimateStructuralBlock(block) {
	return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
}
/**
* Price content blocks recursively under the fixed density heuristic.
* @param blocks - content blocks to price without mutation.
* @returns heuristic tokens including per-block structural overhead.
*/
function estimateContent(blocks) {
	let tokens = 0;
	for (const block of blocks) switch (block.type) {
		case "text":
		case "reasoning":
			tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
			break;
		case "tool-call":
			tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN) + Math.ceil(block.arguments.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
			break;
		case "tool-result":
			tokens += estimateContent(block.content) + BLOCK_OVERHEAD;
			break;
		default: tokens += estimateStructuralBlock(block);
	}
	return tokens;
}
/**
* Heuristically price one model-visible message.
* @param message - message to price without mutation.
* @returns content and role-framing tokens under the fixed heuristic.
*/
function estimateMessage(message) {
	return estimateContent(message.content) + 4;
}
/**
* Price the system-prompt part of a canonical request envelope.
* @param header - canonical envelope, or undefined before any request.
* @returns heuristic system-prompt tokens; 0 when absent.
*/
function estimateSystemTokens(header) {
	if (header?.system === void 0) return 0;
	return Math.ceil(header.system.length / CHARS_PER_TOKEN) + 4;
}
/**
* Price the tool-schema part of a canonical request envelope.
* @param header - canonical envelope, or undefined before any request.
* @returns heuristic tool-schema tokens; 0 when absent or empty.
*/
function estimateToolsTokens(header) {
	if (header?.tools === void 0 || header.tools.length === 0) return 0;
	return Math.ceil(JSON.stringify(header.tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
}
/**
* Price the complete non-surface request envelope.
* @param header - canonical envelope, or undefined before any request.
* @returns heuristic system plus tool tokens.
*/
function estimateHeader(header) {
	return estimateSystemTokens(header) + estimateToolsTokens(header);
}
//#endregion
//#region lib/types/surface-projection.js
/**
* The O(1) surface-token fold shared by the token-meter projection units.
*
* A projection state must stay bounded — the persisted projection cache
* checkpoints every unit's whole state, so carrying the priced surface
* (one node per model-visible message) would grow a checkpoint without
* bound over the session's life. Instead, replacements ride the compact
* seam's shadow-price protocol: the metering event immediately before a
* surface `replace` (`compaction/summary` or `compaction/prune`) states the
* heuristic price of the exact replaced range, so the fold keeps a running
* total plus at most one pending claim and never retains per-node prices.
* The counts are exact by construction: producers derive them from the same
* fixed estimator this module prices appends with. A replacement without an
* armed claim folds with zero delta because bounded state cannot reconstruct
* the replaced range; this preserves replay at the cost of possible drift.
*
* @module @deepseek-ai/dsh-token-meter/surface-projection
*/
/**
* Fold one committed event onto a running surface-token total.
*
* A shadow-price event arms a claim; any other event expires it, and a
* surface `replace` consumes the claim naming its exact range — the
* producers append the metering event and the replacement synchronously
* adjacent, so a surviving claim always prices the very next event.
* A replace with no claim folds with zero delta because the bounded state
* cannot reconstruct the replaced range. An armed claim for another range
* still fails because the adjacent events contradict each other.
* @param claim - the claim armed by the immediately preceding event, if any.
* @param event - the next committed session event.
* @returns the signed token delta and the claim state after this event.
* @throws when a replacement arrives with an armed claim for a different
*   range — the metering event was adjacent, so this is a live producer's
*   shadow-price contract violation, not historical data, and must fail
*   loud rather than let the total drift.
*/
function foldSurfaceProjection(claim, event) {
	if (event.type === "compaction/summary" || event.type === "compaction/prune") {
		const { shadowedRange, shadowedTokenCount } = event.data;
		return {
			deltaTokens: 0,
			claim: {
				start: shadowedRange.start,
				end: shadowedRange.end,
				tokens: shadowedTokenCount
			}
		};
	}
	if (!isSurfaceEvent(event)) return {
		deltaTokens: 0,
		claim: void 0
	};
	const message = deriveEventMessage(event);
	const tokens = message === null ? 0 : estimateMessage(message);
	const op = event.surfaceOp;
	if (op === "append") return {
		deltaTokens: tokens,
		claim: void 0
	};
	if (claim === void 0) return {
		deltaTokens: 0,
		claim: void 0
	};
	if (claim.start !== op.start || claim.end !== op.end) throw new Error(`token surface: replace at seq ${event.seq} over range ${op.start}-${op.end} has no adjacent shadow price (armed claim covers ${claim.start}-${claim.end})`);
	return {
		deltaTokens: tokens - claim.tokens,
		claim: void 0
	};
}
//#endregion
//#region lib/types/breakdown-projection.js
/**
* Pure fold for the heuristic context-composition projection: system prompt
* and tool schemas from the newest request envelope, conversation from the
* live surface. Prices with the same shared estimator as the meter service,
* so the three figures match `measure()`'s heuristic vocabulary exactly.
*/
/** Non-negative integer token count (the shared figure shape). */
const tokenCount = z$1.number().int().nonnegative();
/**
* Token-meter's context-composition projection unit.
*
* Envelope figures are last-wins per `request/header`; the message figure
* rides {@link foldSurfaceProjection} — the same O(1) fold the occupancy
* projection uses — so fully metered logs equal the sum of
* `measure().nodes[].heuristicTokens` at every event boundary and compaction
* shrinks the figure by its logged shadow price; the route-priced
* `measure().surfaceTokens` deliberately diverges by the routed model's image
* repricing. A replacement without a claim preserves the previous total. The
* state is a fixed handful of numbers, so the persisted checkpoint stays
* O(1) over the session's life.
*/
const contextBreakdownProjectionDefinition = {
	key: "contextBreakdown",
	stateVersion: 2,
	stateSchema: z$1.object({
		systemTokens: tokenCount,
		toolsTokens: tokenCount,
		messageTokens: tokenCount,
		claim: z$1.object({
			start: tokenCount,
			end: tokenCount,
			tokens: tokenCount
		}).optional()
	}).strict(),
	init: () => ({
		systemTokens: 0,
		toolsTokens: 0,
		messageTokens: 0
	}),
	apply: (state, event) => {
		const fold = foldSurfaceProjection(state.claim, event);
		let systemTokens = state.systemTokens;
		let toolsTokens = state.toolsTokens;
		if (event.type === "request/header") {
			const header = canonicalHeader(event.data.header);
			systemTokens = estimateSystemTokens(header);
			toolsTokens = estimateToolsTokens(header);
		}
		if (systemTokens === state.systemTokens && toolsTokens === state.toolsTokens && fold.deltaTokens === 0 && fold.claim === void 0 && state.claim === void 0) return state;
		return {
			systemTokens,
			toolsTokens,
			messageTokens: state.messageTokens + fold.deltaTokens,
			...fold.claim === void 0 ? {} : { claim: fold.claim }
		};
	},
	wire: {
		viewSchema: z$1.object({
			systemTokens: tokenCount,
			toolsTokens: tokenCount,
			messageTokens: tokenCount
		}).strict(),
		view: ({ systemTokens, toolsTokens, messageTokens }) => ({
			systemTokens,
			toolsTokens,
			messageTokens
		})
	}
};
//#endregion
//#region lib/types/usage-projection.js
/**
* Pure folds for durable provider-reported token usage and context occupancy.
*/
const zeroBuckets = () => ({
	uncachedInputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0
});
const bucketsFrom = (usage) => ({
	uncachedInputTokens: usage.inputTokens,
	outputTokens: usage.outputTokens,
	cacheReadTokens: usage.cacheReadTokens ?? 0,
	cacheWriteTokens: usage.cacheWriteTokens ?? 0
});
const bucketsEqual = (left, right) => left.uncachedInputTokens === right.uncachedInputTokens && left.outputTokens === right.outputTokens && left.cacheReadTokens === right.cacheReadTokens && left.cacheWriteTokens === right.cacheWriteTokens;
const addReplacing = (totals, previous, next) => ({
	uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
	outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
	cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
	cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens
});
const projectionSchema = z$1.object({
	uncachedInputTokens: z$1.number().int().nonnegative(),
	outputTokens: z$1.number().int().nonnegative(),
	cacheReadTokens: z$1.number().int().nonnegative(),
	cacheWriteTokens: z$1.number().int().nonnegative()
}).strict();
/**
* The token-usage unit's state schema — the one definition of the state
* shape; the state type is inferred from it.
*/
const tokenUsageStateSchema = z$1.object({
	totals: projectionSchema,
	last: z$1.object({
		turn: z$1.number().int().nonnegative(),
		step: z$1.number().int().nonnegative(),
		buckets: projectionSchema
	}).nullable()
}).strict();
const pressureSchema = z$1.object({
	pressureTokens: z$1.number().int().nonnegative().optional(),
	projectedTokens: z$1.number().int().nonnegative().optional(),
	contextWindow: z$1.number().int().positive().optional()
}).strict().transform(({ pressureTokens, projectedTokens, contextWindow }) => ({
	...pressureTokens === void 0 ? {} : { pressureTokens },
	...projectedTokens === void 0 ? {} : { projectedTokens },
	...contextWindow === void 0 ? {} : { contextWindow }
}));
/** Prompt-side pressure of one request: input plus cache traffic, no output. */
const pressureFrom = (usage) => usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
/** The usage a chunk or finalized message reports for its step, if any. */
const usageOf = (event) => event.type === "assistant/chunk" && event.data.chunk.type === "usage" ? event.data.chunk.usage : event.type === "assistant/message" ? event.data.usage : void 0;
/** The context-pressure state schema and source of its inferred type. */
const contextPressureStateSchema = z$1.object({
	contextWindow: z$1.number().int().positive().optional(),
	pressureTokens: z$1.number().int().nonnegative().optional(),
	surfaceTokens: z$1.number().int().nonnegative(),
	sampledSurfaceTokens: z$1.number().int().nonnegative().optional(),
	claim: z$1.object({
		start: z$1.number().int().nonnegative(),
		end: z$1.number().int().nonnegative(),
		tokens: z$1.number().int().nonnegative()
	}).optional()
}).strict();
/**
* Token-meter's session projection unit.
*
* Usage chunks provide an early sample that survives a later request failure;
* an assistant message provides the final sample for the same attempt. A
* repeated sample replaces that attempt's earlier value instead of double
* counting it, while `llm/retry-started` closes the replacement slot so the
* retried attempt adds to the total. The single `last` slot relies on the
* session-log invariant that usage reports for one attempt are adjacent.
*/
const tokenUsageProjectionDefinition = {
	key: "tokenUsage",
	stateVersion: 2,
	stateSchema: tokenUsageStateSchema,
	init: () => ({
		totals: zeroBuckets(),
		last: null
	}),
	apply: (state, event) => {
		if (event.type === "llm/retry-started") return state.last?.turn === event.data.turn && state.last.step === event.data.step ? {
			...state,
			last: null
		} : state;
		let turn;
		let step;
		let usage;
		if (event.type === "assistant/chunk" && event.data.chunk.type === "usage") {
			({turn, step} = event.data);
			usage = event.data.chunk.usage;
		} else if (event.type === "assistant/message" && event.data.usage !== void 0) ({turn, step, usage} = event.data);
		else return state;
		const buckets = bucketsFrom(usage);
		const previous = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last.buckets : void 0;
		if (previous !== void 0 && bucketsEqual(previous, buckets)) return state;
		return {
			totals: addReplacing(state.totals, previous, buckets),
			last: {
				turn,
				step,
				buckets
			}
		};
	},
	wire: {
		viewSchema: projectionSchema,
		view: (state) => state.totals
	}
};
/**
* Token-meter's context-occupancy projection unit.
*
* Independent last-wins slots: the newest usage sample supplies the provider
* numerator, the newest `request/context` record the denominator. Both are
* whole values, so replay order alone decides the result and no cross-field
* consistency is claimed — the pair is explicitly not one atomic request
* observation (see {@link ContextPressureProjection}).
*
* `pressureTokens` is prompt-side only, so it holds still while a turn streams
* and steps forward once the next request reports its usage. Because nothing
* but a request reports usage, it also cannot see a compaction: the fold
* therefore carries a running surface total alongside it and publishes
* `projectedTokens` — the sample plus the surface's signed movement since it
* was taken — so occupancy answers for the next request rather than the last
* one. The total rides {@link foldSurfaceProjection}, so the state stays O(1)
* and a replacement shrinks it by its logged shadow price. A replacement
* without a claim preserves the previous total. A usage sample is stamped
* BEFORE the same event joins the surface, so an `assistant/message` anchors
* against the surface its own request saw.
*/
const contextPressureProjectionDefinition = {
	key: "contextPressure",
	stateVersion: 4,
	stateSchema: contextPressureStateSchema,
	init: () => ({ surfaceTokens: 0 }),
	apply: (state, event) => {
		const fold = foldSurfaceProjection(state.claim, event);
		let next = state;
		if (event.type === "request/context") {
			const contextWindow = event.data.contextWindow;
			if (contextWindow !== state.contextWindow) if (contextWindow !== void 0) next = {
				...next,
				contextWindow
			};
			else {
				const { contextWindow: _removed, ...withoutContextWindow } = next;
				next = withoutContextWindow;
			}
		}
		const usage = usageOf(event);
		if (usage !== void 0) {
			const pressureTokens = pressureFrom(usage);
			if (pressureTokens !== next.pressureTokens || next.sampledSurfaceTokens !== next.surfaceTokens) next = {
				...next,
				pressureTokens,
				sampledSurfaceTokens: next.surfaceTokens
			};
		}
		if (fold.deltaTokens !== 0) next = {
			...next,
			surfaceTokens: next.surfaceTokens + fold.deltaTokens
		};
		if (state.claim === void 0 && fold.claim === void 0) return next;
		const { claim: _expired, ...withoutClaim } = next;
		return fold.claim === void 0 ? withoutClaim : {
			...withoutClaim,
			claim: fold.claim
		};
	},
	wire: {
		viewSchema: pressureSchema,
		view: ({ contextWindow, pressureTokens, surfaceTokens, sampledSurfaceTokens }) => ({
			...contextWindow === void 0 ? {} : { contextWindow },
			...pressureTokens === void 0 ? {} : { pressureTokens },
			...pressureTokens === void 0 || sampledSurfaceTokens === void 0 ? {} : { projectedTokens: Math.max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens) }
		})
	}
};
//#endregion
//#region lib/types/surface-fold.js
/**
* The measurement service's positional surface fold: the per-node priced
* surface `measure()` serves and compaction plans against. The projection
* units do NOT share this fold — their state must stay O(1) for the
* persisted checkpoint, so they ride `surface-projection.ts`'s shadow-price
* protocol; the two agree because both price through `estimate.ts` and every
* logged shadow price derives from this fold's fixed-heuristic node prices.
*
* The fold is a plan/commit pair: {@link planSurfaceTokens} runs every
* fallible step read-only and {@link commitSurfaceTokens} mutates in place,
* so a throw leaves the caller's state untouched and the same malformed
* event fails identically on every retry.
* Nodes also carry their durable image occurrences and image-free heuristic
* price, so `measure()` can reprice image content for the routed model.
*
* @module @deepseek-ai/dsh-token-meter/surface-fold
*/
/** Collect image occurrences recursively and total their structural prices. */
function collectImages(blocks, images) {
	let structuralTokens = 0;
	for (const block of blocks) if (block.type === "image") {
		images.push(block.attachment);
		structuralTokens += estimateStructuralBlock(block);
	} else if (block.type === "tool-result") structuralTokens += collectImages(block.content, images);
	return structuralTokens;
}
/** Build one priced node from a surface event's derived message. */
function analyzeNode(seq, message) {
	if (message === null) return {
		seq,
		heuristicTokens: 0,
		imageFreeTokens: 0,
		images: []
	};
	const heuristicTokens = estimateMessage(message);
	const images = [];
	return {
		seq,
		heuristicTokens,
		imageFreeTokens: heuristicTokens - collectImages(message.content, images),
		images
	};
}
/**
* Validate and price one surface event without mutating the surface.
* @param nodes - the priced surface preceding this event, in model-visible order.
* @param event - the surface event to place.
* @returns the plan for {@link commitSurfaceTokens}.
* @throws when a replacement names a range absent from `nodes` — committed
*   logs are surface-validated at append time, so an unresolvable range is log
*   corruption and must fail loud rather than skip the event.
*/
function planSurfaceTokens(nodes, event) {
	const node = analyzeNode(event.seq, deriveEventMessage(event));
	const tokens = node.heuristicTokens;
	const op = event.surfaceOp;
	if (op === "append") return {
		tokens,
		deltaTokens: tokens,
		node,
		target: "append"
	};
	const startIdx = nodes.findIndex((candidate) => candidate.seq === op.start);
	const endIdx = nodes.findIndex((candidate) => candidate.seq === op.end);
	if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) throw new Error(`token surface: replace at seq ${event.seq} has invalid current range ${op.start}-${op.end}`);
	return {
		tokens,
		deltaTokens: tokens - nodes.slice(startIdx, endIdx + 1).reduce((total, candidate) => total + candidate.heuristicTokens, 0),
		node,
		target: {
			startIdx,
			endIdx
		}
	};
}
/**
* Apply one validated plan to the priced surface in place; infallible, so it
* cannot leave a half-applied surface behind.
* @param nodes - the exact priced surface the plan was built against.
* @param plan - the transition returned by {@link planSurfaceTokens}.
*/
function commitSurfaceTokens(nodes, plan) {
	if (plan.target === "append") {
		nodes.push(plan.node);
		return;
	}
	nodes.splice(plan.target.startIdx, plan.target.endIdx - plan.target.startIdx + 1, plan.node);
}
//#endregion
//#region lib/types/route-pricing.js
/**
* Route-aware surface pricing: projects the fold's fixed-heuristic nodes onto
* the routed model's request, replacing every image occurrence's structural
* price with the route's declared visual tokens plus the model-visible text it
* actually sends. Without declared pricing every node keeps its fixed
* heuristic price, so provider-neutral behavior is unchanged.
*
* @module @deepseek-ai/dsh-token-meter/route-pricing
*/
/**
* Price one ordered surface under a route's request-image pricing.
* @param nodes - the fold's current or snapshotted surface, in model-visible order.
* @param pricing - the routed model's image pricing, or undefined to keep the fixed heuristic.
* @returns detached public nodes and their route-priced total.
* @throws when the pricing answers a different occurrence count than it was
*   asked — misalignment would silently misprice nodes, so it must fail loud.
*/
function priceSurface(nodes, pricing) {
	const images = pricing === void 0 ? [] : nodes.flatMap((node) => node.images);
	if (pricing === void 0 || images.length === 0) {
		let surfaceTokens = 0;
		return {
			nodes: nodes.map((node) => {
				surfaceTokens += node.heuristicTokens;
				return {
					seq: node.seq,
					tokens: node.heuristicTokens,
					heuristicTokens: node.heuristicTokens
				};
			}),
			surfaceTokens
		};
	}
	const prices = pricing.priceImages(images);
	if (prices.length !== images.length) throw new Error(`token meter: route image pricing answered ${prices.length} prices for ${images.length} occurrences`);
	let cursor = 0;
	let surfaceTokens = 0;
	return {
		nodes: nodes.map((node) => {
			let tokens = node.heuristicTokens;
			if (node.images.length > 0) {
				tokens = node.imageFreeTokens;
				for (let occurrence = 0; occurrence < node.images.length; occurrence += 1) {
					const price = prices[cursor];
					cursor += 1;
					tokens += price.visualTokens + estimateContent([{
						type: "text",
						text: price.text
					}]);
				}
			}
			surfaceTokens += tokens;
			return {
				seq: node.seq,
				tokens,
				heuristicTokens: node.heuristicTokens
			};
		}),
		surfaceTokens
	};
}
//#endregion
//#region lib/types/index.js
/**
* Single replay-aware token-meter service for request and surface pressure.
*
* @module @deepseek-ai/dsh-token-meter
*/
/** Sum disjoint provider usage buckets without double-counting reasoning output. */
function usageTokens(usage) {
	return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens;
}
/** Compare optional envelopes so a headerless estimate can track later surface deltas. */
function optionalHeaderEquals(left, right) {
	if (left === void 0 || right === void 0) return left === right;
	return headerEquals(left, right);
}
/** Reject stale or misspelled keys before defaults can hide them. */
function validateConfigKeys(config) {
	for (const key of Object.keys(config)) throw new Error(`TokenMeterConfig: unknown key "${key}" (no settings are supported)`);
}
/** Replay owner for one service-wide estimator and isolated per-session folds. */
var TokenMeter = class extends Service {
	static Config = z.object({});
	states = /* @__PURE__ */ new WeakMap();
	constructor(ctx, config = {}) {
		super(ctx, "tokenMeter");
		validateConfigKeys(config);
		ctx.inject(["sessionProjections"], (projectionCtx) => {
			projectionCtx.sessionProjections.register(tokenUsageProjectionDefinition);
			projectionCtx.sessionProjections.register(contextPressureProjectionDefinition);
			projectionCtx.sessionProjections.register(contextBreakdownProjectionDefinition);
		});
		ctx.on("session/event", (session) => {
			if (this.states.has(session)) this._sync(session);
		});
	}
	/**
	* Measure current request pressure and surface through the durable tail.
	*
	* The effective envelope's routed provider/model selects the request-image
	* pricing every node is priced under: a route whose adapter declares image
	* pricing charges each retained image its visual tokens plus its
	* model-visible text, while other routes keep the fixed heuristic. Provider
	* usage is reused only when the latest successful call's canonical request
	* envelope matches `requestHeader` and its total is no lower than that
	* call's full route-priced anchor; otherwise the complete envelope and
	* surface are repriced.
	*
	* `requestHeader` replaces the latest logged envelope for pressure and node
	* pricing; the node set always describes the current session surface. Every
	* call clones those positional nodes, so measurement is O(surface).
	*
	* @param session - session to replay through its current durable tail.
	* @param requestHeader - optional effective request envelope replacing the latest logged header.
	* @returns a detached deeply immutable pressure and surface measurement.
	*/
	measure(session, requestHeader) {
		const state = this._sync(session);
		const header = requestHeader === void 0 ? state.header : canonicalHeader(requestHeader);
		const pricing = this._routeImagePricing(header);
		const surface = priceSurface(state.surface, pricing);
		const anchor = state.anchor;
		let baseline;
		let surfaceDeltaTokens;
		if (anchor !== void 0 && optionalHeaderEquals(anchor.header, header)) {
			const anchorSurfaceTokens = priceSurface(anchor.nodes, pricing).surfaceTokens + anchor.assistantTokens;
			const estimatedAnchorTokens = estimateHeader(header) + anchorSurfaceTokens;
			const usage = anchor.usage;
			baseline = usage !== void 0 && usageTokens(usage) >= estimatedAnchorTokens ? {
				kind: "usage",
				tokens: usageTokens(usage),
				usage
			} : {
				kind: "estimated",
				tokens: estimatedAnchorTokens
			};
			surfaceDeltaTokens = surface.surfaceTokens - anchorSurfaceTokens;
		} else if (header === void 0 && surface.surfaceTokens === 0) {
			baseline = {
				kind: "none",
				tokens: 0
			};
			surfaceDeltaTokens = 0;
		} else {
			baseline = {
				kind: "estimated",
				tokens: estimateHeader(header) + surface.surfaceTokens
			};
			surfaceDeltaTokens = 0;
		}
		return deepFreeze(structuredClone({
			logRevision: state.consumedEvents,
			baseline,
			surfaceDeltaTokens,
			totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens),
			surfaceTokens: surface.surfaceTokens,
			nodes: surface.nodes
		}));
	}
	/** Resolve the routed model's image pricing, when the llm service and route declare one. */
	_routeImagePricing(header) {
		const config = header?.config;
		if (config === void 0) return void 0;
		return this.ctx.get("llm")?.imageRequestPricing(config.provider, config.model);
	}
	/**
	* Heuristically price one model-visible message (instance face of the pure
	* `estimateMessage` export from `estimate.ts`).
	* @param message - message to price without mutation.
	* @returns content and role-framing tokens under the fixed service heuristic.
	*/
	estimateMessage(message) {
		return estimateMessage(message);
	}
	/** Catch one session's fold up to the current durable tail. */
	_sync(session) {
		let state = this.states.get(session);
		if (state === void 0) {
			state = {
				consumedEvents: 0,
				header: void 0,
				surface: [],
				stepStart: void 0,
				anchor: void 0
			};
			this.states.set(session, state);
		}
		while (state.consumedEvents < session.events.length) {
			const event = session.events[state.consumedEvents];
			this._foldEvent(session, state, event);
			state.consumedEvents += 1;
		}
		return state;
	}
	/**
	* Run every fallible step — surface plan and anchor validation — before
	* mutating replay state, so a malformed event remains unread on every
	* retry instead of half-applying.
	*/
	_foldEvent(session, state, event) {
		let nextHeader = state.header;
		let nextStepStart = state.stepStart;
		let nextAnchor = state.anchor;
		switch (event.type) {
			case "request/header":
				nextHeader = canonicalHeader(event.data.header);
				break;
			case "step/start":
				if (state.stepStart !== void 0) throw new Error(`token meter: step/start at seq ${event.seq} arrived before turn ${state.stepStart.turn}/step ${state.stepStart.step} ended`);
				nextStepStart = {
					...event.data,
					nodes: [...state.surface]
				};
				break;
			case "step/end":
				if (state.stepStart === void 0 || state.stepStart.turn !== event.data.turn || state.stepStart.step !== event.data.step) throw new Error(`token meter: step/end at seq ${event.seq} has no matching step/start event`);
				nextStepStart = void 0;
				break;
			default: break;
		}
		const plan = isSurfaceEvent(event) ? planSurfaceTokens(state.surface, event) : void 0;
		if (event.type === "assistant/message") {
			const stepStart = state.stepStart;
			if (stepStart === void 0 || stepStart.turn !== event.data.turn || stepStart.step !== event.data.step) throw new Error(`token meter: assistant/message at seq ${event.seq} has no matching step/start event`);
			const eventTokens = plan.tokens;
			if (event.data.usage !== void 0 && nextHeader !== void 0) nextAnchor = {
				header: nextHeader,
				nodes: stepStart.nodes,
				assistantTokens: this._estimateProviderAssistant(session, event, eventTokens),
				usage: event.data.usage
			};
			else nextAnchor = {
				header: nextHeader,
				nodes: stepStart.nodes,
				assistantTokens: eventTokens,
				usage: void 0
			};
		}
		state.header = nextHeader;
		state.stepStart = nextStepStart;
		if (plan !== void 0) commitSurfaceTokens(state.surface, plan);
		state.anchor = nextAnchor;
	}
	/**
	* Reassemble provider output from the exact cited chunk seqs for a usage anchor.
	* Missing legacy source seqs conservatively treat the durable output as the
	* provider output; an explicit empty list prices a known empty stream.
	*/
	_estimateProviderAssistant(session, event, durableEventTokens) {
		const sourceSeqs = event.sourceEventSeqs;
		if (sourceSeqs === void 0) return durableEventTokens;
		const assembler = new BlockAssembler();
		const seen = /* @__PURE__ */ new Set();
		for (const seq of sourceSeqs) {
			if (seq >= event.seq) throw new Error(`token meter: assistant/message at seq ${event.seq} source seq ${seq} is not earlier`);
			if (seen.has(seq)) throw new Error(`token meter: assistant/message at seq ${event.seq} repeats source seq ${seq}`);
			seen.add(seq);
			const sourceEvent = session.events[seq];
			if (sourceEvent.type !== "assistant/chunk") throw new Error(`token meter: assistant/message at seq ${event.seq} source seq ${seq} is not assistant/chunk`);
			if (sourceEvent.data.turn !== event.data.turn || sourceEvent.data.step !== event.data.step) throw new Error(`token meter: assistant/message at seq ${event.seq} source seq ${seq} belongs to another step`);
			assembler.push(sourceEvent.data.chunk);
		}
		const providerContent = assembler.blocks();
		return providerContent.length === 0 ? 0 : estimateContent(providerContent) + 4;
	}
};
//#endregion
export { TokenMeter, TokenMeter as default };
