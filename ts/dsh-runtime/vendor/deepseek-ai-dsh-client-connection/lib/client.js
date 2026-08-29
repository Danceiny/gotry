window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-connection",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region lib/types/client/connection.js
		const CONNECTION_DEFAULTS = {
			backoffBaseMs: 500,
			backoffFactor: 2,
			backoffMaxMs: 1e4,
			generationReadyTimeoutMs: 3e3
		};
		function sleep(ms, signal) {
			return new Promise((resolve) => {
				const t = setTimeout(done, ms);
				signal.addEventListener("abort", done, { once: true });
				function done() {
					clearTimeout(t);
					signal.removeEventListener("abort", done);
					resolve();
				}
			});
		}
		/**
		* Opens the registered generation source, reconnecting with exponential backoff on loss.
		* State (generation/attempt) is instance-private, never in the store.
		* Sink exceptions do not kill the generation loop.
		*/
		var ConnectionController = class {
			source;
			sinks;
			generation = 0;
			attempt = 0;
			current = null;
			running = false;
			lastState = null;
			config;
			constructor(source, sinks = {}, config = {}) {
				this.source = source;
				this.sinks = sinks;
				this.config = {
					...CONNECTION_DEFAULTS,
					...config
				};
			}
			/** Idempotent: begin the connect/pump/reconnect loop. */
			start() {
				if (this.running) return;
				this.running = true;
				this.loop();
			}
			/** Stop the loop and abort the current generation source. */
			stop() {
				this.running = false;
				this.current?.abort();
				this.current = null;
			}
			backoffDelay(attempt) {
				const { backoffBaseMs, backoffFactor, backoffMaxMs } = this.config;
				const cap = Math.min(backoffMaxMs, backoffBaseMs * backoffFactor ** Math.max(0, attempt - 1));
				return cap / 2 + Math.random() * (cap / 2);
			}
			/** Read through a method: stop() flips the flag across awaits, so narrowing from the loop condition must not stick. */
			isRunning() {
				return this.running;
			}
			/** Re-read both mutable liveness guards after a potentially reentrant sink. */
			isGenerationActive(controller) {
				return this.isRunning() && !controller.signal.aborted;
			}
			async loop() {
				while (this.running) {
					const gen = ++this.generation;
					const ac = new AbortController();
					this.current = ac;
					let sourceReady = false;
					let resolveReady;
					let rejectReady;
					let rejectSourceLost;
					const ready = new Promise((resolve, reject) => {
						resolveReady = resolve;
						rejectReady = reject;
					});
					const sourceLost = new Promise((_resolve, reject) => {
						rejectSourceLost = reject;
					});
					const reportReady = (host) => {
						if (sourceReady) return;
						sourceReady = true;
						resolveReady(host);
					};
					const failed = new Promise((resolve) => {
						const settle = () => {
							if (gen === this.generation && !ac.signal.aborted) ac.abort();
							resolve();
						};
						Promise.resolve().then(() => this.source(ac.signal, reportReady)).then(() => {
							const error = /* @__PURE__ */ new Error("connection generation ended");
							if (!sourceReady) rejectReady(error);
							rejectSourceLost(error);
							settle();
						}, (error) => {
							const failure = error instanceof Error ? error : new Error("connection generation failed", { cause: error });
							if (!sourceReady) rejectReady(failure);
							rejectSourceLost(failure);
							settle();
						});
					});
					try {
						const host = await Promise.race([waitForReady(ready, this.config.generationReadyTimeoutMs, ac.signal), sourceLost]);
						if (ac.signal.aborted) throw new Error("generation aborted during readiness handshake");
						this.attempt = 0;
						this.emitState("connected");
						if (this.isGenerationActive(ac)) this.callSink(() => {
							this.sinks.onConnected?.(host);
						});
					} catch {
						if (!ac.signal.aborted) ac.abort();
					}
					await failed;
					if (!this.isRunning()) return;
					this.emitState("reconnecting");
					this.attempt += 1;
					console.warn(`[connection] connection lost, retry #${this.attempt}`);
					const idle = new AbortController();
					await sleep(this.backoffDelay(this.attempt), idle.signal);
				}
			}
			/** Deduplicated state emission (sink isolation applies). */
			emitState(state) {
				if (this.lastState === state) return;
				this.lastState = state;
				this.callSink(() => this.sinks.onStateChange?.(state));
			}
			/** Sink exception isolation: a business-layer throw is logged only, never affecting pump or reconnect semantics. */
			callSink(fn) {
				try {
					fn();
				} catch (error) {
					console.error("[connection] connection sink threw:", error);
				}
			}
		};
		/** Await source readiness without letting a stalled carrier wedge startup forever. */
		function waitForReady(ready, timeoutMs, signal) {
			return new Promise((resolve, reject) => {
				let settled = false;
				const timeout = setTimeout(() => {
					finish({ error: /* @__PURE__ */ new Error(`connection generation was not ready within ${String(timeoutMs)}ms`) });
				}, timeoutMs);
				const aborted = () => {
					finish({ error: new Error("connection generation aborted", { cause: signal.reason }) });
				};
				const finish = (outcome) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					signal.removeEventListener("abort", aborted);
					if ("error" in outcome) reject(outcome.error);
					else resolve(outcome.value);
				};
				signal.addEventListener("abort", aborted, { once: true });
				ready.then((value) => {
					finish({ value });
				}, (error) => {
					finish({ error });
				});
			});
		}
		//#endregion
		//#region ../../util/crypto/lib/index.js
		/**
		* Random v4 UUID, minted from `crypto.getRandomValues`.
		* @returns the UUID string.
		*/
		function randomUUID() {
			const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
			const hex = Array.from(bytes, (byte, index) => {
				return (index === 6 ? byte & 15 | 64 : index === 8 ? byte & 63 | 128 : byte).toString(16).padStart(2, "0");
			}).join("");
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		}
		//#endregion
		//#region ../../llm/llm/lib/types/brand.js
		/**
		* dsh-llm's owned branded ids: tool-call correlation and provider request
		* diagnostics.
		*
		* The `Branded<B>` primitive itself lives in `@deepseek-ai/dsh-brand` (a
		* zero-dependency type-only package) so every owner of a cross-boundary id can
		* brand it without depending on dsh-llm; see that package's README for the
		* nominal-typing policy.
		*
		* @module @deepseek-ai/dsh-llm/brand
		*/
		/**
		* Brand a message identifier.
		* @param id - the opaque message identifier.
		* @returns the same string, branded; no validation is performed.
		*/
		function MessageId(id) {
			return id;
		}
		/**
		* Brand a string as a {@link ToolCallId}.
		* @param id - the provider-issued (or synthesized) call id.
		* @returns the same string, branded; no validation is performed.
		*/
		function ToolCallId(id) {
			return id;
		}
		//#endregion
		//#region ../../llm/llm/lib/types/call-config.js
		/**
		* Deep-freeze a value in place with an iterative traversal, guarding cycles,
		* so later mutation throws without imposing a JavaScript call-stack depth cap.
		* {@link AbortSignal} objects are deliberately skipped because they are the
		* request's live cancellation channel and freezing them breaks abort.
		* @param value - the value to freeze in place.
		* @returns the same value, frozen.
		*/
		function deepFreeze(value) {
			const seen = /* @__PURE__ */ new WeakSet();
			const pending = [{
				kind: "visit",
				node: value
			}];
			while (pending.length > 0) {
				const task = pending.pop();
				/* v8 ignore next -- the loop condition guarantees one pending task. */
				if (task === void 0) continue;
				if (task.kind === "property") {
					pending.push({
						kind: "visit",
						node: task.source[task.key]
					});
					continue;
				}
				const node = task.node;
				if (node === null || typeof node !== "object") continue;
				if (node instanceof AbortSignal) continue;
				if (seen.has(node)) continue;
				seen.add(node);
				Object.freeze(node);
				const keys = Object.keys(node);
				for (let index = keys.length - 1; index >= 0; index--) {
					const key = keys[index];
					/* v8 ignore next -- the loop is bounded by the captured key count. */
					if (key === void 0) continue;
					pending.push({
						kind: "property",
						source: node,
						key
					});
				}
			}
			return value;
		}
		//#endregion
		//#region ../../llm/llm/lib/types/message.js
		/** Message value types, identity, and immutable construction helpers. */
		/**
		* Detach and deep-freeze a message whose identity already exists.
		* @param message - complete message, including its stable identity.
		* @returns an immutable snapshot that preserves the identity.
		*/
		function freezeMessage(message) {
			return deepFreeze(structuredClone(message));
		}
		/**
		* Create one identified message and freeze it before publication.
		* @param input - complete role, content, and source for a new message.
		* @returns an immutable message with a fresh stable identity.
		*/
		function createMessage(input) {
			return freezeMessage({
				...input,
				id: MessageId(randomUUID())
			});
		}
		/**
		* Create one identified user-role message and freeze it before publication.
		* @param input - complete content and source for a new user message.
		* @returns an immutable user message with a fresh stable identity.
		*/
		function createUserMessage(input) {
			return createMessage({
				...input,
				role: "user"
			});
		}
		/**
		* Create one identified model-produced assistant message and freeze it before publication.
		* @param input - complete content plus the provider, model, and optional replay state for a new assistant message.
		* @returns an immutable assistant message with fixed role/source tags and a fresh stable identity.
		*/
		function createAssistantMessage(input) {
			return createMessage({
				role: "assistant",
				content: input.content,
				source: {
					kind: "model",
					...input.source
				}
			});
		}
		/**
		* Create and freeze one identified tool-result message.
		* @param input - call identity, raw result blocks, and outcome.
		* @returns an immutable user-role tool-result message.
		*/
		function createToolResultMessage(input) {
			return createUserMessage({
				source: {
					kind: "tool",
					callId: input.callId
				},
				content: [{
					type: "tool-result",
					toolCallId: input.callId,
					content: input.content,
					isError: input.isError
				}]
			});
		}
		//#endregion
		//#region ../../core/session/lib/types/chunk-rows.js
		/**
		* Lossless row packing for `assistant/chunk` delta runs. Providers stream
		* token-sized deltas, so a log stores hundreds of near-identical event lines
		* whose JSON envelopes dwarf their payloads (~56× measured on a real DeepSeek
		* session). This module packs each run of consecutive same-block delta chunks
		* into ONE storage row — `text-chunks`, `reasoning-chunks`, or
		* `tool-call-chunks` — and expands rows back to the exact original events.
		*
		* Packed rows are an encoding vocabulary, NOT session events: they never enter
		* `Session.events`, have no `SessionEventMap` entry, and use bare (slash-less)
		* type tags so a reader cannot confuse them with the event taxonomy
		* (precedent: the JSONL header line's `session` tag). Persistence and bounded
		* history transport both use the codec. The encoder whitelists exact shapes —
		* anything it does not fully recognize stays verbatim, so unknown fields or
		* future chunk variants lose compression, never data. The decoder validates
		* before expanding and fails loud on a malformed row-tagged value instead of
		* silently dropping a whole run.
		*
		* @module @deepseek-ai/dsh-session/chunk-rows
		*/
		/**
		* Test whether an encoded record is a packed chunk row rather than a Session event.
		* @param record - one persistence or bounded-history encoding record.
		* @returns Whether the record is a packed chunk row.
		*/
		function isChunkRow(record) {
			return record.type === "text-chunks" || record.type === "reasoning-chunks" || record.type === "tool-call-chunks";
		}
		/**
		* Minimum members before a run packs. Below it a row's envelope rivals the
		* event lines it replaces. A format constant, not a tunable: both layouts
		* decode identically, so changing it never invalidates stored logs.
		*/
		const MIN_RUN = 3;
		function isRecord$1(value) {
			return typeof value === "object" && value !== null;
		}
		/** Exact-key check: `value` has every key in `keys` and nothing else. */
		function hasExactKeys(value, keys) {
			return Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));
		}
		/**
		* Classify an event for packing: its delta kind when the ENTIRE shape
		* (envelope, data, chunk — exact keys, primitive types, integer seq/time) is
		* whitelisted, else `undefined` (store verbatim). Inputs come from live typed
		* appends AND parsed fixture files, so the checks are structural, not
		* type-trusted. Integer times keep gap encoding exact: a fractional time would
		* reconstruct through float subtraction/addition, which need not round-trip.
		*/
		function classify(event) {
			if (event.type !== "assistant/chunk") return void 0;
			if (!hasExactKeys(event, [
				"type",
				"seq",
				"time",
				"data"
			])) return void 0;
			if (!Number.isSafeInteger(event.seq) || event.seq < 0 || !Number.isSafeInteger(event.time)) return void 0;
			const data = event.data;
			if (!isRecord$1(data) || !hasExactKeys(data, [
				"turn",
				"step",
				"chunk"
			])) return void 0;
			if (typeof data.turn !== "number" || typeof data.step !== "number") return void 0;
			const chunk = data.chunk;
			if (!isRecord$1(chunk) || typeof chunk.index !== "number") return void 0;
			switch (chunk.type) {
				case "text-delta":
				case "reasoning-delta": return hasExactKeys(chunk, [
					"type",
					"index",
					"text"
				]) && typeof chunk.text === "string" ? chunk.type : void 0;
				case "tool-call-delta": return (hasExactKeys(chunk, [
					"type",
					"index",
					"id",
					"argumentsDelta"
				]) || hasExactKeys(chunk, [
					"type",
					"index",
					"id",
					"name",
					"argumentsDelta"
				]) && typeof chunk.name === "string") && typeof chunk.id === "string" && typeof chunk.argumentsDelta === "string" ? chunk.type : void 0;
				default: return;
			}
		}
		/** The tool-call fields of a whitelisted delta chunk (only after {@link classify} returned `'tool-call-delta'`). */
		function toolCallOf(event) {
			return event.data.chunk;
		}
		/** The block index of a whitelisted delta chunk (not every {@link StreamChunk} variant carries one). */
		function indexOf(event) {
			return event.data.chunk.index;
		}
		/** Whether `next` extends a run ending in `prev` (same kind already checked by the caller). */
		function continues(prev, next, kind) {
			if (next.seq !== prev.seq + 1) return false;
			if (!Number.isSafeInteger(next.time - prev.time)) return false;
			if (next.data.turn !== prev.data.turn || next.data.step !== prev.data.step) return false;
			if (indexOf(next) !== indexOf(prev)) return false;
			if (kind !== "tool-call-delta") return true;
			const a = toolCallOf(prev);
			const b = toolCallOf(next);
			return a.id === b.id && Object.hasOwn(a, "name") === Object.hasOwn(b, "name") && a.name === b.name;
		}
		/** Build the row for a completed run (`run.length >= MIN_RUN`, uniform per {@link continues}). */
		function buildRow(kind, run) {
			const first = run[0];
			const base = {
				turn: first.data.turn,
				step: first.data.step,
				index: indexOf(first),
				dt: run.slice(1).map((event, i) => event.time - run[i].time)
			};
			const envelope = {
				seq0: first.seq,
				time0: first.time
			};
			if (kind === "tool-call-delta") {
				const call = toolCallOf(first);
				return {
					type: "tool-call-chunks",
					...envelope,
					data: {
						...base,
						id: ToolCallId(call.id),
						...Object.hasOwn(call, "name") ? { name: call.name } : {},
						args: run.map((event) => event.data.chunk.argumentsDelta)
					}
				};
			}
			const data = {
				...base,
				texts: run.map((event) => event.data.chunk.text)
			};
			return kind === "text-delta" ? {
				type: "text-chunks",
				...envelope,
				data
			} : {
				type: "reasoning-chunks",
				...envelope,
				data
			};
		}
		/**
		* Pack an event batch for storage: each run of at least {@link MIN_RUN}
		* consecutive whitelisted same-kind, same-block delta chunk events becomes one
		* {@link ChunkRow}; every other event passes through verbatim, in order.
		* Pure and stateless — safe over any array, including a batch whose runs were
		* split by flush boundaries (the split runs simply pack per batch).
		*
		* @param events - the batch to encode, in log order.
		* @returns the storage records to write, one JSONL line each.
		*/
		function packChunkRuns(events) {
			const out = [];
			let kind;
			let run = [];
			const flush = () => {
				if (kind !== void 0 && run.length >= MIN_RUN) out.push(buildRow(kind, run));
				else out.push(...run);
				kind = void 0;
				run = [];
			};
			for (const event of events) {
				const k = classify(event);
				if (k === void 0) {
					flush();
					out.push(event);
					continue;
				}
				const delta = event;
				const last = run[run.length - 1];
				if (k === kind && last !== void 0 && continues(last, delta, k)) {
					run.push(delta);
					continue;
				}
				flush();
				kind = k;
				run = [delta];
			}
			flush();
			return out;
		}
		//#endregion
		//#region ../../core/session/lib/types/surface.js
		/**
		* Surface layer on top of the session event log: an ordered view of events
		* that produce LLM messages. The append-only log remains the source of truth.
		*
		* Browser-safe: web clients consume this subpath export, so it must stay free
		* of `node:` imports (they break the vite bundle).
		*
		* @module @deepseek-ai/dsh-session/surface
		*/
		/** Runtime counterpart of the message-producing event union. */
		const SURFACE_EVENT_TYPES = new Set([
			"user/message",
			"assistant/message",
			"tool/result"
		]);
		/**
		* Whether an event type can join the model-visible surface.
		* @param type - event type to test.
		* @returns true for one of the three message-producing event types.
		*/
		function isSurfaceEligibleType(type) {
			return SURFACE_EVENT_TYPES.has(type);
		}
		/**
		* Project a single event into the LLM message it derives to, or null when it
		* produces none — a non-surface event (chunk, boundary, log-only record) or an
		* empty-content assistant/message (which exists only to host usage). This is
		* THE per-node projection rule: `Session.deriveMessages` folds it over the
		* live surface, external reconstructors and pure projections fold the same
		* function over a log prefix's surface to rebuild the exact messages any
		* request was built from. The returned message is the already frozen message
		* nested in the event wrapper and shared by delivery, durable history, and
		* model requests.
		* @param event - the event to project.
		* @returns the derived message, or null when the event produces none.
		*/
		function deriveEventMessage(event) {
			switch (event.type) {
				case "user/message": return event.data;
				case "assistant/message":
					if (event.data.message.content.length === 0) return null;
					return event.data.message;
				case "tool/result": return event.data.message;
				default: return null;
			}
		}
		/** Create an empty surface fold state. */
		function createFoldState() {
			return {
				nodes: [],
				replaceGeneration: 0
			};
		}
		/** Whether a runtime value is a non-negative safe event sequence. */
		function isEventSeq(value) {
			return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
		}
		/** Whether a runtime value is the exact positional-replacement shape. */
		function isReplaceOp(value) {
			const op = value;
			return Object.keys(op).length === 3 && Object.hasOwn(op, "op") && Object.hasOwn(op, "start") && Object.hasOwn(op, "end") && op["op"] === "replace" && isEventSeq(op["start"]) && isEventSeq(op["end"]);
		}
		/** Validate event-local surface eligibility and return its operation. */
		function surfaceOpOf(event) {
			const raw = event;
			if (!isSurfaceEligibleType(event.type)) {
				if (raw.surfaceOp !== void 0) throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry surfaceOp`);
				if (raw.sourceEventSeqs !== void 0) throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry sourceEventSeqs`);
				return;
			}
			const op = raw.surfaceOp;
			if (op === void 0) throw new Error(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`);
			if (op === "append") return op;
			if (op === null || typeof op !== "object" || Array.isArray(op)) throw new Error(`session event "${event.type}" carries an invalid surfaceOp`);
			if (!isReplaceOp(op)) throw new Error(`session event "${event.type}" carries an invalid replace surfaceOp`);
			return op;
		}
		/** Validate cited source-event seqs against prior log entries and the replacement range. */
		function assertProvenance(event, shadowedSeqs) {
			const raw = event.sourceEventSeqs;
			const sources = /* @__PURE__ */ new Set();
			if (raw !== void 0) {
				if (!Array.isArray(raw)) throw new Error(`sourceEventSeqs on event at seq ${event.seq} must be an array when present`);
				if (raw.length === 0 && event.type !== "assistant/message") throw new Error("sourceEventSeqs must not be empty except on assistant/message");
				let nonEarlierSource;
				for (const source of raw) {
					if (!isEventSeq(source)) throw new Error(`session event "${event.type}" sourceEventSeqs must densely contain non-negative safe integers`);
					sources.add(source);
					if (nonEarlierSource === void 0 && source >= event.seq) nonEarlierSource = source;
				}
				if (sources.size !== raw.length) throw new Error("sourceEventSeqs must not contain duplicates");
				if (nonEarlierSource !== void 0) throw new Error(`sourceEventSeqs must reference earlier events: ${nonEarlierSource} >= current seq ${event.seq}`);
			}
			const missing = shadowedSeqs.filter((seq) => !sources.has(seq));
			if (missing.length > 0) throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(", ")}`);
		}
		/** Locate one replacement range without mutating the current fold state. */
		function replacementRange(state, op) {
			const startIdx = state.nodes.indexOf(op.start);
			if (startIdx === -1) throw new Error(`surface replace: start seq ${op.start} not found in surface`);
			const endIdx = state.nodes.indexOf(op.end);
			if (endIdx === -1) throw new Error(`surface replace: end seq ${op.end} not found in surface`);
			if (startIdx > endIdx) throw new Error(`surface replace: start seq ${op.start} (index ${startIdx}) is after end seq ${op.end} (index ${endIdx})`);
			return {
				startIdx,
				endIdx,
				shadowedSeqs: state.nodes.slice(startIdx, endIdx + 1)
			};
		}
		/**
		* Deep structural equality over the session-event JSON value domain
		* (null/boolean/number/string, arrays, plain objects). Replaces
		* `node:util`'s isDeepStrictEqual to keep this module browser-safe.
		*/
		function isDeepEqualJson(a, b) {
			if (a === b) return true;
			if (Array.isArray(a) || Array.isArray(b)) {
				if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
				return a.every((item, i) => isDeepEqualJson(item, b[i]));
			}
			if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
			const aKeys = Object.keys(a);
			const bRecord = b;
			if (aKeys.length !== Object.keys(b).length) return false;
			return aKeys.every((key) => Object.hasOwn(b, key) && isDeepEqualJson(a[key], bRecord[key]));
		}
		/** Restrict a tool-result replacement to one current result's content. */
		function assertToolResultRewrite(event, shadowedSeqs, events, baseSeq) {
			if (event.type !== "tool/result") return;
			if (shadowedSeqs.length !== 1) throw new Error("tool/result surface replacement must rewrite exactly one current node");
			for (const originalSeq of shadowedSeqs) {
				const original = events[originalSeq - baseSeq];
				if (original?.type !== "tool/result") throw new Error("tool/result surface replacement must target a current tool/result");
				const originalRest = { ...original.data };
				const replacementRest = { ...event.data };
				const originalResult = original.data.message.content[0];
				const replacementResult = event.data.message.content[0];
				originalRest["message"] = {
					...original.data.message,
					content: [{
						...originalResult,
						content: null
					}]
				};
				replacementRest["message"] = {
					...event.data.message,
					content: [{
						...replacementResult,
						content: null
					}]
				};
				if (!isDeepEqualJson(originalRest, replacementRest)) throw new Error("tool/result surface replacement may change only content");
			}
		}
		/** Validate one event at its replay boundary and prepare its atomic fold transition. */
		function planSurfaceEvent(state, event, expectedSeq, events, baseSeq) {
			if (event.seq !== expectedSeq) throw new Error(`session event seq ${event.seq} is not contiguous; expected ${expectedSeq}`);
			const surfaceOp = surfaceOpOf(event);
			if (surfaceOp === void 0) return;
			if (surfaceOp === "append") {
				assertProvenance(event, []);
				return {
					kind: "append",
					seq: event.seq
				};
			}
			const range = replacementRange(state, surfaceOp);
			assertProvenance(event, range.shadowedSeqs);
			assertToolResultRewrite(event, range.shadowedSeqs, events, baseSeq);
			return {
				kind: "replace",
				seq: event.seq,
				start: surfaceOp.start,
				end: surfaceOp.end,
				...range
			};
		}
		/** Apply one event and return replacement metadata only when one occurred. */
		function applySurfaceEvent(state, event, expectedSeq, events, baseSeq) {
			return applySurfacePlan(state, planSurfaceEvent(state, event, expectedSeq, events, baseSeq));
		}
		/** Commit one previously validated surface transition. */
		function applySurfacePlan(state, plan) {
			if (plan?.kind === "append") state.nodes.push(plan.seq);
			else if (plan?.kind === "replace") {
				state.nodes.splice(plan.startIdx, plan.endIdx - plan.startIdx + 1, plan.seq);
				state.replaceGeneration += 1;
			}
			if (plan?.kind !== "replace") return;
			return {
				seq: plan.seq,
				start: plan.start,
				end: plan.end,
				shadowedSeqs: plan.shadowedSeqs
			};
		}
		/**
		* Replay a complete session log through the canonical surface fold.
		* @param events - session events in contiguous seq order.
		* @returns detached current sequences and replacement history.
		* @throws when an event violates surface metadata, source-event references, range, or tool-result rewrite rules.
		*/
		function foldSurface(events) {
			const state = createFoldState();
			const replacements = [];
			for (const [index, event] of events.entries()) {
				const replacement = applySurfaceEvent(state, event, index, events, 0);
				if (replacement !== void 0) replacements.push(replacement);
			}
			return {
				nodes: [...state.nodes],
				replacements
			};
		}
		//#endregion
		//#region lib/types/client/random-uuid.js
		/** Browser-safe UUID generation for client-side wire correlation. */
		/**
		* Generate an RFC 4122 version 4 UUID without requiring a secure context.
		* @returns a UUID backed by `crypto.getRandomValues()`, which browsers expose on insecure origins.
		*/
		function randomUuid() {
			const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			view.setUint8(6, view.getUint8(6) & 15 | 64);
			view.setUint8(8, view.getUint8(8) & 63 | 128);
			const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		}
		//#endregion
		//#region lib/types/client/fixture.js
		const FIXTURE_SESSION_SEARCH_RESULT_LIMIT = 20;
		function isFixtureTokenDelta(chunk) {
			switch (chunk.type) {
				case "text-delta":
				case "reasoning-delta": return chunk.text !== "";
				case "tool-call-delta": return chunk.argumentsDelta !== "" || chunk.name !== void 0;
				default: return false;
			}
		}
		function text(t) {
			return [{
				type: "text",
				text: t
			}];
		}
		function userMessage(content, source = { kind: "user" }) {
			return createUserMessage({
				content,
				source
			});
		}
		function assistantMessage(content, model = "fx-1") {
			return createAssistantMessage({
				content,
				source: {
					provider: "fixture",
					model
				}
			});
		}
		function toolResultMessage(callId, content, isError) {
			return createToolResultMessage({
				callId: ToolCallId(callId),
				content,
				isError
			});
		}
		const MARKDOWN_FIXTURE = [
			"# Markdown fixture",
			"",
			"Assistant output renders **strong text**, *emphasis*, and `inline code`.",
			"",
			"- first item",
			"  - nested item",
			"",
			"| Area | State |",
			"| --- | --- |",
			"| history | rendered |",
			"| streaming | stable |",
			"",
			"[DeepSeek](https://www.deepseek.com)",
			"",
			"```ts",
			"const markdown = true",
			"```"
		].join("\n");
		const USER_MARKDOWN_LITERAL = "用户字面量：# 不渲染 `code` [link](https://example.com)";
		/**
		* SGR wrapper for the terminal output sample below: authoring the escapes as
		* `\u001b` keeps literal control bytes out of this source file.
		* @param code - the SGR parameter (an ANSI color or attribute number).
		* @param body - the text the attribute applies to.
		* @returns the body wrapped in the attribute and a reset.
		*/
		function sgr(code, body) {
			return `\u001b[${code}m${body}\u001b[0m`;
		}
		/**
		* Terminal output sample for fixture turn 66, authored to carry every feature
		* the terminal card draws that turn 60's two prompt rows cannot reach:
		* basic-16 SGR foreground runs (green, red, bright-black) that must resolve to
		* `--dsw-*` tokens, a bold run, column-aligned table rows that must scroll
		* rather than fold, more than DEFAULT_TERMINAL_MAX_LINES (16) lines so the
		* height cap collapses the middle. This constant is the visible body; the call
		* site appends the shell result's `[exit code: N]` marker so Client derivation
		* can consume it into the terminal status pill.
		*/
		const TERMINAL_OUTPUT_FIXTURE = [
			sgr(1, "Running 4 checks"),
			`${sgr(32, "✓")} typecheck                                          1.82s`,
			`${sgr(32, "✓")} lint                                               0.94s`,
			`${sgr(32, "✓")} duplication                                        2.10s`,
			`${sgr(31, "✗")} unit                                               8.41s`,
			"",
			sgr(90, "packages/client/ui-primitives/tests/terminal-block.client.spec.tsx"),
			`  ${sgr(31, "FAIL")} caps output at the configured line budget`,
			"    expected 16 lines, received 24",
			"",
			"NAME                        LINES    BRANCHES    FUNCTIONS    UNCOVERED",
			"TerminalBlock.tsx           100%     100%        100%         -",
			"ansi.ts                     100%     100%        100%         -",
			"clipboard.ts                100%     100%        100%         -",
			"CodeBlock.tsx               98.4%    96.2%       100%         41-43",
			"highlight.ts                100%     100%        100%         -",
			"Pill.tsx                    100%     100%        100%         -",
			"StateDot.tsx                100%     100%        100%         -",
			"markdown/Markdown.tsx       100%     100%        100%         -",
			"",
			sgr(31, "1 of 4 checks failed")
		].join("\n");
		/**
		* Structured grep metadata for the search sample (turn 67). `truncated` with a
		* larger `total` than the retained match count exercises the search card's
		* capped indicator; the file with more than CHAT_SEARCH_MAX_LINES rows
		* exercises its head/tail height cap.
		*/
		const SEARCH_MATCHES_FIXTURE = [
			{
				path: "packages/client/ui-primitives/src/SearchBlock.tsx",
				matches: [
					{
						lineNumber: 16,
						line: "export const DEFAULT_SEARCH_MAX_LINES = 16"
					},
					{
						lineNumber: 138,
						line: "export function SearchBlock(props: SearchBlockProps) {"
					},
					{
						lineNumber: 141,
						line: "  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set())"
					}
				]
			},
			{
				path: "packages/client/ui-tool/src/client/tool/models/search-card-model.ts",
				matches: [{
					lineNumber: 45,
					line: "export const CHAT_SEARCH_MAX_LINES = 8"
				}, {
					lineNumber: 130,
					line: "export function searchCardModel(block: ToolCallBlock): SearchCardModel | null {"
				}]
			},
			{
				path: "packages/client/ui-tool/src/client/tool/toolviews/search-row.tsx",
				matches: [
					{
						lineNumber: 34,
						line: "export function SearchRow({ toolName, block, inspect, t }: SearchRowProps) {"
					},
					{
						lineNumber: 36,
						line: "  const search = searchCardModel(block)"
					},
					{
						lineNumber: 56,
						line: "      search={search}"
					},
					{
						lineNumber: 78,
						line: "      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'grep', locale: NS }, SearchRow)"
					}
				]
			}
		];
		const SEARCH_MATCHES_TEXT = [
			"Found 9 of 42 matches",
			"",
			...SEARCH_MATCHES_FIXTURE.map((file) => [file.path, ...file.matches.map((m) => `Line ${m.lineNumber}: ${m.line}`)].join("\n")),
			"",
			"(Full grep result stored at: fixture://spill/grep-66. Read it to see every match.)"
		].join("\n");
		const SEARCH_PATHS_FIXTURE = [
			"packages/client/ui-primitives/src/SearchBlock.tsx",
			"packages/client/ui-primitives/src/SearchBlock.module.css",
			"packages/client/ui-tool/src/client/tool/models/search-card-model.ts",
			"packages/client/ui-tool/src/client/tool/toolviews/search-row.tsx",
			"packages/client/ui-tool/tests/search-card.client.spec.tsx"
		];
		const SEARCH_PATHS_TEXT = [
			...SEARCH_PATHS_FIXTURE,
			"",
			"(Showing 5 of 23 paths. Full sorted result stored at: fixture://spill/glob-67. Read it to see every path.)"
		].join("\n");
		const READ_SAMPLE_FIRST_LINE = 41;
		const READ_SAMPLE_SOURCE = [
			"export interface ReadBlockProps {",
			"  label?: string | undefined",
			"  lines: readonly ReadBlockLine[]",
			"  totalLines: number",
			"  lang?: string | undefined",
			"  maxLines?: number | undefined",
			"  className?: string | undefined",
			"}",
			"",
			"// A windowed read keeps the file line numbers in the gutter.",
			"const marker = \"fixture read sample\""
		];
		const READ_SAMPLE_LINES = READ_SAMPLE_SOURCE.map((text, index) => ({
			number: READ_SAMPLE_FIRST_LINE + index,
			text
		}));
		const READ_SAMPLE_PATH = "packages/client/ui-primitives/src/ReadBlock.tsx";
		const READ_SAMPLE_TOTAL = 180;
		const READ_SAMPLE_LAST_LINE = READ_SAMPLE_FIRST_LINE + READ_SAMPLE_SOURCE.length - 1;
		const READ_SAMPLE_TEXT = [
			`<path>${READ_SAMPLE_PATH}</path>`,
			"<type>file</type>",
			"<content>",
			...READ_SAMPLE_SOURCE.map((text, index) => `${READ_SAMPLE_FIRST_LINE + index}: ${text}`),
			"",
			`(Showing lines ${READ_SAMPLE_FIRST_LINE}-${READ_SAMPLE_LAST_LINE} of ${READ_SAMPLE_TOTAL}. Use offset=${READ_SAMPLE_LAST_LINE + 1} to continue.)`,
			"</content>"
		].join("\n");
		/**
		* The `web_search` result metadata for the web-search turn. The sources cover a
		* titled source with a snippet and date, a hostname-label fallback, and a
		* titled source without a snippet; `truncated` exercises the capped indicator.
		*/
		const WEB_SEARCH_META = {
			answer: "DeepSeek Harness is a plugin-based agent harness on vendored Cordis where **every capability is a plugin**.",
			sources: [
				{
					url: "https://github.com/deepseek-ai/deepseek-harness",
					title: "DeepSeek Harness — plugin-based agent harness",
					snippet: "Everything is a plugin: session, tools, agent-loop, and LLM adapters all mount on the same Cordis context.",
					publishedAt: "2026-07-01"
				},
				{
					url: "https://www.deepseek.com/blog/harness-architecture",
					snippet: "The capability-seam pattern splits each capability into interface, implementation, and consumer packages."
				},
				{
					url: "https://docs.deepseek.com/harness/plugins",
					title: "Writing a harness plugin",
					publishedAt: "2026-06-15"
				}
			],
			truncated: true
		};
		/** The `web_fetch` result metadata for the web-fetch turn. */
		const WEB_FETCH_META = {
			url: "https://www.deepseek.com/blog/harness-architecture",
			statusCode: 200,
			truncated: false
		};
		const DEEPSEEK_REASONING = {
			efforts: [
				{
					id: "off",
					name: "Off"
				},
				{
					id: "high",
					name: "High"
				},
				{
					id: "max",
					name: "Max"
				}
			],
			defaultEffort: "high"
		};
		const OPENAI_REASONING = {
			efforts: [
				{
					id: "off",
					name: "Off"
				},
				{
					id: "medium",
					name: "Medium"
				},
				{
					id: "high",
					name: "High"
				},
				{
					id: "max",
					name: "Max"
				}
			],
			defaultEffort: "medium"
		};
		/** Catalog served by `session/modelCatalog` (fresh copies per call). */
		function fixtureModelGroups() {
			return [{
				id: "deepseek-official",
				name: "DeepSeek",
				models: [{
					id: "deepseek-v4-flash",
					name: "DeepSeek-V4-Flash",
					description: "快速响应",
					reasoning: DEEPSEEK_REASONING
				}, {
					id: "deepseek-v4-pro",
					name: "DeepSeek-V4-Pro",
					description: "复杂任务",
					reasoning: DEEPSEEK_REASONING
				}]
			}, {
				id: "openai",
				name: "OpenAI",
				models: [{
					id: "gpt-5",
					name: "GPT-5",
					reasoning: OPENAI_REASONING
				}]
			}];
		}
		function sid(id) {
			return id;
		}
		const FIXTURE_IMAGE_DATA = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAYAAAA/xl1SAAAAvklEQVR42u3SMQ0AAAjAMIyhELM4AAe8PD1qYFlk9cCXEAEDYkAwIAYEA2JAMCAGBANiQDAgBgQDYkAwIAYEA2JAMCAGBANiQDAgBgQDYkAwIAYEA2JAMCAGxIBCYEAMCAbEgGBADAgGxIBgQAwIBsSAYEAMCAbEgGBADAgGxIBgQAwIBsSAYEAMCAbEgGBADAgGxIAYEAyIAcGAGBAMiAHBgBgQDIgBwYAYEAyIAcGAGBAMiAHBgBgQDIgB4bYWLb6pnOb1xAAAAABJRU5ErkJggg==";
		const FIXTURE_IMAGE_REF = {
			attachmentId: "fixture:image",
			mediaType: "image/png",
			bytes: 247,
			width: 160,
			height: 90,
			name: "fixture-image.png"
		};
		/** Deterministic provider billing attached to fixture assistant messages. */
		function fixtureUsage(turn, step) {
			return {
				inputTokens: 20 + turn % 5,
				outputTokens: 8 + step,
				cacheReadTokens: turn === 0 ? 0 : 80,
				cacheWriteTokens: turn % 10 === 0 ? 4 : 0
			};
		}
		/** fx-alpha history script: 75 turns (~150+ messages -> 4 pages at PAGE_MESSAGES=50),
		*  mixing reasoning blocks / tool call+result / context. */
		function buildAlphaLog() {
			const events = [];
			let time = Date.now() - 36e5;
			const push = (e) => {
				const seq = events.length;
				const data = e["data"];
				const authored = e["type"] === "assistant/message" && data !== void 0 ? {
					...e,
					data: {
						...data,
						usage: fixtureUsage(data["turn"], data["step"])
					}
				} : e;
				events.push({
					seq,
					time: time += 800,
					...authored
				});
				return seq;
			};
			push({
				type: "request/context",
				data: {
					provider: "deepseek-official",
					model: "deepseek-v4-flash",
					contextWindow: 128e3
				}
			});
			for (let turn = 0; turn < 60; turn++) {
				push({
					type: "turn/start",
					data: { turn }
				});
				const userSeq = push({
					type: "user/message",
					surfaceOp: "append",
					data: userMessage(text(turn === 59 ? USER_MARKDOWN_LITERAL : `问题 ${turn}：fixture 历史消息，用于翻页与渲染验收。`))
				});
				if (turn === 0) push({
					type: "session/title",
					data: {
						title: "Fixture 历史会话",
						messageSeqs: [userSeq],
						source: { kind: "fallback" }
					}
				});
				if (turn % 9 === 4) push({
					type: "user/message",
					surfaceOp: "append",
					data: userMessage(text(`[fixture] 上下文注入（turn ${turn}）`), {
						kind: "plugin",
						plugin: "fixture"
					})
				});
				push({
					type: "step/start",
					data: {
						turn,
						step: 0
					}
				});
				const withTool = turn % 5 === 2;
				const withReasoning = turn % 3 === 1;
				const blocks = [];
				if (withReasoning) blocks.push({
					type: "reasoning",
					text: `思考过程 ${turn}：这是一段可折叠的 reasoning 内容。`
				});
				blocks.push({
					type: "text",
					text: turn === 59 ? MARKDOWN_FIXTURE : `回答 ${turn}：这是 fixture 生成的历史回复正文。`
				});
				if (withTool) {
					const callId = `fx-call-${turn}`;
					blocks.push({
						type: "tool-call",
						id: callId,
						name: "echo",
						arguments: `{"text":"turn ${turn}"}`
					});
					push({
						type: "assistant/message",
						surfaceOp: "append",
						data: {
							turn,
							step: 0,
							message: assistantMessage(blocks)
						}
					});
					push({
						type: "tool/call",
						data: {
							turn,
							step: 0,
							callId,
							name: "echo",
							arguments: `{"text":"turn ${turn}"}`
						}
					});
					push({
						type: "tool/result",
						surfaceOp: "append",
						data: {
							turn,
							step: 0,
							message: toolResultMessage(callId, text(`ECHO: TURN ${turn}`), turn % 25 === 12)
						}
					});
					push({
						type: "step/end",
						data: {
							turn,
							step: 0
						}
					});
					push({
						type: "step/start",
						data: {
							turn,
							step: 1
						}
					});
					push({
						type: "assistant/message",
						surfaceOp: "append",
						data: {
							turn,
							step: 1,
							message: assistantMessage(text(`工具结果已消化（turn ${turn}）。`))
						}
					});
					push({
						type: "step/end",
						data: {
							turn,
							step: 1
						}
					});
				} else {
					push({
						type: "assistant/message",
						surfaceOp: "append",
						data: {
							turn,
							step: 0,
							message: assistantMessage(blocks)
						}
					});
					push({
						type: "step/end",
						data: {
							turn,
							step: 0
						}
					});
				}
				push({
					type: "turn/end",
					data: {
						turn,
						reason: { kind: "completed" }
					}
				});
			}
			const toolTurn = (turn, name, args, resultText, resultMeta) => {
				const callId = `fx-call-${turn}`;
				push({
					type: "turn/start",
					data: { turn }
				});
				push({
					type: "user/message",
					surfaceOp: "append",
					data: userMessage(text(`问题 ${turn}：${name} 样本。`))
				});
				push({
					type: "step/start",
					data: {
						turn,
						step: 0
					}
				});
				push({
					type: "assistant/message",
					surfaceOp: "append",
					data: {
						turn,
						step: 0,
						message: assistantMessage([{
							type: "tool-call",
							id: callId,
							name,
							arguments: args
						}])
					}
				});
				push({
					type: "tool/call",
					data: {
						turn,
						step: 0,
						callId,
						name,
						arguments: args
					}
				});
				push({
					type: "tool/result",
					surfaceOp: "append",
					data: {
						turn,
						step: 0,
						message: toolResultMessage(callId, text(resultText), false),
						...resultMeta === void 0 ? {} : { meta: resultMeta }
					}
				});
				push({
					type: "step/end",
					data: {
						turn,
						step: 0
					}
				});
				push({
					type: "turn/end",
					data: {
						turn,
						reason: { kind: "completed" }
					}
				});
			};
			toolTurn(60, "bash", "{\"command\":\"ls -la\\necho done\",\"description\":\"fixture 终端样本\",\"workdir\":\"/tmp/fixture\"}", "total 2\ndrwxr-xr-x fixture\n-rw-r--r-- demo.txt");
			toolTurn(61, "write", "{\"file_path\":\"notes/demo.txt\",\"content\":\"hello fixture\\n\"}", "wrote notes/demo.txt", { diffs: [{
				path: "notes/demo.txt",
				oldText: null,
				newText: "hello fixture\n"
			}] });
			toolTurn(62, "edit", "{\"file_path\":\"notes/demo.txt\",\"old_string\":\"hello\",\"new_string\":\"hello fixture\"}", "已编辑", { diffs: [{
				path: "notes/demo.txt",
				oldText: "hello",
				newText: "hello fixture"
			}] });
			toolTurn(63, "write", "{\"file_path\":\"notes/new-demo.txt\",\"content\":\"hello fixture\\n\"}", "已写入", { diffs: [{
				path: "notes/new-demo.txt",
				oldText: null,
				newText: "hello fixture\n"
			}] });
			toolTurn(64, "edit", "{\"file_path\":\"src/config.ts\",\"old_string\":\"const timeout = 30\",\"new_string\":\"const timeout = 60\"}", "已编辑", { diffs: [{
				path: "src/config.ts",
				oldText: "const timeout = 30",
				newText: "const timeout = 60"
			}, {
				path: "src/config.ts",
				oldText: "retries: 1",
				newText: "retries: 3"
			}] });
			{
				const turn = 65;
				const callId = `fx-call-${turn}`;
				const args = JSON.stringify({
					code: "const listing = await tools.bash({ command: \"ls notes\", description: \"List notes\" })\nconst demo = await tools.read({ file_path: \"notes/demo.txt\" })\nawait tools.read({ file_path: \"notes/missing.txt\" }).catch(() => \"tolerated\")\nreturn { listing, demo }",
					description: "Read the notes files and summarize"
				});
				push({
					type: "turn/start",
					data: { turn }
				});
				push({
					type: "user/message",
					surfaceOp: "append",
					data: userMessage(text(`问题 ${turn}：run_code 样本。`))
				});
				push({
					type: "step/start",
					data: {
						turn,
						step: 0
					}
				});
				push({
					type: "assistant/message",
					surfaceOp: "append",
					data: {
						turn,
						step: 0,
						message: assistantMessage([{
							type: "tool-call",
							id: callId,
							name: "run_code",
							arguments: args
						}])
					}
				});
				push({
					type: "tool/call",
					data: {
						turn,
						step: 0,
						callId,
						name: "run_code",
						arguments: args
					}
				});
				const dispatchPair = (n, name, dispatchArgs, resultText, isError = false) => {
					push({
						type: "tool/code-dispatch-start",
						data: {
							rootCallId: callId,
							parentCallId: callId,
							subCallId: `${callId}:code:${n}`,
							name,
							arguments: dispatchArgs
						}
					});
					push({
						type: "tool/code-dispatch",
						data: {
							rootCallId: callId,
							parentCallId: callId,
							subCallId: `${callId}:code:${n}`,
							name,
							arguments: dispatchArgs,
							isError,
							content: [{
								type: "text",
								text: resultText
							}]
						}
					});
				};
				dispatchPair(1, "bash", {
					command: "ls notes",
					description: "List notes"
				}, "demo.txt\nnew-demo.txt");
				dispatchPair(2, "read", { file_path: "notes/demo.txt" }, "hello fixture\n");
				dispatchPair(3, "read", { file_path: "notes/missing.txt" }, "Error: ENOENT: notes/missing.txt not found", true);
				push({
					type: "tool/result",
					surfaceOp: "append",
					data: {
						turn,
						step: 0,
						message: toolResultMessage(callId, text("{\"listing\":\"demo.txt\\nnew-demo.txt\",\"demo\":\"hello fixture\\n\"}"), false)
					}
				});
				push({
					type: "step/end",
					data: {
						turn,
						step: 0
					}
				});
				push({
					type: "turn/end",
					data: {
						turn,
						reason: { kind: "completed" }
					}
				});
			}
			const fixtureTodos = [
				{
					content: "梳理需求",
					status: "completed"
				},
				{
					content: "实现 fixture 样本",
					status: "in_progress"
				},
				{
					content: "跑后台构建",
					status: "in_progress"
				},
				{
					content: "浏览器验收",
					status: "pending"
				}
			];
			toolTurn(66, "bash", "{\"command\":\"pnpm run check\",\"description\":\"fixture 终端样本\",\"workdir\":\"/tmp/fixture/deep/nested\"}", `${TERMINAL_OUTPUT_FIXTURE}\n[exit code: 1]`);
			toolTurn(67, "grep", "{\"pattern\":\"SEARCH_MAX_LINES\",\"path\":\"packages/client\"}", SEARCH_MATCHES_TEXT, {
				shape: "matches",
				files: SEARCH_MATCHES_FIXTURE,
				truncated: true,
				total: 42
			});
			toolTurn(68, "glob", "{\"pattern\":\"**/SearchBlock*\",\"path\":\"packages/client\"}", SEARCH_PATHS_TEXT, {
				shape: "paths",
				paths: SEARCH_PATHS_FIXTURE,
				truncated: true,
				total: 23
			});
			toolTurn(69, "read", `{"file_path":${JSON.stringify(READ_SAMPLE_PATH)},"offset":${READ_SAMPLE_FIRST_LINE}}`, READ_SAMPLE_TEXT, {
				path: READ_SAMPLE_PATH,
				offset: READ_SAMPLE_FIRST_LINE,
				lines: READ_SAMPLE_LINES,
				totalLines: READ_SAMPLE_TOTAL,
				lang: "ts"
			});
			toolTurn(70, "web_search", "{\"queries\":[\"deepseek harness architecture\"]}", "Search results for deepseek harness architecture.", WEB_SEARCH_META);
			toolTurn(71, "web_fetch", "{\"url\":\"https://www.deepseek.com/blog/harness-architecture\"}", "# Harness architecture\n\nEverything is a plugin.", WEB_FETCH_META);
			push({
				type: "turn/start",
				data: { turn: 72 }
			});
			push({
				type: "user/message",
				surfaceOp: "append",
				data: userMessage(text("问题 72：请完整列出全部一百条条目。"))
			});
			push({
				type: "step/start",
				data: {
					turn: 72,
					step: 0
				}
			});
			push({
				type: "assistant/message",
				surfaceOp: "append",
				data: {
					turn: 72,
					step: 0,
					message: assistantMessage(text("条目 1：第一条。条目 2：第二条。条目 3：这一条写到一半被"))
				}
			});
			push({
				type: "step/end",
				data: {
					turn: 72,
					step: 0
				}
			});
			push({
				type: "turn/end",
				data: {
					turn: 72,
					reason: { kind: "max-tokens" }
				}
			});
			push({
				type: "turn/start",
				data: { turn: 73 }
			});
			push({
				type: "user/message",
				surfaceOp: "append",
				data: userMessage([{
					type: "image",
					attachment: FIXTURE_IMAGE_REF
				}, ...text("历史用户图片")])
			});
			push({
				type: "step/start",
				data: {
					turn: 73,
					step: 0
				}
			});
			push({
				type: "assistant/message",
				surfaceOp: "append",
				data: {
					turn: 73,
					step: 0,
					message: assistantMessage([...text("结构化模型图片："), {
						type: "image",
						attachment: FIXTURE_IMAGE_REF
					}], "fx-vision")
				}
			});
			push({
				type: "step/end",
				data: {
					turn: 73,
					step: 0
				}
			});
			push({
				type: "turn/end",
				data: {
					turn: 73,
					reason: { kind: "completed" }
				}
			});
			toolTurn(74, "todo_write", JSON.stringify({ todos: fixtureTodos }), "Updated todo list: 1 pending, 2 in progress, 1 completed.");
			const callIndex = events.length - 4;
			const callTime = events[callIndex]?.time;
			events.splice(callIndex + 1, 0, {
				type: "todo/write",
				time: callTime + 400,
				data: { todos: fixtureTodos }
			});
			events.forEach((e, i) => {
				e.seq = i;
			});
			return events;
		}
		/**
		* Fixture parallel of the plan unit's lifecycle fold. The paired
		* `command/done` retains successful plan selections and drops failures;
		* `plan/mode` commits one. `wanted` is exposed for the prompt boundary (the
		* fixture's step/start parallel).
		*/
		function foldPlan(log) {
			let active = false;
			let wanted = null;
			let running = null;
			for (const event of log) {
				const item = event;
				if (item.type === "command/run" && item.data?.["name"] === "plan") {
					const args = item.data["args"];
					if (typeof args !== "string") continue;
					running = {
						commandId: item.data["commandId"],
						wanted: args.trim() !== "off"
					};
				} else if (item.type === "command/done" && item.data !== void 0 && running !== null && item.data["commandId"] === running.commandId) {
					wanted = item.data["kind"] === "success" && running.wanted !== active ? running.wanted : null;
					running = null;
				} else if (item.type === "plan/mode") {
					active = item.data?.["active"] === true;
					wanted = null;
				}
			}
			const selected = running?.wanted ?? wanted;
			return {
				active,
				pending: selected !== null && selected !== active,
				wanted: selected
			};
		}
		/** The plan projection's wire view over the full log. */
		function planViewOf(log) {
			const plan = foldPlan(log);
			return {
				active: plan.active,
				pending: plan.pending
			};
		}
		/** Fixture parallel of the host's projection units: whole current values per key over the full log. */
		/** Fixture preset table (the host PermissionPresetService defaults). */
		const PERMISSION_PRESETS = {
			"workspace-write": {
				sandbox: "workspace-write",
				approval: "ask",
				description: "Write inside the workspace and permitted temporary directories; wider retries require approval."
			},
			"danger-full-access": {
				sandbox: "danger-full-access",
				approval: "never",
				description: "Full file access without approval prompts."
			}
		};
		/** Host permissions-unit parallel: fold the three knob events, derive the select over the fixture defaults. */
		function permissionSelectOf(log) {
			let preset = null;
			let sandbox = "workspace-write";
			let approval = "ask";
			for (const event of log) {
				const item = event;
				if (item.type === "permission/preset") preset = item.data["preset"];
				else if (item.type === "sandbox/mode") sandbox = item.data["mode"];
				else if (item.type === "approval/policy") approval = item.data["policy"];
			}
			const matches = (spec) => spec.sandbox === sandbox && spec.approval === approval;
			let currentValue = "custom";
			const folded = preset === null ? void 0 : PERMISSION_PRESETS[preset];
			if (preset !== null && folded !== void 0 && matches(folded)) currentValue = preset;
			else for (const [name, spec] of Object.entries(PERMISSION_PRESETS)) if (matches(spec)) {
				currentValue = name;
				break;
			}
			return {
				options: [...Object.entries(PERMISSION_PRESETS).map(([value, spec]) => ({
					value,
					name: value,
					description: spec.description
				})), ...currentValue === "custom" ? [{
					value: "custom",
					name: "Custom",
					description: "Current sandbox and approval settings do not match a preset."
				}] : []],
				currentValue
			};
		}
		/** Read one provider usage sample from either durable carrier. */
		function usageSampleOf(event) {
			const item = event;
			const usage = item.type === "assistant/chunk" && item.data.chunk?.type === "usage" ? item.data.chunk.usage : item.type === "assistant/message" ? item.data.usage : void 0;
			return usage === void 0 || item.data.turn === void 0 || item.data.step === void 0 ? void 0 : {
				turn: item.data.turn,
				step: item.data.step,
				usage
			};
		}
		/** Fixture parallel of token-meter's last-sample-replacing usage projection. */
		function tokenUsageOf(log) {
			const totals = {
				uncachedInputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0
			};
			let last = null;
			for (const event of log) {
				const sample = usageSampleOf(event);
				if (sample === void 0) continue;
				const buckets = {
					uncachedInputTokens: sample.usage.inputTokens,
					outputTokens: sample.usage.outputTokens,
					cacheReadTokens: sample.usage.cacheReadTokens ?? 0,
					cacheWriteTokens: sample.usage.cacheWriteTokens ?? 0
				};
				const previous = last?.turn === sample.turn && last.step === sample.step ? last.buckets : void 0;
				totals.uncachedInputTokens += buckets.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0);
				totals.outputTokens += buckets.outputTokens - (previous?.outputTokens ?? 0);
				totals.cacheReadTokens += buckets.cacheReadTokens - (previous?.cacheReadTokens ?? 0);
				totals.cacheWriteTokens += buckets.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0);
				last = {
					turn: sample.turn,
					step: sample.step,
					buckets
				};
			}
			return totals;
		}
		/** Fixture parallel of session-stats' whole-log counting and wall-time fold. */
		function sessionStatsOf(log) {
			const value = {
				turns: 0,
				steps: 0,
				llmMs: 0,
				toolMs: 0,
				ttftMs: 0,
				ttftSteps: 0,
				decodeMs: 0,
				decodeTokens: 0
			};
			let lastTurn = null;
			let openStep = null;
			const pendingCalls = /* @__PURE__ */ new Map();
			for (const event of log) switch (event.type) {
				case "step/start":
					openStep = {
						turn: event.data.turn,
						step: event.data.step,
						startTime: event.time,
						firstTokenTime: null
					};
					break;
				case "assistant/chunk":
					if (openStep !== null && openStep.turn === event.data.turn && openStep.step === event.data.step && openStep.firstTokenTime === null && isFixtureTokenDelta(event.data.chunk)) openStep.firstTokenTime = event.time;
					break;
				case "assistant/message":
					if (openStep === null || openStep.turn !== event.data.turn || openStep.step !== event.data.step) break;
					value.llmMs += Math.max(0, event.time - openStep.startTime);
					if (openStep.firstTokenTime !== null) {
						value.ttftMs += Math.max(0, openStep.firstTokenTime - openStep.startTime);
						value.ttftSteps += 1;
						const outputTokens = event.data.usage?.outputTokens;
						if (typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens >= 0) {
							value.decodeMs += Math.max(0, event.time - openStep.firstTokenTime);
							value.decodeTokens += outputTokens;
						}
					}
					openStep = null;
					break;
				case "tool/call":
					pendingCalls.set(event.data.callId, event.time);
					break;
				case "tool/result": {
					const callId = event.data.message.source.callId;
					const dispatched = pendingCalls.get(callId);
					if (dispatched === void 0) break;
					pendingCalls.delete(callId);
					value.toolMs += Math.max(0, event.time - dispatched);
					break;
				}
				case "step/end":
					if (event.data.turn !== lastTurn) {
						value.turns += 1;
						lastTurn = event.data.turn;
					}
					value.steps += 1;
					openStep = null;
					break;
				case "turn/end":
					pendingCalls.clear();
					break;
				default: break;
			}
			return value;
		}
		/** Fixed token-meter heuristic constants mirrored by this client-only fixture. */
		const CHARS_PER_TOKEN = 4;
		const BLOCK_OVERHEAD = 4;
		const ROLE_OVERHEAD = 4;
		/** Price fixture content with token-meter's fixed-density heuristic. */
		function estimateFixtureContent(blocks) {
			const densityPrice = (value) => Math.ceil(value.length / CHARS_PER_TOKEN);
			return blocks.reduce((tokens, block) => {
				if (block.type === "text" || block.type === "reasoning") return tokens + densityPrice(block.text) + BLOCK_OVERHEAD;
				if (block.type === "tool-call") return tokens + densityPrice(block.name) + densityPrice(block.arguments) + BLOCK_OVERHEAD;
				if (block.type === "tool-result") return tokens + estimateFixtureContent(block.content) + BLOCK_OVERHEAD;
				return tokens + densityPrice(JSON.stringify(block)) + BLOCK_OVERHEAD;
			}, 0);
		}
		/** Fixture parallel of token-meter's heuristic context-composition projection. */
		function contextBreakdownOf(log) {
			const headerEvent = log.findLast((event) => event.type === "request/header");
			const header = headerEvent === void 0 ? void 0 : headerEvent.data.header;
			let messageTokens = 0;
			for (const seq of foldSurface(log).nodes) {
				const event = log[seq];
				if (event === void 0) continue;
				const message = deriveEventMessage(event);
				if (message !== null) messageTokens += estimateFixtureContent(message.content) + ROLE_OVERHEAD;
			}
			return {
				systemTokens: header?.system === void 0 ? 0 : Math.ceil(header.system.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD,
				toolsTokens: header?.tools === void 0 || header.tools.length === 0 ? 0 : Math.ceil(JSON.stringify(header.tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD,
				messageTokens
			};
		}
		/** Latest log-only route context, or undefined before any request ran. */
		function lastRequestContext(log) {
			const event = log.findLast((item) => item.type === "request/context");
			return event === void 0 ? void 0 : event.data;
		}
		/**
		* Fixture parallel of token-meter's request-pressure projection: the last
		* provider-reported prompt size paired with the last recorded capacity. The
		* two need not come from one request — see the token-meter README. The host's
		* `projectedTokens` is deliberately absent: reproducing it would mean
		* reimplementing the estimator client-side, and every consumer falls back to
		* the bare sample, so a fixture-driven view simply lags a compaction the way
		* the projection did before that field existed.
		*/
		function contextPressureOf(log) {
			let pressureTokens;
			for (const event of log) {
				const sample = usageSampleOf(event);
				if (sample === void 0) continue;
				pressureTokens = sample.usage.inputTokens + (sample.usage.cacheReadTokens ?? 0) + (sample.usage.cacheWriteTokens ?? 0);
			}
			const contextWindow = lastRequestContext(log)?.contextWindow;
			return {
				...pressureTokens === void 0 ? {} : { pressureTokens },
				...contextWindow === void 0 ? {} : { contextWindow }
			};
		}
		function projectionValuesOf(log) {
			const values = {};
			values["modelSelection"] = modelSelectionProjectionOf(log);
			const titleEvent = log.findLast((item) => item.type === "session/title");
			if (titleEvent !== void 0) values["title"] = titleEvent.data.title;
			values["todos"] = backscanTodos(log) ?? null;
			values["permissions"] = permissionSelectOf(log);
			values["plan"] = planViewOf(log);
			values["goal"] = backscanGoal(log);
			values["tokenUsage"] = tokenUsageOf(log);
			values["contextPressure"] = contextPressureOf(log);
			values["contextBreakdown"] = contextBreakdownOf(log);
			values["sessionStats"] = sessionStatsOf(log);
			values["imageLimits"] = {
				maxImageBytes: 5 * 1024 * 1024,
				maxImagesPerMessage: 20,
				maxMessageImageBytes: 100 * 1024 * 1024,
				maxImagePixels: 4e7,
				maxImageDimension: 2e3,
				mediaTypes: [
					"image/png",
					"image/jpeg",
					"image/webp",
					"image/gif"
				]
			};
			return values;
		}
		function modelSelectionProjectionOf(log) {
			let lastUsed = null;
			let pending = null;
			for (const event of log) {
				if (event.type === "model/selection") {
					pending = event.data;
					continue;
				}
				if (event.type !== "request/header") continue;
				lastUsed = {
					provider: event.data.header.config.provider,
					model: event.data.header.config.model,
					...event.data.header.config.reasoningEffort === void 0 ? {} : { reasoningEffort: event.data.header.config.reasoningEffort }
				};
				if (sameModelSelection(pending, lastUsed)) pending = null;
			}
			return {
				lastUsed,
				next: pending ?? lastUsed
			};
		}
		function sameModelSelection(left, right) {
			return left === right || left !== null && right !== null && left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
		}
		/** Host parallel: emit one Session control projection frame per key advanced by the event. */
		function projectionFramesOf(id, log, event) {
			const type = event.type;
			const frames = [];
			if (type === "model/selection" || type === "request/header") frames.push({
				type: "projection",
				sessionId: id,
				key: "modelSelection",
				value: modelSelectionProjectionOf(log),
				seq: event.seq
			});
			if (usageSampleOf(event) !== void 0) frames.push({
				type: "projection",
				sessionId: id,
				key: "tokenUsage",
				value: tokenUsageOf(log),
				seq: event.seq
			}, {
				type: "projection",
				sessionId: id,
				key: "contextPressure",
				value: contextPressureOf(log),
				seq: event.seq
			});
			if (type === "request/context") frames.push({
				type: "projection",
				sessionId: id,
				key: "contextPressure",
				value: contextPressureOf(log),
				seq: event.seq
			});
			if (type === "request/header" || type === "user/message" || type === "assistant/message" || type === "tool/result") frames.push({
				type: "projection",
				sessionId: id,
				key: "contextBreakdown",
				value: contextBreakdownOf(log),
				seq: event.seq
			});
			if (type === "assistant/message" || type === "tool/result" || type === "step/end") frames.push({
				type: "projection",
				sessionId: id,
				key: "sessionStats",
				value: sessionStatsOf(log),
				seq: event.seq
			});
			if (frames.length > 0) return frames;
			if (type === "session/title") {
				const values = projectionValuesOf(log);
				/* v8 ignore next -- the advancing title event is in the log, so the key is present. */
				if (!Object.hasOwn(values, "title")) return [];
				return [{
					type: "projection",
					sessionId: id,
					key: "title",
					value: values["title"],
					seq: event.seq
				}];
			}
			if (type === "goal/change") return [{
				type: "projection",
				sessionId: id,
				key: "goal",
				value: backscanGoal(log),
				seq: event.seq
			}];
			if (type === "todo/write" || type === "turn/start") return [{
				type: "projection",
				sessionId: id,
				key: "todos",
				value: backscanTodos(log) ?? null,
				seq: event.seq
			}];
			if (type === "permission/preset" || type === "sandbox/mode" || type === "approval/policy") return [{
				type: "projection",
				sessionId: id,
				key: "permissions",
				value: permissionSelectOf(log),
				seq: event.seq
			}];
			const commandData = event;
			if (type === "plan/mode" || type === "command/run" && commandData.data.name === "plan" && typeof commandData.data.args === "string") return [{
				type: "projection",
				sessionId: id,
				key: "plan",
				value: planViewOf(log),
				seq: event.seq
			}];
			return [];
		}
		/**
		* Message-boundary paging mirrors the Host contract: count `maxMessages`
		* backwards from the end and cut at a turn/start boundary.
		*/
		function pageOf(log, beforeSeq, maxMessages) {
			const end = beforeSeq === void 0 ? log.length : Math.max(0, Math.min(beforeSeq, log.length));
			let start = 0;
			let messages = 0;
			for (let i = end - 1; i >= 0; i--) {
				const event = log[i];
				/* v8 ignore next -- dense-array guard: log seqs are array indexes, i stays within [0, end). */
				if (event === void 0) break;
				if (event.type === "user/message" || event.type === "assistant/message") messages++;
				if (event.type === "turn/start" && messages >= maxMessages) {
					start = i;
					break;
				}
			}
			return {
				records: packChunkRuns(log.slice(start, end)).map((record) => {
					if (!isChunkRow(record)) return {
						type: "event",
						event: record
					};
					switch (record.type) {
						case "text-chunks": return {
							type: "chunks",
							event: {
								type: "chunkrow/text-chunks",
								seq: record.seq0,
								time: record.time0,
								data: record.data
							}
						};
						case "reasoning-chunks": return {
							type: "chunks",
							event: {
								type: "chunkrow/reasoning-chunks",
								seq: record.seq0,
								time: record.time0,
								data: record.data
							}
						};
						case "tool-call-chunks": return {
							type: "chunks",
							event: {
								type: "chunkrow/tool-call-chunks",
								seq: record.seq0,
								time: record.time0,
								data: record.data
							}
						};
					}
				}),
				hasMore: start > 0
			};
		}
		/** Fixture mirror of host session-scoped attachment authorization. */
		function logReferencesAttachment(log, attachmentId) {
			const visit = (value) => {
				if (Array.isArray(value)) return value.some(visit);
				if (typeof value !== "object" || value === null) return false;
				const record = value;
				if (record.attachmentId === attachmentId) return true;
				return Object.values(record).some(visit);
			};
			return log.some((event) => visit(event.data));
		}
		/** Fixture mirror of first-party message extraction used by session-query. */
		function searchBlockText(block) {
			switch (block.type) {
				case "text": return [block.text];
				case "reasoning": return [];
				case "tool-call": return [block.name, block.arguments];
				case "tool-result": return block.content.flatMap(searchBlockText);
				default: return [];
			}
		}
		/** One current-surface user/assistant document, if searchable. */
		function searchEventText(event) {
			const content = event.type === "user/message" ? event.data.content : event.type === "assistant/message" ? event.data.message.content : void 0;
			if (content === void 0) return "";
			return content.flatMap(searchBlockText).map((part) => part.trim()).filter(Boolean).join("\n");
		}
		/**
		* Browser-safe approximation of SQLite FTS5 unicode61 token boundaries.
		* Keeping phrase matching token-based prevents the development fixture from
		* promising arbitrary within-token substring behavior that production lacks.
		*/
		function searchTokenSpans(value) {
			const text = value.replace(/\s+/gu, " ").trim();
			const characters = Array.from(text);
			const tokens = [];
			let start;
			let raw = "";
			const flush = (end) => {
				if (start !== void 0) {
					const folded = raw.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
					if (folded !== "") tokens.push({
						value: folded,
						start,
						end
					});
				}
				start = void 0;
				raw = "";
			};
			for (let index = 0; index < characters.length; index++) {
				const character = characters[index];
				const tokenBase = character.normalize("NFD").replace(/\p{M}+/gu, "");
				if (tokenBase === "") {
					if (start !== void 0) raw += character;
					continue;
				}
				if (/^[\p{L}\p{N}\p{Co}]+$/u.test(tokenBase)) {
					start ??= index;
					raw += character;
				} else flush(index);
			}
			flush(characters.length);
			return {
				text,
				tokens
			};
		}
		/** Count exact contiguous token-phrase occurrences and retain the first display span. */
		function phraseMatch(document, phrase) {
			if (phrase.length === 0 || phrase.length > document.length) return {
				count: 0,
				start: 0,
				end: 0
			};
			let count = 0;
			let firstStart = 0;
			let firstEnd = 0;
			for (let start = 0; start <= document.length - phrase.length; start++) {
				if (!phrase.every((token, offset) => document[start + offset]?.value === token)) continue;
				count++;
				if (count === 1) {
					firstStart = document[start]?.start ?? 0;
					firstEnd = document[start + phrase.length - 1]?.end ?? firstStart;
				}
			}
			return {
				count,
				start: firstStart,
				end: firstEnd
			};
		}
		/** Match-centered fixture excerpt, bounded by Unicode code points for the sidebar. */
		function searchSnippet(value, matchStart, matchEnd) {
			const characters = Array.from(value);
			if (characters.length <= 120) return value;
			const boundedStart = Math.min(Math.max(0, matchStart), characters.length - 1);
			const boundedEnd = Math.min(characters.length, Math.max(boundedStart + 1, matchEnd));
			const center = Math.floor((boundedStart + boundedEnd) / 2);
			let start = Math.min(characters.length - 118, Math.max(0, center - Math.floor(118 / 2)));
			let end = start + 118;
			if (start === 0) end = 119;
			else if (end === characters.length) start = characters.length - 119;
			return `${start > 0 ? "…" : ""}${characters.slice(start, end).join("")}${end < characters.length ? "…" : ""}`;
		}
		/** Mirrors `packages/session-query/session-query-sqlite/src/index.ts`; update both together. */
		function compareSearchCandidates(a, b) {
			if (a.matchCount !== b.matchCount) return b.matchCount - a.matchCount;
			if (a.documentLength !== b.documentLength) return a.documentLength - b.documentLength;
			if (a.time !== b.time) return b.time - a.time;
			if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
			return b.seq - a.seq;
		}
		/**
		* Current plan projection over the full log (host parallel: latest todo/write
		* with no later turn/start; a new turn retires the previous plan).
		*/
		function backscanTodos(log) {
			for (let i = log.length - 1; i >= 0; i--) {
				const event = log[i];
				if (event === void 0) continue;
				if (event.type === "turn/start") return void 0;
				if (event.type === "todo/write") return event.data.todos;
			}
		}
		/**
		* Current goal projection over the full log (host parallel: the GoalService
		* unit's last-wins fold of goal/change whole values; clear returns null).
		*/
		function backscanGoal(log) {
			for (let i = log.length - 1; i >= 0; i--) {
				const event = log[i];
				if (event === void 0 || event.type !== "goal/change" || event.data === void 0) continue;
				const change = event.data;
				if (change.operation === "clear") return null;
				return {
					goal: change.goal,
					roundsStarted: change.roundsStarted,
					createdAt: change.createdAt,
					updatedAt: change.updatedAt
				};
			}
			return null;
		}
		/** Inbox pump shared by both stream generators (FrameQueue pattern: ONE abort listener hung
		*  outside the loop — a per-iteration {once:true} listener never fires for non-final rounds and
		*  piles up for the stream's lifetime). breakNow force-ends the stream without the
		*  client's signal (timing hook: simulated connection loss). */
		var FxInbox = class {
			inbox = [];
			wake = null;
			broken = false;
			push(value) {
				this.inbox.push(value);
				this.wake?.();
			}
			breakNow() {
				this.broken = true;
				this.wake?.();
			}
			/** Read through a method: breakNow()/abort flip state across yields, so narrowing from the loop condition must not stick. */
			isLive(signal) {
				return !signal.aborted && !this.broken;
			}
			async *drain(signal) {
				const onAbort = () => this.wake?.();
				signal.addEventListener("abort", onAbort);
				try {
					while (this.isLive(signal)) {
						while (this.inbox.length > 0) yield this.inbox.shift();
						if (!this.isLive(signal)) break;
						await new Promise((resolve) => {
							this.wake = resolve;
						});
						this.wake = null;
					}
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			}
		};
		/** Build the fixture's Remote RPC face over one state graph. */
		function createFixtureWorld(options) {
			const sessions = options.empty ? [] : [
				{
					sessionId: sid("fx-alpha"),
					updatedAt: Date.now(),
					running: true,
					blank: false,
					cwd: "/tmp/fixture"
				},
				{
					sessionId: sid("fx-beta"),
					updatedAt: Date.now() - 6e4,
					running: false,
					blank: false,
					parentSessionId: sid("fx-alpha"),
					cwd: "/tmp/fixture"
				},
				{
					sessionId: sid("fx-gamma"),
					updatedAt: Date.now() - 12e4,
					running: false,
					blank: false,
					cwd: "/tmp/fixture"
				}
			];
			const logs = new Map([[sid("fx-alpha"), buildAlphaLog()]]);
			const modelSelections = new Map(sessions.map((session) => [session.sessionId, {
				provider: "deepseek-official",
				model: "deepseek-v4-flash"
			}]));
			const attachments = new Map([[String(FIXTURE_IMAGE_REF.attachmentId), {
				attachment: FIXTURE_IMAGE_REF,
				data: FIXTURE_IMAGE_DATA
			}]]);
			/** Credential store double: set/unset flip the describe badge, values never read back. */
			const fixtureCredentials = new Map([["DEEPSEEK_API_KEY", true]]);
			/** Canonical fixture implementation of the generated Settings Remote contract. */
			const settingsRemotes = {
				describe() {
					return {
						ok: true,
						value: {
							writable: true,
							hasDocument: true,
							namespaces: [{
								ns: "llm-deepseek",
								schema: {},
								value: { apiKeyEnv: "DEEPSEEK_API_KEY" },
								applies: "live",
								secrets: [{
									path: ["apiKey"],
									set: false
								}],
								revision: 0
							}]
						}
					};
				},
				update(ns) {
					return {
						ok: false,
						error: {
							code: "settings-rejected",
							message: "fixture: the minimal readiness settings descriptor is read-only",
							details: { ns }
						}
					};
				},
				replace(ns) {
					return {
						ok: false,
						error: {
							code: "settings-rejected",
							message: "fixture: the minimal readiness settings descriptor is read-only",
							details: { ns }
						}
					};
				},
				mutate(ns) {
					return {
						ok: false,
						error: {
							code: "settings-rejected",
							message: "fixture: no settings namespaces are registered",
							details: { ns }
						}
					};
				},
				openSettingsDocument() {
					return {
						ok: true,
						value: { opened: true }
					};
				},
				openAgentPresetDirectory(agentPreset) {
					const existing = fixturePresets.get(agentPreset);
					if (existing === void 0 || existing.trust === "system") return {
						ok: false,
						error: {
							code: "agent-preset-read-only",
							message: `agent preset "${agentPreset}" ships with the deployment`,
							details: {
								agentPreset,
								reason: "it ships with the deployment"
							}
						}
					};
					return {
						ok: true,
						value: { opened: true }
					};
				}
			};
			const credentialRemotes = {
				describe(refs) {
					return {
						ok: true,
						value: Object.fromEntries(refs.map((ref) => [ref, {
							configured: fixtureCredentials.has(ref),
							...fixtureCredentials.has(ref) ? { source: "file" } : {},
							writable: true
						}]))
					};
				},
				set(ref) {
					fixtureCredentials.set(ref, true);
					return {
						ok: true,
						value: void 0
					};
				},
				unset(ref) {
					fixtureCredentials.delete(ref);
					return {
						ok: true,
						value: void 0
					};
				}
			};
			/**
			* Preset compositions the fixture serves. Held as state rather than
			* constants so the settings editor's save and delete are exercisable: the
			* roster a GUI journey sees after writing is the text it wrote.
			*/
			const fixturePresets = new Map([
				["standard", {
					trust: "system",
					content: "- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n"
				}],
				["minimal", {
					trust: "system",
					content: "- id: tool-web-search\n  name: '@deepseek-ai/dsh-tool-web-search'\n"
				}],
				["my-agent", {
					trust: "user",
					content: "- id: tool-read\n  name: '@deepseek-ai/dsh-tool-read'\n"
				}]
			]);
			let fixtureDefaultPreset = "standard";
			const nextTurn = new Map([[sid("fx-alpha"), 75]]);
			let nextSession = 1;
			const wid = (raw) => raw;
			const fixtureEpoch = (/* @__PURE__ */ new Date(Date.now() - 3e5)).toISOString();
			const FIXTURE_HOME = "/home/fixture";
			const workspaces = options.empty ? [] : [{
				workspaceId: wid("fx-ws-fixture"),
				path: "/tmp/fixture",
				title: "fixture",
				sessionIds: [
					sid("fx-alpha"),
					sid("fx-beta"),
					sid("fx-gamma")
				],
				createdAt: fixtureEpoch,
				updatedAt: fixtureEpoch
			}, {
				workspaceId: wid("fx-ws-home"),
				path: `${FIXTURE_HOME}/Documents/project`,
				title: "project",
				sessionIds: [],
				createdAt: fixtureEpoch,
				updatedAt: fixtureEpoch
			}];
			let nextWorkspace = 1;
			const archivedSessionIds = [];
			const workspaceSnapshot = (workspace) => ({
				...workspace,
				sessionIds: [...workspace.sessionIds]
			});
			const workspaceBaseline = () => ({
				type: "baseline",
				value: {
					items: workspaces.map(workspaceSnapshot),
					archivedSessionIds: [...archivedSessionIds]
				}
			});
			const directoryTree = new Map([
				["/", ["home"]],
				["/home", ["fixture"]],
				[FIXTURE_HOME, [
					"Documents",
					"Downloads",
					".config"
				]],
				[`${FIXTURE_HOME}/Documents`, [
					"project",
					"deepseek-iOS",
					"deepseek-android",
					"deepseek-platform",
					"deepseek-web",
					"deepseek-harness",
					"deepseek-app",
					"deepseek-landing-blog"
				]]
			]);
			const childrenOf = (path) => {
				const known = directoryTree.get(path);
				if (known !== void 0) return known;
				const parent = path.slice(0, path.lastIndexOf("/")) || "/";
				const name = path.slice(path.lastIndexOf("/") + 1);
				return directoryTree.get(parent)?.includes(name) === true ? [] : void 0;
			};
			const crumbsOf = (path) => {
				const crumbs = [{
					name: "/",
					path: "/",
					hidden: false
				}];
				let acc = "";
				for (const segment of path.split("/").filter(Boolean)) {
					acc += `/${segment}`;
					crumbs.push({
						name: segment,
						path: acc,
						hidden: false
					});
				}
				return crumbs;
			};
			/** Resident waterfalls retain their event ids across Remote Event generations. */
			const pendingApprovalEventId = "fx-interaction-approval";
			let approvalPending = !options.empty;
			const pendingQuestionEventId = "fx-interaction-question";
			let questionPending = !options.empty;
			const fixtureQuestions = [
				{
					id: "harness-profile",
					header: "偏好",
					question: "你现在更想招哪类 Agent/Harness 候选人？",
					options: [
						{
							label: "工程落地型 (Recommended)",
							description: "更看重能直接做 runtime、tool executor、sandbox、trace 和线上问题排查。"
						},
						{
							label: "研究潜力型",
							description: "更看重 Agent 理解、训练评测思路和长期成长空间。"
						},
						{
							label: "均衡型",
							description: "同时要求工程能力和 Agent 认知，但可能筛选门槛更高。"
						}
					]
				},
				{
					id: "work-mode",
					header: "方式",
					question: "你希望候选人优先展示哪种工作方式？",
					options: [{
						label: "先做小型原型 (Recommended)",
						description: "用可运行结果尽快验证关键假设。"
					}, {
						label: "先写完整设计",
						description: "先收敛边界、协议和风险，再开始实现。"
					}]
				},
				{
					id: "signals",
					header: "信号",
					question: "哪些面试信号最重要？",
					detail: "按当前招聘目标选择；跳过则视为不设偏好。",
					multiSelect: true,
					options: [
						{ label: "系统设计" },
						{ label: "代码质量" },
						{ label: "Agent 产品判断" }
					]
				}
			];
			const controlConns = /* @__PURE__ */ new Set();
			const followConns = /* @__PURE__ */ new Map();
			const workspaceConns = /* @__PURE__ */ new Set();
			const remoteEventConns = /* @__PURE__ */ new Map();
			const emitControl = (frame) => {
				for (const conn of controlConns) conn.push(frame);
			};
			const emitWorkspace = (frame) => {
				for (const conn of workspaceConns) conn.push(frame);
			};
			const emitRemote = (event, args) => {
				for (const conn of remoteEventConns.values()) conn.push({
					type: "emit",
					event,
					args
				});
			};
			const emitRemoteFrame = (frame) => {
				for (const conn of remoteEventConns.values()) conn.push(frame);
			};
			const emitFollow = (sessionId, entry) => {
				for (const conn of followConns.get(sessionId) ?? []) conn.push(entry);
			};
			function sessionOk(value) {
				return Promise.resolve({
					ok: true,
					value
				});
			}
			function sessionErr(error) {
				return Promise.resolve({
					ok: false,
					error
				});
			}
			const summaryOf = (id) => sessions.find((s) => s.sessionId === id);
			const requireRemoteSession = (request) => {
				if (summaryOf(request.sessionId) !== void 0) return void 0;
				return sessionErr({
					code: "session-not-found",
					message: `no session ${request.sessionId}`,
					details: { sessionId: request.sessionId }
				});
			};
			const setRunning = (id, running) => {
				const summary = summaryOf(id);
				if (summary === void 0 || summary.running === running) return;
				summary.running = running;
				emitRemote("api-session/status", [id, running]);
			};
			const logOf = (id) => {
				let log = logs.get(id);
				if (log === void 0) {
					log = [];
					logs.set(id, log);
				}
				return log;
			};
			const append = (id, e) => {
				const log = logOf(id);
				const event = {
					seq: log.length,
					time: Date.now(),
					...e
				};
				log.push(event);
				emitFollow(id, {
					type: "event",
					event
				});
				for (const frame of projectionFramesOf(id, log, event)) emitControl(frame);
				if (event.type === "user/message" && event.data.source.kind === "user") {
					const summary = summaryOf(id);
					if (summary !== void 0) summary.updatedAt = event.time;
					emitRemote("api-session/activity", [id, event.time]);
				}
			};
			/** Append one durable goal/change (host GoalService parallel). */
			const appendGoalChange = (id, change) => {
				const log = logOf(id);
				append(id, {
					type: "goal/change",
					data: change
				});
				return backscanGoal(log);
			};
			const goalFailure = (message) => ({
				ok: false,
				error: {
					code: "internal",
					message,
					details: {}
				}
			});
			const requireGoalSession = (id) => summaryOf(id) === void 0 ? {
				ok: false,
				error: {
					code: "session-not-found",
					message: `no session ${id}`,
					details: { sessionId: id }
				}
			} : void 0;
			/** Canonical fixture implementation of the generated Commands Remote contract. */
			const commandRemotes = {
				list(id) {
					const missing = requireGoalSession(id);
					if (missing !== void 0) return missing;
					return {
						ok: true,
						value: [
							{
								name: "compact",
								description: "fixture：压缩当前会话上下文"
							},
							{
								name: "echo",
								description: "fixture：回显参数",
								input: { hint: "text to echo" }
							},
							{
								name: "goal",
								description: "set or view the goal for a long-running task",
								input: {
									hint: "<objective>",
									images: true
								}
							},
							{
								name: "permission",
								description: "Switch the permission preset (sandbox mode + approval policy)",
								input: { hint: "<preset>" }
							},
							{
								name: "plan",
								description: "Enter or leave plan mode",
								input: {
									hint: "[off|message]",
									images: true
								}
							}
						]
					};
				},
				execute(id, line, images = []) {
					const missing = requireGoalSession(id);
					if (missing !== void 0) return missing;
					const match = /^\/(\S+)((?:\s.*)?)$/.exec(line.trim());
					const name = match?.[1];
					const args = match?.[2] ?? "";
					if (images.length > 0 && name !== void 0 && [
						"permission",
						"goal",
						"compact",
						"echo",
						"plan"
					].includes(name)) {
						const rejection = name !== "goal" && name !== "plan" ? `/${name} does not accept image attachments` : name === "goal" && args.trim() === "" ? "Image attachments only accompany a goal objective: /goal <objective> or /goal edit <objective>." : name === "plan" && args.trim() === "off" ? "Image attachments cannot accompany /plan off." : void 0;
						if (rejection !== void 0) {
							const commandId = `fx-cmd-${logOf(id).length}`;
							append(id, {
								type: "command/run",
								data: {
									commandId,
									name,
									args,
									source: { kind: "user" }
								}
							});
							const result = {
								kind: "error",
								text: rejection
							};
							append(id, {
								type: "command/done",
								data: {
									commandId,
									...result
								}
							});
							return {
								ok: true,
								value: {
									commandId,
									result
								}
							};
						}
					}
					if (name === "permission") {
						const preset = args.trim();
						const commandId = `fx-cmd-${logOf(id).length}`;
						append(id, {
							type: "command/run",
							data: {
								commandId,
								name,
								args,
								source: { kind: "user" }
							}
						});
						const spec = PERMISSION_PRESETS[preset];
						let result;
						if (preset === "") result = {
							kind: "success",
							text: `current preset ${permissionSelectOf(logOf(id)).currentValue} (available: ${Object.keys(PERMISSION_PRESETS).join(", ")})`
						};
						else if (spec === void 0) result = {
							kind: "error",
							text: `unknown preset "${preset}" (available: ${Object.keys(PERMISSION_PRESETS).join(", ")})`
						};
						else {
							if (permissionSelectOf(logOf(id)).currentValue !== preset) append(id, {
								type: "permission/preset",
								data: { preset }
							});
							append(id, {
								type: "sandbox/mode",
								data: { mode: spec.sandbox }
							});
							append(id, {
								type: "approval/policy",
								data: { policy: spec.approval }
							});
							result = {
								kind: "success",
								text: `preset ${preset}`
							};
						}
						append(id, {
							type: "command/done",
							data: {
								commandId,
								...result
							}
						});
						return {
							ok: true,
							value: {
								commandId,
								result
							}
						};
					}
					if (name === "goal") {
						const commandId = `fx-cmd-${logOf(id).length}`;
						append(id, {
							type: "command/run",
							data: {
								commandId,
								name,
								args,
								source: { kind: "user" }
							}
						});
						const objective = args.trim();
						const current = backscanGoal(logOf(id));
						let text;
						if (objective === "") text = current === null ? "No goal is set. Usage: /goal <objective>" : `Current goal: ${current.goal.objective}`;
						else if (current !== null && current.goal.phase !== "complete") text = `A goal already exists (${current.goal.objective}). Clear it first.`;
						else text = `Goal created: ${appendGoalChange(id, {
							kind: "goal/change",
							version: 1,
							operation: "create",
							goal: {
								id: `fx-goal-${logOf(id).length}`,
								revision: 1,
								objective,
								phase: "active",
								maxGoalRounds: 256
							},
							roundsStarted: 0,
							createdAt: Date.now(),
							updatedAt: Date.now()
						}).goal.objective}`;
						const result = {
							kind: "success",
							text
						};
						append(id, {
							type: "command/done",
							data: {
								commandId,
								...result
							}
						});
						return {
							ok: true,
							value: {
								commandId,
								result
							}
						};
					}
					const running = summaryOf(id)?.running === true;
					const outcomes = {
						compact: "fixture：已压缩（假动作）",
						echo: args.trim(),
						plan: args.trim() === "off" ? running ? "Leaving plan mode (applies from the next step)." : "Plan mode off." : running ? "Entering plan mode (applies from the next step). Use /plan off to leave." : "Plan mode on. Use /plan off to leave."
					};
					const text = name === void 0 ? void 0 : outcomes[name];
					if (name === void 0 || text === void 0) return {
						ok: true,
						value: void 0
					};
					const commandId = `fx-cmd-${logOf(id).length}`;
					append(id, {
						type: "command/run",
						data: {
							commandId,
							name,
							args,
							source: { kind: "user" }
						}
					});
					if (name === "plan" && !running) {
						const plan = foldPlan(logOf(id));
						if (plan.wanted !== null && plan.wanted !== plan.active) append(id, {
							type: "plan/mode",
							data: { active: plan.wanted }
						});
					}
					const result = {
						kind: "success",
						...text === "" ? {} : { text }
					};
					append(id, {
						type: "command/done",
						data: {
							commandId,
							...result
						}
					});
					return {
						ok: true,
						value: {
							commandId,
							result
						}
					};
				}
			};
			const goalView = (projection) => ({
				...projection.goal,
				roundsStarted: projection.roundsStarted,
				createdAt: projection.createdAt,
				updatedAt: projection.updatedAt,
				activation: projection.goal.phase === "active" ? "armed" : "disarmed"
			});
			/** Canonical fixture implementation of the generated Goal Remote contract. */
			/** Canonical fixture implementation of the generated reference-discovery Remote contracts. */
			const referenceRemotes = {
				files(id, query) {
					const missing = requireGoalSession(id);
					if (missing !== void 0) return missing;
					const needle = query.toLocaleLowerCase();
					return {
						ok: true,
						value: [
							{
								path: "notes",
								kind: "directory"
							},
							{
								path: "README.md",
								kind: "file"
							},
							{
								path: "notes/demo.txt",
								kind: "file"
							}
						].filter((item) => item.path.toLocaleLowerCase().includes(needle))
					};
				},
				sessions(id, query) {
					const missing = requireGoalSession(id);
					if (missing !== void 0) return missing;
					const needle = query.toLocaleLowerCase();
					return {
						ok: true,
						value: sessions.filter((item) => item.sessionId !== id).filter((item) => String(item.sessionId).toLocaleLowerCase().includes(needle) || item.cwd?.toLocaleLowerCase().includes(needle) === true).map((item) => {
							const label = item.sessionId === sid("fx-beta") ? "Fixture child session" : String(item.sessionId);
							const encoded = btoa(JSON.stringify(item.sessionId)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
							return {
								sessionId: item.sessionId,
								label,
								...item.cwd === void 0 ? {} : { cwd: item.cwd },
								createdAt: item.updatedAt,
								mention: `@[${label}](dsh-session:${encoded})`
							};
						})
					};
				}
			};
			/**
			* Canonical fixture implementation of the generated Directory Picker Remote
			* contract. The pick is deterministic — the keyless lanes drive the full
			* pick-then-adopt path without an OS chooser — over the same design-mock
			* tree the browse primitives serve.
			*/
			const directoryPickerRemotes = {
				pick() {
					return {
						ok: true,
						value: `${FIXTURE_HOME}/Documents/project`
					};
				},
				list(path) {
					const target = path ?? FIXTURE_HOME;
					const children = childrenOf(target);
					if (children === void 0) return {
						ok: false,
						error: {
							code: "directory-unreadable",
							message: `cannot list ${target}: not in the fixture tree`,
							details: { path: target }
						}
					};
					return {
						ok: true,
						value: {
							path: target,
							home: FIXTURE_HOME,
							crumbs: crumbsOf(target),
							entries: [...children].sort((a, b) => a.localeCompare(b)).map((name) => ({
								name,
								path: target === "/" ? `/${name}` : `${target}/${name}`,
								hidden: name.startsWith(".")
							})),
							truncated: false
						}
					};
				},
				createDirectory(parent, name) {
					const children = childrenOf(parent);
					if (children === void 0) return {
						ok: false,
						error: {
							code: "directory-create-failed",
							message: `missing parent ${parent}`,
							details: { path: parent }
						}
					};
					const target = parent === "/" ? `/${name}` : `${parent}/${name}`;
					if (children.includes(name)) return {
						ok: false,
						error: {
							code: "directory-exists",
							message: `${target} already exists`,
							details: { path: target }
						}
					};
					directoryTree.set(parent, [...children, name]);
					directoryTree.set(target, []);
					return {
						ok: true,
						value: target
					};
				}
			};
			const goalRemotes = {
				create(id, request) {
					const missing = requireGoalSession(id);
					if (missing !== void 0) return missing;
					const current = backscanGoal(logOf(id));
					if (current !== null && current.goal.phase !== "complete") return goalFailure(`goal "${current.goal.id}" already exists`);
					const now = Date.now();
					const projection = appendGoalChange(id, {
						kind: "goal/change",
						version: 1,
						operation: "create",
						goal: {
							id: `fx-goal-${logOf(id).length}`,
							revision: 1,
							objective: request.objective,
							phase: "active",
							maxGoalRounds: request.maxGoalRounds ?? 256
						},
						roundsStarted: 0,
						createdAt: now,
						updatedAt: now
					});
					return {
						ok: true,
						value: { ref: {
							id: projection.goal.id,
							revision: projection.goal.revision
						} }
					};
				},
				edit(id, ref, request) {
					return mutateGoal(id, ref, (current) => ({
						...current.goal,
						revision: current.goal.revision + 1,
						...request.objective === void 0 ? {} : { objective: request.objective },
						...request.maxGoalRounds === void 0 ? {} : { maxGoalRounds: request.maxGoalRounds }
					}));
				},
				pause(id, ref) {
					return mutateGoal(id, ref, (current) => current.goal.phase === "active" ? {
						...current.goal,
						revision: current.goal.revision + 1,
						phase: "paused"
					} : void 0);
				},
				resume(id, ref) {
					return mutateGoal(id, ref, (current) => current.goal.phase === "paused" || current.goal.phase === "blocked" || current.goal.phase === "active" ? {
						...current.goal,
						revision: current.goal.revision + 1,
						phase: "active"
					} : void 0);
				},
				complete(id, ref) {
					return mutateGoal(id, ref, (current) => current.goal.phase === "complete" ? void 0 : {
						...current.goal,
						revision: current.goal.revision + 1,
						phase: "complete"
					});
				},
				clear(id, ref) {
					const resolved = resolveGoal(id, ref);
					if (!resolved.ok) return resolved;
					const current = resolved.value;
					const tombstone = {
						id: current.goal.id,
						revision: current.goal.revision + 1
					};
					appendGoalChange(id, {
						kind: "goal/change",
						version: 1,
						operation: "clear",
						cleared: tombstone,
						clearedAt: Date.now()
					});
					return {
						ok: true,
						value: tombstone
					};
				}
			};
			/** Resolve one current goal revision for a canonical Remote mutation. */
			function resolveGoal(id, ref) {
				const missing = requireGoalSession(id);
				if (missing !== void 0) return missing;
				const current = backscanGoal(logOf(id));
				if (current === null || current.goal.id !== ref.id || current.goal.revision !== ref.revision) return goalFailure("stale or missing goal revision");
				return {
					ok: true,
					value: current
				};
			}
			/** Shared CAS mutation path behind the canonical Remote verbs. */
			function mutateGoal(id, ref, next) {
				const resolved = resolveGoal(id, ref);
				if (!resolved.ok) return resolved;
				const current = resolved.value;
				const goal = next(current);
				if (goal === void 0) return goalFailure(`invalid goal transition from "${current.goal.phase}"`);
				return {
					ok: true,
					value: goalView(appendGoalChange(id, {
						kind: "goal/change",
						version: 1,
						operation: goal.phase === current.goal.phase ? "edit" : goal.phase === "paused" ? "pause" : goal.phase === "active" ? "resume" : "complete",
						goal,
						roundsStarted: current.roundsStarted,
						createdAt: current.createdAt,
						updatedAt: Date.now()
					}))
				};
			}
			/** Canonical fixture implementation of the generated AgentPresets Remote contract. */
			const presetRemotes = {
				list() {
					return {
						ok: true,
						value: {
							presets: [...fixturePresets].map(([id, preset]) => ({
								id,
								trust: preset.trust,
								isDefault: id === fixtureDefaultPreset
							})),
							authorable: true
						}
					};
				},
				select(_id, agentPreset) {
					fixtureDefaultPreset = agentPreset;
					return {
						ok: true,
						value: agentPreset
					};
				},
				read(agentPreset) {
					const preset = fixturePresets.get(agentPreset);
					if (preset === void 0) return {
						ok: false,
						error: {
							code: "agent-preset-not-found",
							message: `unknown agent preset "${agentPreset}"`,
							details: {
								agentPreset,
								available: [...fixturePresets.keys()]
							}
						}
					};
					return {
						ok: true,
						value: {
							agentPreset,
							trust: preset.trust,
							content: preset.content
						}
					};
				},
				copy(from, id) {
					const source = fixturePresets.get(from);
					if (source === void 0) return {
						ok: false,
						error: {
							code: "agent-preset-not-found",
							message: `unknown agent preset "${from}"`,
							details: {
								agentPreset: from,
								available: [...fixturePresets.keys()]
							}
						}
					};
					if (fixturePresets.has(id)) return {
						ok: false,
						error: {
							code: "agent-preset-invalid",
							message: `agent preset "${id}" already exists`,
							details: {
								agentPreset: id,
								reason: "already exists"
							}
						}
					};
					fixturePresets.set(id, {
						trust: "user",
						content: source.content
					});
					return {
						ok: true,
						value: void 0
					};
				},
				deletePreset(id) {
					if (fixturePresets.get(id)?.trust === "system") return {
						ok: false,
						error: {
							code: "agent-preset-read-only",
							message: `agent preset "${id}" ships with the deployment`,
							details: {
								agentPreset: id,
								reason: "it ships with the deployment"
							}
						}
					};
					fixturePresets.delete(id);
					return {
						ok: true,
						value: void 0
					};
				}
			};
			/** At most one in-flight replay per session; cancel clears it. */
			const replays = /* @__PURE__ */ new Map();
			/** History transit delay; the page snapshot is taken at request time. */
			let historyDelayMs = 0;
			/** One-shot history failure (timing hook: a pre-disconnect history request already doomed when reconnect lands). */
			let failNextHistory = false;
			/** Force-enders for currently open stream generators (timing hook: simulated connection loss). */
			const streamBreakers = /* @__PURE__ */ new Set();
			/** Retry scenarios opened by timing hooks and completed in a later browser assertion phase. */
			const retryScenarios = /* @__PURE__ */ new Map();
			/** The single opt-in browser stress producer; normal fixture journeys never start it. */
			let activeReasoningChunkStorm = null;
			globalThis.__fxTiming = {
				setHistoryDelay(ms) {
					historyDelayMs = ms;
				},
				/** Fail the NEXT history call (after its transit delay) with a transport-level throw. */
				failNextHistory() {
					failNextHistory = true;
				},
				/** Log append plus follow-stream delivery (the normal live path). */
				appendUser(id, msg) {
					append(sid(id), {
						type: "user/message",
						surfaceOp: "append",
						data: userMessage(text(msg))
					});
				},
				/** Append a later durable title revision through the normal raw-event + control-frame path. */
				appendTitle(id, title) {
					const messageSeqs = logOf(sid(id)).filter((event) => event.type === "user/message").map((event) => event.seq);
					append(sid(id), {
						type: "session/title",
						data: {
							title,
							messageSeqs,
							source: {
								kind: "provider",
								provider: "fixture"
							}
						}
					});
				},
				/** Start an externally paced reasoning stream for the opt-in browser stress lane. */
				startReasoningChunkStorm(id, chunkCount, chunksPerInterval, intervalMs) {
					if (!Number.isSafeInteger(chunkCount) || chunkCount < 1) throw new Error("fixture: reasoning chunk count must be a positive safe integer");
					if (!Number.isSafeInteger(chunksPerInterval) || chunksPerInterval < 1) throw new Error("fixture: reasoning chunks per interval must be a positive safe integer");
					if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error("fixture: reasoning interval must be a positive safe integer");
					if (activeReasoningChunkStorm?.emitting === true) throw new Error("fixture: reasoning chunk storm already running");
					const sessionId = sid(id);
					const log = logOf(sessionId);
					let turn = nextTurn.get(sessionId) ?? 0;
					for (const event of log) {
						const candidate = event.data?.turn;
						if (typeof candidate === "number") turn = Math.max(turn, candidate + 1);
					}
					nextTurn.set(sessionId, turn + 1);
					const marker = `REASONING_STRESS_COMPLETE:${String(turn)}:${String(chunkCount)}`;
					const state = {
						sessionId: id,
						chunkCount,
						chunksPerInterval,
						intervalMs,
						emitted: 0,
						marker,
						emitting: true
					};
					activeReasoningChunkStorm = state;
					setRunning(sessionId, true);
					append(sessionId, {
						type: "turn/start",
						data: {
							turn,
							trigger: {
								kind: "message",
								source: { kind: "user" }
							}
						}
					});
					append(sessionId, {
						type: "user/message",
						surfaceOp: "append",
						data: userMessage(text(`Reasoning chunk stress: ${String(chunkCount)} chunks.`))
					});
					append(sessionId, {
						type: "step/start",
						data: {
							turn,
							step: 0
						}
					});
					append(sessionId, {
						type: "assistant/chunk",
						data: {
							turn,
							step: 0,
							chunk: {
								type: "block-start",
								index: 0,
								blockType: "reasoning"
							}
						}
					});
					const startedAt = Date.now();
					const pump = () => {
						const elapsedIntervals = Math.floor((Date.now() - startedAt) / intervalMs) + 1;
						const due = Math.max(state.emitted + chunksPerInterval, elapsedIntervals * chunksPerInterval);
						const end = Math.min(due, chunkCount);
						for (let index = state.emitted; index < end; index++) {
							const chunkText = index === chunkCount - 1 ? `\n${marker}` : index % 64 === 63 ? "推理\n" : "推理";
							append(sessionId, {
								type: "assistant/chunk",
								data: {
									turn,
									step: 0,
									chunk: {
										type: "reasoning-delta",
										index: 0,
										text: chunkText
									}
								}
							});
						}
						state.emitted = end;
						if (end < chunkCount) setTimeout(pump, intervalMs);
						else state.emitting = false;
					};
					setTimeout(pump, 0);
					return marker;
				},
				/** Return a copy so browser probes cannot mutate the active producer. */
				reasoningChunkStormState() {
					return activeReasoningChunkStorm === null ? null : { ...activeReasoningChunkStorm };
				},
				/** Open one failed model step whose partial remains visible until llm/retry arrives. */
				beginModelRetry(id) {
					const sessionId = sid(id);
					const turn = nextTurn.get(sessionId) ?? 0;
					nextTurn.set(sessionId, turn + 1);
					retryScenarios.set(sessionId, {
						turn,
						stepStarted: true
					});
					setRunning(sessionId, true);
					append(sessionId, {
						type: "turn/start",
						data: { turn }
					});
					append(sessionId, {
						type: "user/message",
						surfaceOp: "append",
						data: {
							content: text("请重试这个请求"),
							source: { kind: "user" }
						}
					});
					append(sessionId, {
						type: "step/start",
						data: {
							turn,
							step: 1
						}
					});
					append(sessionId, {
						type: "assistant/chunk",
						data: {
							turn,
							step: 1,
							chunk: {
								type: "block-start",
								index: 0,
								blockType: "text"
							}
						}
					});
					append(sessionId, {
						type: "assistant/chunk",
						data: {
							turn,
							step: 1,
							chunk: {
								type: "text-delta",
								index: 0,
								text: "应撤回的半截回复"
							}
						}
					});
				},
				/** Record one retry decision; the next attempt remains in the same step. */
				scheduleModelRetry(id, retry = 1, delayMs = 450) {
					const sessionId = sid(id);
					const scenario = retryScenarios.get(sessionId);
					if (scenario === void 0) throw new Error(`fixture: no model retry scenario for ${id}`);
					if (!scenario.stepStarted) {
						append(sessionId, {
							type: "assistant/chunk",
							data: {
								turn: scenario.turn,
								step: 1,
								chunk: {
									type: "block-start",
									index: 0,
									blockType: "text"
								}
							}
						});
						append(sessionId, {
							type: "assistant/chunk",
							data: {
								turn: scenario.turn,
								step: 1,
								chunk: {
									type: "text-delta",
									index: 0,
									text: `第 ${String(retry)} 次应撤回的回复`
								}
							}
						});
						scenario.stepStarted = true;
					}
					append(sessionId, {
						type: "llm/retry",
						data: {
							turn: scenario.turn,
							step: 1,
							provider: "fixture",
							mode: "normal",
							policyKey: "fixture-normal",
							retry,
							maxRetries: 2,
							delayMs,
							failure: {
								code: "TRANSPORT",
								message: "连接被重置"
							}
						}
					});
					scenario.stepStarted = false;
				},
				/** Record one retry decision, then cancel its source turn before the retry starts. */
				cancelModelRetryDuringBackoff(id, delayMs = 450) {
					const sessionId = sid(id);
					const scenario = retryScenarios.get(sessionId);
					if (scenario === void 0) throw new Error(`fixture: no model retry scenario for ${id}`);
					append(sessionId, {
						type: "llm/retry",
						data: {
							turn: scenario.turn,
							step: 1,
							provider: "fixture",
							mode: "normal",
							policyKey: "fixture-normal",
							retry: 1,
							maxRetries: 2,
							delayMs,
							failure: {
								code: "TRANSPORT",
								message: "连接被重置"
							}
						}
					});
					append(sessionId, {
						type: "step/end",
						data: {
							turn: scenario.turn,
							step: 1
						}
					});
					append(sessionId, {
						type: "turn/end",
						data: {
							turn: scenario.turn,
							reason: {
								kind: "aborted",
								reason: { kind: "user" }
							}
						}
					});
					retryScenarios.delete(sessionId);
					setRunning(sessionId, false);
				},
				/** Finish the timing-hook retry with a finalized response in the open step. */
				completeModelRetry(id) {
					const sessionId = sid(id);
					const scenario = retryScenarios.get(sessionId);
					if (scenario === void 0) throw new Error(`fixture: no model retry scenario for ${id}`);
					retryScenarios.delete(sessionId);
					append(sessionId, {
						type: "assistant/chunk",
						data: {
							turn: scenario.turn,
							step: 1,
							chunk: {
								type: "block-start",
								index: 0,
								blockType: "text"
							}
						}
					});
					append(sessionId, {
						type: "assistant/message",
						surfaceOp: "append",
						data: {
							turn: scenario.turn,
							step: 1,
							message: assistantMessage(text("重试后的完整回复"))
						}
					});
					append(sessionId, {
						type: "step/end",
						data: {
							turn: scenario.turn,
							step: 1
						}
					});
					append(sessionId, {
						type: "turn/end",
						data: {
							turn: scenario.turn,
							reason: { kind: "completed" }
						}
					});
					setRunning(sessionId, false);
				},
				/** Log append without follow delivery: a frame lost in transit that page repair must recover. */
				appendSilent(id, msg) {
					const log = logOf(sid(id));
					log.push({
						type: "user/message",
						surfaceOp: "append",
						seq: log.length,
						time: Date.now(),
						data: userMessage(text(msg))
					});
				},
				/** End every open stream generator (client sees both streams close -> reconnect + resync path). */
				breakStreams() {
					for (const breakNow of [...streamBreakers]) breakNow();
				}
			};
			/** Prompt replay: chunk typewriter (80ms/frame) -> assistant/message finalize -> turn/end + running flip. */
			const startReply = (id, turn, replyText) => {
				const step = 0;
				append(id, {
					type: "step/start",
					data: {
						turn,
						step
					}
				});
				append(id, {
					type: "assistant/chunk",
					data: {
						turn,
						step,
						chunk: {
							type: "block-start",
							index: 0,
							blockType: "text"
						}
					}
				});
				/* v8 ignore next -- the ?? arm needs a null match, but every fixture reply is non-empty. */
				const pieces = replyText.match(/[\s\S]{1,6}/gu) ?? [replyText];
				let i = 0;
				const finish = (aborted) => {
					replays.delete(id);
					const done = pieces.slice(0, i).join("");
					append(id, {
						type: "assistant/chunk",
						data: {
							turn,
							step,
							chunk: {
								type: "block-end",
								index: 0,
								block: {
									type: "text",
									text: done
								}
							}
						}
					});
					append(id, {
						type: "assistant/message",
						surfaceOp: "append",
						data: {
							turn,
							step,
							message: assistantMessage(text(aborted ? `${done}（已中断）` : done)),
							usage: fixtureUsage(turn, step)
						}
					});
					append(id, {
						type: "step/end",
						data: {
							turn,
							step
						}
					});
					append(id, {
						type: "turn/end",
						data: {
							turn,
							reason: { kind: aborted ? "cancelled" : "completed" }
						}
					});
					setRunning(id, false);
				};
				const tick = () => {
					const piece = pieces[i];
					if (piece === void 0) {
						finish(false);
						return;
					}
					i++;
					append(id, {
						type: "assistant/chunk",
						data: {
							turn,
							step,
							chunk: {
								type: "text-delta",
								index: 0,
								text: piece
							}
						}
					});
					replays.set(id, {
						timer: setTimeout(tick, 80),
						finish
					});
				};
				replays.set(id, {
					timer: setTimeout(tick, 80),
					finish
				});
			};
			const sessionApi = {
				list: (_request) => sessionOk({ items: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt) }),
				search: (request, signal) => {
					if (signal.aborted) return sessionErr({
						code: "cancelled",
						message: "fixture session search was aborted",
						details: {}
					});
					const query = searchTokenSpans(request.query).tokens.map((token) => token.value);
					const matches = sessions.flatMap((summary) => {
						const log = logs.get(summary.sessionId) ?? [];
						const current = new Set(foldSurface(log).nodes);
						const best = log.flatMap((event) => {
							if (!current.has(event.seq)) return [];
							const eventText = searchEventText(event);
							const document = searchTokenSpans(eventText);
							const match = phraseMatch(document.tokens, query);
							if (match.count === 0) return [];
							return [{
								sessionId: summary.sessionId,
								seq: event.seq,
								time: event.time,
								text: document.text,
								matchCount: match.count,
								matchStart: match.start,
								matchEnd: match.end,
								documentLength: Array.from(eventText).length
							}];
						}).sort(compareSearchCandidates)[0];
						return best === void 0 ? [] : [best];
					}).sort(compareSearchCandidates);
					return sessionOk({
						items: matches.slice(0, FIXTURE_SESSION_SEARCH_RESULT_LIMIT).map((match) => ({
							sessionId: match.sessionId,
							snippet: searchSnippet(match.text, match.matchStart, match.matchEnd)
						})),
						hasMore: matches.length > FIXTURE_SESSION_SEARCH_RESULT_LIMIT
					});
				},
				create: async (request) => {
					const workspace = request.workspaceId === void 0 ? void 0 : workspaces.find((w) => w.workspaceId === request.workspaceId);
					if (request.workspaceId !== void 0 && workspace === void 0) return sessionErr({
						code: "workspace-not-found",
						message: `no workspace ${request.workspaceId}`,
						details: { workspaceId: request.workspaceId }
					});
					const cwd = workspace?.path ?? request.cwd ?? "/tmp/fixture";
					const requestedId = request.sessionId;
					const attachWorkspace = (sessionId) => {
						/* v8 ignore next -- callers enter only when a target Workspace exists. */
						if (workspace === void 0 || workspace.sessionIds.includes(sessionId)) return;
						workspace.sessionIds = [sessionId, ...workspace.sessionIds];
						workspace.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
						emitWorkspace({
							type: "upsert",
							workspace: workspaceSnapshot(workspace)
						});
					};
					const attachFailure = (sessionId, workspaceId) => sessionErr({
						code: "workspace-attach-failed",
						message: `fixture rejected Workspace attachment for ${sessionId}`,
						details: {
							sessionId,
							workspaceId
						}
					});
					if (requestedId !== void 0) {
						const existing = summaryOf(requestedId);
						if (existing !== void 0) {
							if (existing.cwd !== cwd) return sessionErr({
								code: "session-conflict",
								message: `session ${requestedId} already uses ${existing.cwd ?? "no cwd"}`,
								details: {
									sessionId: requestedId,
									requestedCwd: cwd,
									...existing.cwd === void 0 ? {} : { existingCwd: existing.cwd }
								}
							});
							if (workspace !== void 0 && !workspace.sessionIds.includes(requestedId)) {
								if (options.failWorkspaceAttach) return attachFailure(requestedId, workspace.workspaceId);
								attachWorkspace(requestedId);
							}
							return sessionOk({ sessionId: requestedId });
						}
					}
					const created = {
						sessionId: requestedId ?? sid(`fx-${nextSession++}`),
						updatedAt: Date.now(),
						running: false,
						blank: true,
						cwd
					};
					sessions.push(created);
					modelSelections.set(created.sessionId, {
						provider: "deepseek-official",
						model: "deepseek-v4-flash"
					});
					const emitSession = () => {
						emitRemote("api-session/added", [created]);
					};
					if (workspace !== void 0 && options.failWorkspaceAttach) {
						emitSession();
						return attachFailure(created.sessionId, workspace.workspaceId);
					}
					if (workspace !== void 0 && options.createFrameOrder === "workspace-first") {
						attachWorkspace(created.sessionId);
						emitSession();
					} else {
						emitSession();
						if (workspace !== void 0) attachWorkspace(created.sessionId);
					}
					if (options.dropSessionCreateResponse) throw new Error("fixture: dropped session.create response after publication");
					return sessionOk({ sessionId: created.sessionId });
				},
				rename: (request) => {
					const missing = requireRemoteSession(request);
					if (missing !== void 0) return missing;
					const { sessionId, title } = request;
					const normalized = title.trim().replace(/\s+/g, " ");
					if (normalized.length === 0) return sessionErr({
						code: "title-invalid",
						message: "session title must contain visible characters",
						details: { sessionId }
					});
					append(sessionId, {
						type: "session/title",
						data: {
							title: normalized,
							messageSeqs: [],
							source: { kind: "user" }
						}
					});
					return sessionOk({
						title: normalized,
						seq: logOf(sessionId).at(-1).seq
					});
				},
				fork: (request) => {
					const { sessionId, atSeq } = request;
					const source = summaryOf(sessionId);
					if (source === void 0) return sessionErr({
						code: "session-not-found",
						message: `no session ${sessionId}`,
						details: { sessionId }
					});
					const log = logs.get(sessionId) ?? [];
					const lastSeq = log.at(-1)?.seq ?? -1;
					const boundary = (atSeq === void 0 ? void 0 : log.find((e) => e.type === "turn/end" && e.seq >= atSeq)) ?? (atSeq === void 0 || atSeq > lastSeq ? log.findLast((e) => e.type === "turn/end") : void 0);
					if (boundary === void 0) return sessionErr({
						code: "fork-unavailable",
						message: atSeq !== void 0 && atSeq <= lastSeq ? `session ${sessionId} has not completed the turn containing event ${String(atSeq)}` : `session ${sessionId} has no completed turn`,
						details: { sessionId }
					});
					let cut = boundary.seq + 1;
					while (cut < log.length && log[cut]?.type !== "turn/start") cut++;
					const child = {
						sessionId: sid(`fx-${nextSession++}`),
						updatedAt: Date.now(),
						running: false,
						blank: false,
						parentSessionId: sessionId,
						...source.cwd === void 0 ? {} : { cwd: source.cwd }
					};
					logs.set(child.sessionId, log.slice(0, cut));
					sessions.push(child);
					emitRemote("api-session/added", [child]);
					const workspace = workspaces.find((w) => w.sessionIds.includes(sessionId));
					if (workspace !== void 0) {
						workspace.sessionIds = [child.sessionId, ...workspace.sessionIds];
						workspace.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
						emitWorkspace({
							type: "upsert",
							workspace: workspaceSnapshot(workspace)
						});
					}
					return sessionOk({ sessionId: child.sessionId });
				},
				history: async (request) => {
					const log = logs.get(request.sessionId) ?? [];
					const throughSeq = request.throughSeq ?? log.length - 1;
					const page = pageOf(log.slice(0, throughSeq + 1), request.beforeSeq, request.maxMessages ?? 50);
					const doomed = failNextHistory;
					failNextHistory = false;
					const delay = historyDelayMs;
					if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
					if (doomed) throw new Error("fixture: simulated history transport failure");
					return sessionOk(page);
				},
				selectModel: (request) => {
					const selected = {
						provider: request.provider,
						model: request.model,
						...request.reasoningEffort === void 0 ? {} : { reasoningEffort: request.reasoningEffort }
					};
					append(request.sessionId, {
						type: "model/selection",
						data: selected
					});
					modelSelections.set(request.sessionId, selected);
					return sessionOk({ selected });
				},
				prompt: (request) => {
					const { sessionId: id, mode, content } = request;
					const summary = summaryOf(id);
					if (summary === void 0) return sessionErr({
						code: "session-not-found",
						message: `no session ${id}`,
						details: { sessionId: id }
					});
					if (options.rejectPrompt) {
						if (content.some((block) => block.type === "image")) return sessionErr({
							code: "attachment-error",
							message: "fixture: image side exceeds the deployment limit",
							details: { reason: "IMAGE_DIMENSION_TOO_LARGE" }
						});
						return sessionErr({
							code: "agent-busy",
							message: "fixture: prompt rejected before acceptance",
							details: { reason: "fixture-prompt-rejection" }
						});
					}
					summary.updatedAt = Date.now();
					summary.blank = false;
					const userText = content.map((b) => b.type === "text" ? b.text : "").join("");
					const durable = content.map((block) => {
						if (block.type === "text") return block;
						const attachment = {
							attachmentId: `fixture:${randomUuid()}`,
							mediaType: block.mediaType,
							bytes: Math.max(1, Math.floor(block.data.length * 3 / 4) - (block.data.endsWith("==") ? 2 : block.data.endsWith("=") ? 1 : 0)),
							width: 160,
							height: 90,
							...block.name === void 0 ? {} : { name: block.name }
						};
						attachments.set(String(attachment.attachmentId), {
							attachment,
							data: block.data
						});
						return {
							type: "image",
							attachment
						};
					});
					const promptSource = {
						kind: "user",
						rpcId: request.requestId
					};
					if (mode === "steer" && replays.has(id)) {
						append(id, {
							type: "user/message",
							surfaceOp: "append",
							data: userMessage(durable, promptSource)
						});
						return sessionOk({ accepted: true });
					}
					const turn = nextTurn.get(id) ?? 0;
					nextTurn.set(id, turn + 1);
					setRunning(id, true);
					append(id, {
						type: "turn/start",
						data: { turn }
					});
					const plan = foldPlan(logOf(id));
					if (plan.wanted !== null && plan.wanted !== plan.active) append(id, {
						type: "plan/mode",
						data: { active: plan.wanted }
					});
					append(id, {
						type: "user/message",
						surfaceOp: "append",
						data: userMessage(durable, promptSource)
					});
					const selection = modelSelections.get(id) ?? {
						provider: "deepseek",
						model: "deepseek-v4-flash"
					};
					const previousHeader = logOf(id).findLast((event) => event.type === "request/header");
					if (!sameModelSelection(previousHeader?.type === "request/header" ? {
						provider: previousHeader.data.header.config.provider,
						model: previousHeader.data.header.config.model,
						...previousHeader.data.header.config.reasoningEffort === void 0 ? {} : { reasoningEffort: previousHeader.data.header.config.reasoningEffort }
					} : null, selection)) append(id, {
						type: "request/header",
						data: {
							header: { config: selection },
							reason: previousHeader === void 0 ? "initial" : "change"
						}
					});
					if (lastRequestContext(logOf(id))?.model !== selection.model) append(id, {
						type: "request/context",
						data: {
							provider: selection.provider,
							model: selection.model,
							contextWindow: 128e3
						}
					});
					startReply(id, turn, userText === "render markdown" ? MARKDOWN_FIXTURE : userText === "report model" ? (() => {
						const selection = modelSelections.get(id);
						return `当前模型：${selection?.provider ?? "unknown"}/${selection?.model ?? "unknown"}` + (selection?.reasoningEffort === void 0 ? "" : ` · 推理等级：${selection.reasoningEffort}`);
					})() : `回声：${userText}。这是 fixture 的流式回复，用于验证打字机增长与定稿切换。`);
					return sessionOk({ accepted: true });
				},
				attachment: (request) => {
					const stored = attachments.get(String(request.attachmentId));
					if (stored === void 0) return sessionErr({
						code: "attachment-error",
						message: "fixture attachment missing",
						details: { reason: "ATTACHMENT_NOT_FOUND" }
					});
					if (!logReferencesAttachment(logs.get(request.sessionId) ?? [], String(request.attachmentId))) return sessionErr({
						code: "attachment-error",
						message: "fixture attachment is not referenced by this session",
						details: { reason: "ATTACHMENT_NOT_REFERENCED" }
					});
					return sessionOk(stored);
				},
				updateQueue: (request) => sessionErr({
					code: "queue-item-not-found",
					message: "fixture has no pending queue item",
					details: { itemId: request.itemId }
				}),
				cancel: (request) => {
					const replay = replays.get(request.sessionId);
					if (replay !== void 0) {
						clearTimeout(replay.timer);
						replay.finish(true);
					} else setRunning(request.sessionId, false);
					return sessionOk({ accepted: true });
				}
			};
			const controlBaseline = () => {
				const queues = {};
				const jobs = {};
				const projections = {};
				for (const summary of sessions) {
					queues[summary.sessionId] = [];
					jobs[summary.sessionId] = [];
					const log = logs.get(summary.sessionId) ?? [];
					projections[summary.sessionId] = {
						asOfSeq: log.length - 1,
						values: projectionValuesOf(log)
					};
				}
				return {
					type: "baseline",
					value: {
						queues,
						jobs,
						approvals: [],
						questions: [],
						projections
					}
				};
			};
			const approvalInvocation = () => ({
				type: "waterfall",
				event: "approval/request",
				eventId: pendingApprovalEventId,
				agentId: sid("fx-alpha"),
				request: {
					toolName: "dangerous_tool",
					reason: "fixture 常驻审批（可答：批准/拒绝后消失）"
				}
			});
			const questionInvocation = () => ({
				type: "waterfall",
				event: "user-questions/request",
				eventId: pendingQuestionEventId,
				agentId: sid("fx-alpha"),
				request: { questions: fixtureQuestions }
			});
			async function* openControl(signal) {
				signal.throwIfAborted();
				const conn = new FxInbox();
				controlConns.add(conn);
				const breakNow = () => {
					conn.breakNow();
				};
				streamBreakers.add(breakNow);
				try {
					yield controlBaseline();
					yield* conn.drain(signal);
				} finally {
					streamBreakers.delete(breakNow);
					controlConns.delete(conn);
				}
			}
			async function* openWorkspace(signal) {
				signal.throwIfAborted();
				const conn = new FxInbox();
				workspaceConns.add(conn);
				const breakNow = () => {
					conn.breakNow();
				};
				streamBreakers.add(breakNow);
				try {
					yield workspaceBaseline();
					yield* conn.drain(signal);
				} finally {
					streamBreakers.delete(breakNow);
					workspaceConns.delete(conn);
				}
			}
			async function* openRemoteEvents(signal) {
				signal.throwIfAborted();
				const clientId = randomUuid();
				const conn = new FxInbox();
				remoteEventConns.set(clientId, conn);
				const timer = setInterval(() => {
					const gamma = summaryOf(sid("fx-gamma"));
					/* v8 ignore next -- the fixture never removes fx-gamma. */
					if (gamma !== void 0) setRunning(gamma.sessionId, !gamma.running);
				}, 5e3);
				try {
					yield {
						type: "ready",
						clientId,
						host: { home: FIXTURE_HOME }
					};
					if (approvalPending) yield approvalInvocation();
					if (questionPending) yield questionInvocation();
					yield* conn.drain(signal);
				} finally {
					clearInterval(timer);
					remoteEventConns.delete(clientId);
				}
			}
			async function* openFollow(request, signal) {
				signal.throwIfAborted();
				const sessionId = request.address.kind === "session" ? request.address.sessionId : request.address.childSessionId;
				if (summaryOf(sessionId) === void 0) throw new Error(`fixture: no session ${sessionId}`);
				const conn = new FxInbox();
				let conns = followConns.get(sessionId);
				if (conns === void 0) {
					conns = /* @__PURE__ */ new Set();
					followConns.set(sessionId, conns);
				}
				conns.add(conn);
				const breakNow = () => {
					conn.breakNow();
				};
				streamBreakers.add(breakNow);
				const snapshot = [...logOf(sessionId)];
				const cursor = snapshot.at(-1)?.seq ?? -1;
				const summary = summaryOf(sessionId);
				/* v8 ignore next -- existence was checked before the stream registered. */
				if (summary === void 0) throw new Error(`fixture: no session ${sessionId}`);
				const initial = pageOf(snapshot, void 0, request.maxMessages ?? 50);
				let nextSeq = cursor + 1;
				try {
					yield {
						type: "snapshot",
						header: {
							version: 0,
							id: sessionId,
							createdAt: summary.updatedAt,
							...summary.cwd === void 0 ? {} : { cwd: summary.cwd },
							...summary.parentSessionId === void 0 ? {} : { parentSession: summary.parentSessionId },
							...summary.origin === void 0 ? {} : { origin: summary.origin },
							...summary.agentPreset === void 0 ? {} : { agentPreset: summary.agentPreset }
						},
						cursor,
						records: initial.records,
						hasMore: initial.hasMore,
						projections: {
							asOfSeq: cursor,
							values: projectionValuesOf(snapshot)
						}
					};
					for await (const frame of conn.drain(signal)) {
						if (frame.event.seq < nextSeq) continue;
						if (frame.event.seq !== nextSeq) throw new Error(`fixture: session event stream skipped seq ${String(nextSeq)}`);
						nextSeq++;
						yield frame;
					}
				} finally {
					streamBreakers.delete(breakNow);
					conns.delete(conn);
					if (conns.size === 0) followConns.delete(sessionId);
				}
			}
			const answerRemoteEvent = (result) => {
				if (!remoteEventConns.has(result.clientId)) return {
					ok: false,
					error: {
						code: "invocation-unavailable",
						message: "fixture Remote event result identifies no active event stream",
						details: {}
					}
				};
				if (result.eventId === pendingApprovalEventId) {
					if (!approvalPending) return {
						ok: true,
						value: void 0
					};
					approvalPending = false;
				} else if (result.eventId === pendingQuestionEventId) {
					if (!questionPending) return {
						ok: true,
						value: void 0
					};
					questionPending = false;
				} else return {
					ok: true,
					value: void 0
				};
				emitRemoteFrame({
					type: "cancel",
					eventId: result.eventId
				});
				return {
					ok: true,
					value: void 0
				};
			};
			const workspaceApi = {
				create: (request) => {
					const existing = workspaces.find((workspace) => workspace.path === request.path);
					if (existing !== void 0) return sessionOk({
						workspace: workspaceSnapshot(existing),
						created: false
					});
					const now = (/* @__PURE__ */ new Date()).toISOString();
					const created = {
						workspaceId: wid(`fx-ws-${nextWorkspace++}`),
						path: request.path,
						title: request.path.split("/").filter(Boolean).at(-1) ?? request.path,
						sessionIds: [],
						createdAt: now,
						updatedAt: now
					};
					workspaces.unshift(created);
					const workspace = workspaceSnapshot(created);
					emitWorkspace({
						type: "upsert",
						workspace
					});
					return sessionOk({
						workspace,
						created: true
					});
				},
				rename: (request) => {
					const workspace = workspaces.find((candidate) => candidate.workspaceId === request.workspaceId);
					if (workspace === void 0) return sessionErr({
						code: "workspace-not-found",
						message: `no workspace ${request.workspaceId}`,
						details: { workspaceId: request.workspaceId }
					});
					const title = request.title.trim();
					if (title === "") return sessionErr({
						code: "bad-request",
						message: "Workspace rename requires a non-blank title",
						details: {}
					});
					if (title !== workspace.title) {
						if (workspaces.some((candidate) => candidate.workspaceId !== request.workspaceId && candidate.title === title)) return sessionErr({
							code: "workspace-name-conflict",
							message: `workspace name '${title}' is already in use`,
							details: { name: title }
						});
						workspace.title = title;
						workspace.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
						emitWorkspace({
							type: "upsert",
							workspace: workspaceSnapshot(workspace)
						});
					}
					return sessionOk({ workspace: workspaceSnapshot(workspace) });
				},
				delete: (request) => {
					const index = workspaces.findIndex((workspace) => workspace.workspaceId === request.workspaceId);
					if (index === -1) return sessionErr({
						code: "workspace-not-found",
						message: `no workspace ${request.workspaceId}`,
						details: { workspaceId: request.workspaceId }
					});
					workspaces.splice(index, 1);
					emitWorkspace({
						type: "remove",
						workspaceId: request.workspaceId
					});
					return sessionOk({ deleted: true });
				},
				insertBefore: (request) => {
					const source = workspaces.findIndex((workspace) => workspace.workspaceId === request.workspaceId);
					const anchor = request.beforeWorkspaceId === void 0 ? workspaces.length : workspaces.findIndex((workspace) => workspace.workspaceId === request.beforeWorkspaceId);
					const missing = source === -1 ? request.workspaceId : anchor === -1 ? request.beforeWorkspaceId : void 0;
					if (missing !== void 0) return sessionErr({
						code: "workspace-not-found",
						message: `no workspace ${missing}`,
						details: { workspaceId: missing }
					});
					if (request.beforeWorkspaceId !== request.workspaceId) {
						const previousOrder = workspaces.map((workspace) => workspace.workspaceId);
						const [workspace] = workspaces.splice(source, 1);
						/* v8 ignore next -- source was resolved from the same array immediately above. */
						if (workspace === void 0) throw new Error(`fixture lost workspace ${request.workspaceId}`);
						const at = request.beforeWorkspaceId === void 0 ? workspaces.length : workspaces.findIndex((candidate) => candidate.workspaceId === request.beforeWorkspaceId);
						workspaces.splice(at, 0, workspace);
						if (workspaces.some((candidate, index) => candidate.workspaceId !== previousOrder[index])) emitWorkspace({
							type: "order",
							workspaceIds: workspaces.map((candidate) => candidate.workspaceId)
						});
					}
					return sessionOk({ workspaceIds: workspaces.map((candidate) => candidate.workspaceId) });
				},
				insertSessionBefore: (request) => {
					const workspace = workspaces.find((candidate) => candidate.workspaceId === request.workspaceId);
					if (workspace === void 0) return sessionErr({
						code: "workspace-not-found",
						message: `no workspace ${request.workspaceId}`,
						details: { workspaceId: request.workspaceId }
					});
					if (!workspace.sessionIds.includes(request.sessionId) || request.beforeSessionId !== void 0 && !workspace.sessionIds.includes(request.beforeSessionId)) return sessionErr({
						code: "workspace-move-invalid",
						message: `session or anchor is not accounted by workspace ${request.workspaceId}`,
						details: {
							workspaceId: request.workspaceId,
							sessionId: request.sessionId,
							...request.beforeSessionId === void 0 ? {} : { beforeSessionId: request.beforeSessionId }
						}
					});
					const without = workspace.sessionIds.filter((id) => id !== request.sessionId);
					const at = request.beforeSessionId === void 0 ? without.length : without.indexOf(request.beforeSessionId);
					const sessionIds = [
						...without.slice(0, at),
						request.sessionId,
						...without.slice(at)
					];
					if (!sessionIds.every((id, index) => id === workspace.sessionIds[index])) {
						workspace.sessionIds = sessionIds;
						workspace.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
						emitWorkspace({
							type: "upsert",
							workspace: workspaceSnapshot(workspace)
						});
					}
					return sessionOk({ workspace: workspaceSnapshot(workspace) });
				},
				archiveSession: (request) => {
					if (summaryOf(request.sessionId) === void 0) return sessionErr({
						code: "session-not-found",
						message: `no session ${request.sessionId}`,
						details: { sessionId: request.sessionId }
					});
					if (!archivedSessionIds.includes(request.sessionId)) {
						archivedSessionIds.push(request.sessionId);
						emitWorkspace({
							type: "archived",
							archivedSessionIds: [...archivedSessionIds]
						});
					}
					return sessionOk({ archivedSessionIds: [...archivedSessionIds] });
				}
			};
			return { rpc: {
				call(channel, endpoint, payload, signal) {
					if (channel !== "/api") return Promise.reject(/* @__PURE__ */ new Error(`fixture connection RPC channel ${JSON.stringify(channel)} is unavailable`));
					const args = payload.args;
					const sessionId = args.agentId;
					const callSignal = signal ?? new AbortController().signal;
					const request = args.request;
					switch (endpoint) {
						case "commands/list": return Promise.resolve(commandRemotes.list(sessionId));
						case "commands/execute": return Promise.resolve(commandRemotes.execute(sessionId, args.line, args.images ?? []));
						case "fileReferences/list": return Promise.resolve(referenceRemotes.files(sessionId, args.query ?? ""));
						case "sessionReferenceResolver/candidates": return Promise.resolve(referenceRemotes.sessions(sessionId, args.query ?? ""));
						case "directoryPicker/pick": return Promise.resolve(directoryPickerRemotes.pick());
						case "directoryPicker/list": return Promise.resolve(directoryPickerRemotes.list(args.path));
						case "directoryPicker/createDirectory": return Promise.resolve(directoryPickerRemotes.createDirectory(args.path ?? "", args.name ?? ""));
						case "goals/create": return Promise.resolve(goalRemotes.create(sessionId, {
							objective: request?.objective,
							...request?.maxGoalRounds === void 0 ? {} : { maxGoalRounds: request.maxGoalRounds }
						}));
						case "goals/edit": return Promise.resolve(goalRemotes.edit(sessionId, args.ref, request));
						case "goals/pause": return Promise.resolve(goalRemotes.pause(sessionId, args.ref));
						case "goals/resume": return Promise.resolve(goalRemotes.resume(sessionId, args.ref));
						case "goals/complete": return Promise.resolve(goalRemotes.complete(sessionId, args.ref));
						case "goals/clear": return Promise.resolve(goalRemotes.clear(sessionId, args.ref));
						case "agentPresets/list": return Promise.resolve(presetRemotes.list());
						case "agentPresets/select": return Promise.resolve(presetRemotes.select(sessionId, args.agentPreset));
						case "agentPresets/read": return Promise.resolve(presetRemotes.read(args.agentPreset));
						case "agentPresets/copy": return Promise.resolve(presetRemotes.copy(args.from, args.id));
						case "agentPresets/deletePreset": return Promise.resolve(presetRemotes.deletePreset(args.id));
						case "subagents/list": return Promise.resolve({
							ok: true,
							value: {
								entries: [],
								parentAvailable: true
							}
						});
						case "subagents/prompt": return Promise.resolve({
							ok: true,
							value: { messageId: `fixture-message-${request.childSessionId}` }
						});
						case "subagents/interruptByParent": return Promise.resolve({
							ok: true,
							value: { accepted: true }
						});
						case "credentials/describe": return Promise.resolve(credentialRemotes.describe(args.refs ?? []));
						case "credentials/set": return Promise.resolve(credentialRemotes.set(args.ref));
						case "credentials/unset": return Promise.resolve(credentialRemotes.unset(args.ref));
						case "settings/describe": return Promise.resolve(settingsRemotes.describe());
						case "settings/canOpenAgentPresetDirectory": return Promise.resolve({
							ok: true,
							value: true
						});
						case "settings/openSettingsDocument": return Promise.resolve(settingsRemotes.openSettingsDocument());
						case "settings/openAgentPresetDirectory": return Promise.resolve(settingsRemotes.openAgentPresetDirectory(args.agentPreset));
						case "skills/list": {
							const missing = requireRemoteSession(request);
							if (missing !== void 0) return missing;
							return sessionOk({ skills: [{
								name: "fixture-demo",
								description: "fixture 技能样本",
								whenToUse: "仅供 UI 目录渲染验收",
								modelInvocable: true
							}, {
								name: "fixture-user-only",
								description: "fixture 仅用户技能样本",
								modelInvocable: false
							}] });
						}
						case "session/openWorkspacePath": return sessionOk({ opened: true });
						case "session/canOpenWorkspacePath": return Promise.resolve({
							ok: true,
							value: true
						});
						case "session/modelCatalog": return Promise.resolve({
							ok: true,
							value: {
								default: {
									provider: "deepseek-official",
									model: "deepseek-v4-flash"
								},
								routableProviders: [
									"deepseek-official",
									"openai",
									"acme-gateway"
								],
								groups: fixtureModelGroups(),
								failures: []
							}
						});
						case "llm/listProviders": return Promise.resolve({
							ok: true,
							value: [
								{
									id: "deepseek-official",
									name: "DeepSeek"
								},
								{
									id: "openai",
									name: "openai"
								},
								{
									id: "acme-gateway",
									name: "Acme Gateway"
								}
							]
						});
						case "llm/listConfigurableProviders": return Promise.resolve({
							ok: true,
							value: [
								{
									provider: "deepseek-official",
									displayName: "DeepSeek",
									settingsNs: "llm-deepseek",
									settingsPath: []
								},
								{
									provider: "openai",
									displayName: "openai",
									settingsNs: "llm-pi-ai",
									settingsPath: ["providers", "openai"],
									declared: false
								},
								{
									provider: "anthropic",
									displayName: "anthropic",
									settingsNs: "llm-pi-ai",
									settingsPath: ["providers", "anthropic"],
									declared: false
								},
								{
									provider: "acme-gateway",
									displayName: "Acme Gateway",
									settingsNs: "llm-pi-ai",
									settingsPath: ["providers", "acme-gateway"],
									declared: true
								}
							]
						});
						case "llm/discoverModels": return Promise.resolve({
							ok: true,
							value: fixtureModelGroups().flatMap((group) => group.models.map((model) => ({
								id: model.id,
								name: model.name
							})))
						});
						case "settings/update": return Promise.resolve(settingsRemotes.update(args.ns));
						case "settings/replace": return Promise.resolve(settingsRemotes.replace(args.ns));
						case "settings/mutate": return Promise.resolve(settingsRemotes.mutate(args.ns));
						case "session/list": return sessionApi.list(args._request);
						case "session/search": return sessionApi.search(request, callSignal);
						case "session/create": return sessionApi.create(request);
						case "session/selectModel": return sessionApi.selectModel(request);
						case "session/rename": return sessionApi.rename(request);
						case "session/fork": return sessionApi.fork(request);
						case "session/prompt": return sessionApi.prompt(request);
						case "session/attachment": return sessionApi.attachment(request);
						case "session/updateQueue": return sessionApi.updateQueue(request);
						case "session/cancel": return sessionApi.cancel(request);
						case "session/page": {
							const page = request;
							const pageSessionId = page.address.kind === "session" ? page.address.sessionId : page.address.childSessionId;
							return sessionApi.history({
								sessionId: pageSessionId,
								throughSeq: page.throughSeq,
								...page.beforeSeq === void 0 ? {} : { beforeSeq: page.beforeSeq },
								...page.maxMessages === void 0 ? {} : { maxMessages: page.maxMessages }
							});
						}
						case "$events/result": return Promise.resolve(answerRemoteEvent(args));
						case "workspace/create": return workspaceApi.create(request);
						case "workspace/rename": return workspaceApi.rename(request);
						case "workspace/delete": return workspaceApi.delete(request);
						case "workspace/insertBefore": return workspaceApi.insertBefore(request);
						case "workspace/insertSessionBefore": return workspaceApi.insertSessionBefore(request);
						case "workspace/archiveSession": return workspaceApi.archiveSession(request);
						default: return Promise.reject(/* @__PURE__ */ new Error(`fixture connection RPC endpoint ${JSON.stringify(endpoint)} is unavailable`));
					}
				},
				open(channel, endpoint, payload, signal) {
					if (channel !== "/api") throw new Error(`fixture connection RPC channel ${JSON.stringify(channel)} is unavailable`);
					const args = payload.args;
					switch (endpoint) {
						case "$events": return openRemoteEvents(signal);
						case "session/control": return openControl(signal);
						case "session/follow": return openFollow(args.request, signal);
						case "workspace/follow": return openWorkspace(signal);
						default: throw new Error(`fixture connection stream endpoint ${JSON.stringify(endpoint)} is unavailable`);
					}
				}
			} };
		}
		/**
		* Build the browser fixture transport from the current page's query switches.
		* @returns an in-memory Connection RPC transport.
		*/
		function createFixtureConnectionRpc() {
			return createFixtureWorld(fixtureOptionsFromLocation()).rpc;
		}
		/** Browser query mapping; direct unit callers pass FixtureOptions explicitly. */
		function fixtureOptionsFromLocation() {
			if (typeof location === "undefined") return {};
			const query = new URLSearchParams(location.search);
			return {
				empty: query.get("fixture") === "empty",
				rejectPrompt: query.get("fixturePrompt") === "reject",
				failWorkspaceAttach: query.get("fixtureAttach") === "fail",
				dropSessionCreateResponse: query.get("fixtureSessionCreate") === "drop-response",
				createFrameOrder: query.get("fixtureFrames") === "workspace-first" ? "workspace-first" : "session-first"
			};
		}
		//#endregion
		//#region lib/types/rpc.js
		/** Generic unary RPC contracts shared by the Host and Client Connection halves. */
		/**
		* Brand one validated string as a Connection correlation id.
		* @param id - validated wire identity.
		* @returns the same string with the correlation-id brand.
		*/
		function RpcId(id) {
			return id;
		}
		/**
		* Convert a rejected transport operation into a generic failure result.
		* @param error - rejected transport value.
		* @returns an `internal` failure preserving the available message.
		*/
		function transportError(error) {
			return {
				ok: false,
				error: {
					code: "internal",
					message: error instanceof Error ? error.message : String(error),
					details: {}
				}
			};
		}
		//#endregion
		//#region lib/types/client/rpc.js
		/** Browser caller for generic Connection unary RPC channels. */
		const INTERNAL_BASE = "http://dsh.internal";
		const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/;
		const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
		/**
		* Create the browser-backed generic RPC caller.
		* @param doFetch - transport override; defaults to the page's global fetch.
		* @param openStream - optional worker-local Gateway stream carrier.
		* @returns caller that owns request correlation and response-envelope validation.
		*/
		function createWebConnectionRpc(doFetch, openStream) {
			const send = doFetch ?? ((input, init) => globalThis.fetch(input, init));
			return {
				async call(channel, endpoint, payload, signal) {
					assertTarget(channel, endpoint);
					const rpcId = RpcId(randomUuid());
					const message = {
						type: "client-request",
						rpcId,
						method: endpoint,
						payload
					};
					const response = await send(new URL(`${channel}/${endpoint}`, resolveBase()), {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(message),
						...signal === void 0 ? {} : { signal }
					});
					if (!response.ok) throw new Error(`transport failure for ${channel}/${endpoint}: HTTP ${response.status}`);
					const full = parseConnectionResponse(await response.json());
					if (full.rpcId !== rpcId) throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`);
					return full.result;
				},
				...openStream === void 0 ? {} : { open(channel, endpoint, payload, signal) {
					assertTarget(channel, endpoint);
					if (channel !== "/api") throw new Error(`connection: worker-local streams require the /api channel, got ${JSON.stringify(channel)}`);
					return openStream(endpoint, payload, signal);
				} }
			};
		}
		function parseConnectionResponse(value) {
			if (!isRecord(value) || value.type !== "server-response" || typeof value.rpcId !== "string") throw new TypeError("connection: invalid server-response envelope");
			const result = value.result;
			if (!isRecord(result)) throw new TypeError("connection: invalid server-response result");
			if (result.ok === true) return {
				rpcId: RpcId(value.rpcId),
				result: {
					ok: true,
					value: result.value
				}
			};
			if (result.ok !== false || !isRecord(result.error)) throw new TypeError("connection: invalid server-response result");
			const error = result.error;
			if (typeof error.code !== "string" || typeof error.message !== "string" || !isRecord(error.details)) throw new TypeError("connection: invalid server-response failure");
			return {
				rpcId: RpcId(value.rpcId),
				result: {
					ok: false,
					error: {
						code: error.code,
						message: error.message,
						details: error.details
					}
				}
			};
		}
		function isRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		function resolveBase() {
			const location = globalThis.location;
			return location?.origin !== void 0 && location.origin !== "null" ? location.origin : INTERNAL_BASE;
		}
		function assertTarget(channel, endpoint) {
			const segments = endpoint.split("/");
			if (!CHANNEL_PATTERN.test(channel) || segments.some((segment) => segment === "" || segment === "." || segment === ".." || !ENDPOINT_SEGMENT_PATTERN.test(segment))) throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`);
		}
		//#endregion
		//#region lib/types/loopback-hostname.js
		/**
		* Browser-safe, zero-dependency loopback classification shared by the `/api`
		* Host fence and the package's `ctx.connection` state. The predicate stays
		* package-internal; client plugins consume the derived state through Cordis.
		*/
		/**
		* Whether a normalized URL hostname names the local loopback authority.
		* @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
		* @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
		*/
		function isLoopbackHostname(hostname) {
			if (hostname === "localhost" || hostname === "[::1]") return true;
			const parts = hostname.split(".");
			return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
		}
		//#endregion
		//#region lib/types/client/index.js
		/** Required services (none — this is the wire root). */
		const inject = [];
		/**
		* Client plugin body: pick the api by page mode and provide ctx.connection.
		* @param ctx - client cordis context.
		*/
		function apply(ctx) {
			const pageLocation = typeof location === "undefined" ? void 0 : location;
			const fixtureRpc = pageLocation !== void 0 && new URLSearchParams(pageLocation.search).has("fixture") ? createFixtureConnectionRpc() : void 0;
			const transport = globalThis.__DSH_TRANSPORT__;
			const rpc = fixtureRpc ?? createWebConnectionRpc(transport?.fetch, transport?.openStream);
			let generationSource;
			let owner;
			let generationId = 0;
			let generation;
			const generationListeners = /* @__PURE__ */ new Set();
			const publishGeneration = (next) => {
				if (Object.is(generation, next)) return;
				generation = next;
				for (const listener of [...generationListeners]) try {
					listener();
				} catch (error) {
					console.error("[connection] generation listener threw:", error);
				}
			};
			const releaseOwner = (current) => {
				if (owner !== current) return;
				owner = void 0;
				current.controller.stop();
				publishGeneration(void 0);
			};
			const handle = {
				isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),
				generation: {
					getSnapshot: () => generation,
					subscribe: (listener) => {
						generationListeners.add(listener);
						return () => {
							generationListeners.delete(listener);
						};
					}
				},
				rpc,
				registerGenerationSource(source) {
					if (generationSource !== void 0) throw new Error("connection: a generation source is already registered");
					generationSource = source;
					return () => {
						if (generationSource !== source) return;
						generationSource = void 0;
						const current = owner;
						if (current?.source === source) releaseOwner(current);
					};
				},
				start(sinks, config) {
					if (owner !== void 0) throw new Error("connection: the stream loop is already owned by another consumer");
					const source = generationSource;
					if (source === void 0) throw new Error("connection: no generation source is registered");
					const token = {};
					const ownsGeneration = () => owner?.token === token;
					const controller = new ConnectionController(source, {
						...sinks,
						onConnected: (host) => {
							const nextGeneration = {
								id: ++generationId,
								host
							};
							publishGeneration(nextGeneration);
							if (!ownsGeneration() || !Object.is(generation, nextGeneration)) return;
							sinks.onConnected?.(host);
						},
						onStateChange: (state) => {
							if (state === "reconnecting") publishGeneration(void 0);
							if (!ownsGeneration()) return;
							sinks.onStateChange?.(state);
						}
					}, config ?? {});
					const current = {
						token,
						source,
						controller
					};
					owner = current;
					controller.start();
					return { stop: () => {
						releaseOwner(current);
					} };
				}
			};
			ctx.provide("connection", handle);
		}
		//#endregion
		exports.RpcId = RpcId;
		exports.apply = apply;
		exports.inject = inject;
		exports.transportError = transportError;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map