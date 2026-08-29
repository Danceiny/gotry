window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-api-session-controller",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_api_gateway_client = require("@deepseek-ai/dsh-api-gateway/client");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let _deepseek_ai_cordis = require("@deepseek-ai/cordis");
		//#region lib/types/client/sessions/history-records.js
		/** Client range access and type narrowing for aligned Session history records. */
		/**
		* Narrow aligned wire records to their Client event types without allocation.
		* @param records - validated history transport records.
		* @returns the same record array with typed inner events.
		*/
		function historyEntries(records) {
			return records;
		}
		/**
		* Read the first logical sequence represented by one wire record.
		* @param record - validated scalar event or packed Assistant delta run.
		* @returns inclusive first Session sequence.
		*/
		function historyRecordFirstSeq(record) {
			return record.event.seq;
		}
		/**
		* Read the final logical sequence represented by one wire record.
		* @param record - validated scalar event or packed Assistant delta run.
		* @returns inclusive final Session sequence.
		*/
		function historyRecordLastSeq(record) {
			if (record.type === "event") return record.event.seq;
			const length = record.event.type === "chunkrow/tool-call-chunks" ? record.event.data.args.length : record.event.data.texts.length;
			return record.event.seq + length - 1;
		}
		//#endregion
		//#region lib/types/types.js
		/** Browser-safe request, result, and lifecycle vocabulary for the Session Remote service. */
		/** Maximum number of Sessions returned by one search. */
		const SESSION_SEARCH_RESULT_LIMIT = 20;
		/** Maximum search snippet length in Unicode code points. */
		const SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240;
		//#endregion
		//#region lib/types/client/transport.js
		/** Session-specific adapters for Gateway-owned Remote stream lifecycles. */
		function toSessionJournalChange(change) {
			switch (change.type) {
				case "replace":
				case "prepend": return {
					...change,
					entries: historyEntries(change.entries)
				};
				case "append":
					if (change.entry.type !== "event") throw new Error("session live stream emitted a packed history record");
					return {
						type: "append",
						entry: change.entry
					};
			}
		}
		/**
		* Create the Host-wide Session control snapshot stream.
		* @param remote - generated Session namespace and Gateway stream factory.
		* @param options - Session state destinations.
		* @returns an unstarted stream owned by the Client Session runtime.
		*/
		function createSessionControlStream(remote, options) {
			return new _deepseek_ai_dsh_api_gateway_client.RemoteSnapshotStream(remote.$stream({
				name: "session control stream",
				open: (signal) => remote.session.control(signal),
				ended: (accepted) => accepted ? new _deepseek_ai_dsh_api_gateway_client.RemoteStreamCarrierError("session control stream ended without a terminal result") : /* @__PURE__ */ new Error("session control stream ended before its opening snapshot"),
				...options.carrierFailed === void 0 ? {} : { carrierFailed: options.carrierFailed }
			}), {
				name: "session control stream",
				isSnapshot: (frame) => frame.type === "baseline",
				replace: options.accept,
				update: options.accept,
				failed: options.failed
			});
		}
		/** Gateway-owned event journal bound to one ordinary or direct-subagent Session address. */
		var SessionEventStream = class extends _deepseek_ai_dsh_api_gateway_client.RemoteJournalStream {
			remote;
			address;
			/**
			* @param remote - generated Session namespace and Gateway stream factory.
			* @param address - durable ordinary-Session or direct-subagent address.
			* @param options - Session event-window destinations.
			*/
			constructor(remote, address, options) {
				super(remote, {
					name: "session event stream",
					emptyCursor: -1,
					entries: (page) => page.records,
					hasMore: (page) => page.hasMore,
					first: historyRecordFirstSeq,
					last: historyRecordLastSeq,
					compare: (left, right) => left - right,
					follows: (left, right) => right === left + 1,
					publish: (change) => {
						options.publish(toSessionJournalChange(change));
					},
					...options.carrierFailed === void 0 ? {} : { carrierFailed: options.carrierFailed },
					failed: options.failed
				});
				this.remote = remote;
				this.address = address;
			}
			/** @inheritdoc */
			async *follow(request, signal) {
				for await (const frame of this.remote.session.follow({
					address: this.address,
					...request.maxMessages === void 0 ? {} : { maxMessages: request.maxMessages }
				}, signal)) {
					if (frame.type === "snapshot") {
						yield {
							type: "opened",
							cursor: frame.cursor,
							page: {
								records: frame.records,
								hasMore: frame.hasMore,
								projections: frame.projections
							}
						};
						continue;
					}
					yield {
						type: "entry",
						entry: frame
					};
				}
			}
			/** @inheritdoc */
			async readPage(request, throughSeq, signal) {
				const result = await this.remote.session.page({
					address: this.address,
					throughSeq,
					...request
				}, signal);
				if (!result.ok) throw new _deepseek_ai_dsh_api_gateway_client.RemoteStreamError(result.error.code, result.error.message, result.error.details);
				return result.value;
			}
			/** @inheritdoc */
			repairRequest(request) {
				return request.maxMessages === void 0 ? {} : { maxMessages: request.maxMessages };
			}
		};
		/**
		* Recover a Host Session failure from a Remote stream terminal error.
		* @param error - value thrown while opening or consuming a Session stream.
		* @returns the Host failure, or `undefined` for carrier and local failures.
		*/
		function sessionStreamFailure(error) {
			if (!(error instanceof _deepseek_ai_dsh_api_gateway_client.RemoteStreamError)) return void 0;
			return {
				code: error.code,
				message: error.message,
				details: error.details
			};
		}
		//#endregion
		//#region ../../util/workspace-path/lib/index.js
		/**
		* Read the final non-empty segment of a Workspace path for display.
		* Workspace-label surfaces use this helper instead of deriving another basename.
		* @param path - Workspace directory path using POSIX or Windows separators.
		* @returns the final segment, or an empty string for a separator-only path.
		*/
		function workspaceTitleOf(path) {
			const trimmed = path.replace(/[/\\]+$/, "");
			const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
			return trimmed.slice(separator + 1);
		}
		//#endregion
		//#region lib/types/client/scope.js
		/**
		* Client Agent-scope primitive: mint a Cordis context tagged with the owning
		* Agent's identity. The mechanism mirrors the host `dsh-scope` architecture
		* (no-op plugin fiber + context tag + `Context.filter` routing predicate);
		* the shape deliberately diverges: the filter lives on the actx itself
		* instead of a separate carrier object, so scoped dispatch is plain cordis —
		* `actx.bail(actx, event, payload)` / `actx.emit(actx, ...)` — with no
		* wrapper. The host needs a detached carrier because its dispatch subject is
		* the business Agent object; client scope events carry only ids, so the
		* actx is the natural subject. The second divergence stands: the scope key
		* is the branded `SessionId` (value compared), not an object identity — the
		* agent and its session share one id (1:1, same axis; no separate AgentId
		* brand), and a client scope's identity IS that wire id. Third divergence,
		* deliberate: the client scopes the Agent IDENTITY, not a live Agent object
		* — a cold session's host Agent is already disposed while its client actx
		* stays alive for history viewing.
		*/
		/** Context tag written by {@link createScope}. */
		const kScope = Symbol("dsh.client.scope");
		/** Shared no-op plugin backing each Agent scope fiber. */
		function agentScope() {}
		/**
		* Mint an Agent scope under `ctx`: a no-op plugin fiber whose context
		* carries the agent tag and the dispatch filter — untagged listeners are
		* admitted globally, tagged listeners only for a matching agent.
		* Registrations through the returned ctx dispose with the fiber.
		* @param ctx - client root context the scope fiber mounts under.
		* @param key - owning agent identity (the routing tag; agent id === session id).
		* @returns the tagged context and its backing fiber.
		*/
		function createScope(ctx, key) {
			const fiber = ctx.plugin(agentScope);
			return {
				fiber,
				ctx: fiber.ctx.extend({
					[kScope]: key,
					[_deepseek_ai_cordis.Context.filter](listenerCtx) {
						const tag = scopeOf(listenerCtx);
						return tag === void 0 || tag === key;
					}
				})
			};
		}
		/**
		* Read the nearest agent tag inherited by a context.
		* @param ctx - any client context.
		* @returns its agent identity (the session id), or undefined for root contexts.
		*/
		function scopeOf(ctx) {
			return ctx[kScope];
		}
		//#endregion
		//#region lib/types/client/ordered-baseline.js
		/**
		* Merge an authoritative baseline without moving identities already visible to
		* the client. Baseline-only identities are inserted relative to the nearest
		* following known identity; identities absent from the baseline are removed.
		*
		* @param current - the established client order.
		* @param baseline - the latest authoritative rows.
		* @param keyOf - stable identity selector.
		* @returns baseline-valued rows with the established relative order retained.
		*/
		function mergeOrderedBaseline(current, baseline, keyOf) {
			const baselineByKey = /* @__PURE__ */ new Map();
			for (const value of baseline) baselineByKey.set(keyOf(value), value);
			const merged = current.map((value) => baselineByKey.get(keyOf(value))).filter((value) => value !== void 0);
			const mergedKeys = new Set(merged.map(keyOf));
			for (let index = 0; index < baseline.length; index++) {
				const value = baseline[index];
				/* v8 ignore next -- dense-array guard: index is bounded by baseline.length. */
				if (value === void 0 || mergedKeys.has(keyOf(value))) continue;
				let insertion = merged.length;
				for (let following = index + 1; following < baseline.length; following++) {
					const candidate = baseline[following];
					/* v8 ignore next -- dense-array guard: following is bounded by baseline.length. */
					if (candidate === void 0) continue;
					const known = merged.findIndex((item) => keyOf(item) === keyOf(candidate));
					if (known !== -1) {
						insertion = known;
						break;
					}
				}
				merged.splice(insertion, 0, value);
				mergedKeys.add(keyOf(value));
			}
			return merged;
		}
		//#endregion
		//#region lib/types/client/contract/result.js
		/** Client operation results spanning the Session and subagent Remote calls. */
		/**
		* Fold a rejected carrier operation into the Client Session failure vocabulary.
		* @param error - rejection from a Remote or local carrier call.
		* @returns the failure branch of a Client Session result.
		*/
		function transportResult(error) {
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
		//#region lib/types/client/sessions/lineage.js
		/**
		* Summaries -> flat list with lineage indentation. Root and sibling order
		* follows the established input order; this projection never re-sorts a
		* hydrated list from mutable timestamps.
		* @param summaries - the host's session.list items.
		* @param completed - sessions with a pending completion reminder (manager-owned live fact; absent = false).
		* @returns display rows in render order.
		*/
		function flattenLineage(summaries, completed) {
			const byId = /* @__PURE__ */ new Map();
			for (const s of summaries) byId.set(s.sessionId, s);
			const children = /* @__PURE__ */ new Map();
			const roots = [];
			for (const s of summaries) if (s.parentSessionId !== void 0 && byId.has(s.parentSessionId)) {
				const list = children.get(s.parentSessionId) ?? [];
				list.push(s);
				children.set(s.parentSessionId, list);
			} else roots.push(s);
			const out = [];
			const visited = /* @__PURE__ */ new Set();
			const walk = (s, depth) => {
				if (visited.has(s.sessionId)) {
					console.warn(`[session-controller] lineage cycle at ${s.sessionId}; emitting as root`);
					return;
				}
				visited.add(s.sessionId);
				out.push({
					...s,
					completed: completed?.has(s.sessionId) ?? false,
					depth
				});
				const kids = children.get(s.sessionId);
				if (kids === void 0) return;
				for (const kid of kids) walk(kid, depth + 1);
			};
			for (const root of roots) walk(root, 0);
			for (const s of summaries) if (!visited.has(s.sessionId)) walk(s, 0);
			return out;
		}
		//#endregion
		//#region lib/types/client/sessions/notifier.js
		/**
		* Batches structural updates in microtasks and stream updates by animation
		* frame. Reads may rebuild a dirty snapshot without consuming the pending
		* subscriber notification.
		*/
		var Notifier = class {
			rebuild;
			listeners = /* @__PURE__ */ new Set();
			dirty = false;
			notifyPending = false;
			scheduled = "none";
			scheduleGeneration = 0;
			/** @param rebuild - snapshot rebuild function injected by the owner (writes the owner's snapshotCache). */
			constructor(rebuild) {
				this.rebuild = rebuild;
			}
			/**
			* uSES subscription entry.
			* @param listener - change callback.
			* @returns the unsubscribe function.
			*/
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			/** Mark the snapshot dirty and notify in a microtask. */
			markDirty() {
				this.dirty = true;
				this.notifyPending = true;
				if (this.scheduled === "microtask") return;
				this.schedule("microtask");
			}
			/** Mark the snapshot dirty and publish cumulative state at most once per frame. */
			markFrameDirty() {
				this.dirty = true;
				this.notifyPending = true;
				if (this.scheduled !== "none") return;
				this.schedule(typeof globalThis.requestAnimationFrame === "function" ? "frame" : "microtask");
			}
			/**
			* Synchronous flush: controlled-input writes must notify in the same tick as
			* onChange, or React rolls the DOM back to the stale value and the caret jumps to the end.
			*/
			notifyNow() {
				this.dirty = true;
				this.notifyPending = true;
				this.invalidateSchedule();
				this.flush();
			}
			/**
			* Pre-getSnapshot check: rebuild synchronously when dirty (read path
			* before first subscribe / while unobserved). Notification stays pending.
			*/
			ensureFresh() {
				if (!this.dirty) return;
				this.dirty = false;
				this.rebuild();
			}
			schedule(kind) {
				const generation = ++this.scheduleGeneration;
				this.scheduled = kind;
				const publish = () => {
					if (generation !== this.scheduleGeneration) return;
					this.scheduled = "none";
					this.flush();
				};
				if (kind === "frame") globalThis.requestAnimationFrame(publish);
				else queueMicrotask(publish);
			}
			invalidateSchedule() {
				this.scheduleGeneration++;
				this.scheduled = "none";
			}
			flush() {
				if (!this.notifyPending) return;
				if (this.listeners.size === 0) return;
				this.notifyPending = false;
				if (this.dirty) {
					this.dirty = false;
					this.rebuild();
				}
				(0, _deepseek_ai_dsh_client_store.notifySubscribers)(this.listeners, "[session-controller]");
			}
		};
		//#endregion
		//#region lib/types/client/sessions/projection-store.js
		/**
		* One session's projection values. Framework semantics, uniform across every
		* key: a baseline seeds rows at its cut, a push frame updates one row, and in
		* both paths a lower-or-equal seq loses — a replayed frame cannot regress a
		* value, a stale baseline cannot overwrite a newer frame. A key the store has
		* never seen reads `undefined` (capability absent). Faces are identity-stable
		* per key (create-on-demand, cached) so the React side binds each exactly
		* once; the store-level channel (`subscribeAny`) serves coarse consumers (the
		* manager's list projection reads the `title` key).
		*/
		var ProjectionValueStore = class {
			rows = /* @__PURE__ */ new Map();
			channels = /* @__PURE__ */ new Map();
			valuesCache;
			/** Coarse any-key channel (no snapshot cache to rebuild: reads hit rows directly). */
			anyNotifier = new Notifier(() => {});
			/**
			* Key-addressed bare observable face (the useProjection resolution path).
			* Always defined — absence is an `undefined` snapshot, never a missing
			* face, so a component may subscribe before the key ever carries a value.
			* @param key - projection key.
			* @returns the identity-stable face for this key.
			*/
			faceOf(key) {
				return this.channel(key).face;
			}
			/**
			* Current whole value for a key (erased framework read; typed reads go
			* through `useProjection`'s map lookup).
			* @param key - projection key.
			* @returns the value, or undefined while the key is absent.
			*/
			get(key) {
				return this.rows.get(key)?.value;
			}
			/**
			* Read every current projection value as one reference-stable snapshot.
			* @returns The same frozen value map until a row changes.
			*/
			values() {
				if (this.valuesCache === void 0) this.valuesCache = Object.freeze(Object.fromEntries([...this.rows].map(([key, row]) => [key, row.value])));
				return this.valuesCache;
			}
			/**
			* Subscribe to any-key changes (microtask-batched) — the manager's list
			* rebuild channel.
			* @param listener - change callback.
			* @returns the unsubscribe function.
			*/
			subscribeAny(listener) {
				return this.anyNotifier.subscribe(listener);
			}
			/**
			* Apply one finished value from the Session control stream.
			* @param key - projection key.
			* @param value - whole value computed by the host unit.
			* @param seq - the unit's watermark at emission.
			*/
			apply(key, value, seq) {
				const row = this.rows.get(key);
				if (row !== void 0 && seq <= row.seq) return;
				this.rows.set(key, {
					value,
					seq
				});
				this.changed(key);
			}
			/**
			* Seed from a history tail page's projections block: every carried key
			* lands under the same seq rule as frames; a key the block omits is
			* capability-absent as of the cut — its row clears unless a newer frame
			* already superseded the cut (a stale baseline can neither overwrite nor
			* clear newer values).
			* @param baseline - the response's projections block.
			*/
			seed(baseline) {
				const values = baseline.values;
				for (const key of Object.keys(values)) this.apply(key, values[key], baseline.asOfSeq);
				for (const [key, row] of this.rows) {
					if (Object.hasOwn(values, key)) continue;
					if (row.seq > baseline.asOfSeq) continue;
					this.rows.delete(key);
					this.changed(key);
				}
			}
			/**
			* Drop rows beyond a replacement control baseline. Such rows describe
			* process state the Host lost before persisting it and would otherwise
			* outrank recomputed lower-seq values forever. The caller seeds the new
			* baseline immediately afterward.
			* @param lastSeq - highest durable sequence reflected by the baseline.
			*/
			truncate(lastSeq) {
				for (const [key, row] of this.rows) {
					if (row.seq <= lastSeq) continue;
					this.rows.delete(key);
					this.changed(key);
				}
			}
			changed(key) {
				this.valuesCache = void 0;
				this.channels.get(key)?.notifier.markDirty();
				this.anyNotifier.markDirty();
			}
			channel(key) {
				let channel = this.channels.get(key);
				if (channel === void 0) {
					const notifier = new Notifier(() => {});
					channel = {
						notifier,
						face: {
							getSnapshot: () => this.rows.get(key)?.value,
							subscribe: (listener) => notifier.subscribe(listener)
						}
					};
					this.channels.set(key, channel);
				}
				return channel;
			}
		};
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
		//#region lib/types/client/contract/events.js
		/** Observable contiguous Session event window consumed by domain assemblers. */
		function leaf(entries) {
			return {
				kind: "leaf",
				entries,
				length: entries.length
			};
		}
		function concat(left, right) {
			return {
				kind: "concat",
				left,
				right,
				length: left.length + right.length
			};
		}
		function materialize(node) {
			if (node.kind === "leaf") return node.entries;
			const entries = new Array(node.length);
			const pending = [node];
			let index = 0;
			while (pending.length > 0) {
				const current = pending.pop();
				if (current.kind === "concat") {
					pending.push(current.right, current.left);
					continue;
				}
				for (const entry of current.entries) {
					entries[index] = entry;
					index += 1;
				}
			}
			return entries;
		}
		function windowSnapshot(node, hasMore, revision, change) {
			let entries;
			return {
				get entries() {
					entries ??= materialize(node);
					return entries;
				},
				hasMore,
				revision,
				change
			};
		}
		/** Session-owned event feed; every accepted window mutation publishes synchronously. */
		var MutableSessionEventSource = class {
			listeners = /* @__PURE__ */ new Set();
			window = leaf([]);
			snapshot = windowSnapshot(this.window, false, 0, {
				kind: "replace",
				entries: []
			});
			/** @returns the cached event-window snapshot. */
			getSnapshot() {
				return this.snapshot;
			}
			/**
			* Subscribe to synchronous window publication.
			* @param listener - invalidation callback.
			* @returns unsubscribe function.
			*/
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			/**
			* Replace the complete contiguous window.
			* @param entries - complete window.
			* @param hasMore - whether older history remains.
			*/
			replace(entries, hasMore) {
				this.window = leaf(entries);
				this.publish(hasMore, {
					kind: "replace",
					entries
				});
			}
			/**
			* Prepend one older contiguous page.
			* @param entries - newly loaded older entries.
			* @param hasMore - whether still older history remains.
			*/
			prepend(entries, hasMore) {
				this.window = concat(leaf(entries), this.window);
				this.publish(hasMore, {
					kind: "prepend",
					entries
				});
			}
			/**
			* Append one contiguous live entry.
			* @param entry - live tail entry.
			*/
			append(entry) {
				const entries = [entry];
				this.window = concat(this.window, leaf(entries));
				this.publish(this.snapshot.hasMore, {
					kind: "append",
					entries
				});
			}
			publish(hasMore, change) {
				this.snapshot = windowSnapshot(this.window, hasMore, this.snapshot.revision + 1, change);
				(0, _deepseek_ai_dsh_client_store.notifySubscribers)(this.listeners, "[session-controller] event feed");
			}
		};
		//#endregion
		//#region lib/types/client/time-zone.js
		/** Browser-owned time-zone sampling for prompt RPC provenance. */
		/**
		* Resolve the current browser IANA zone for one outbound operation.
		* @returns The browser-provided canonical zone.
		* @throws when the runtime cannot provide a non-empty zone.
		*/
		function resolvedClientTimeZone() {
			const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
			if (typeof timeZone !== "string" || timeZone.length === 0) throw new Error("browser time zone is unavailable");
			return timeZone;
		}
		//#endregion
		//#region lib/types/client/sessions/queue-mirror.js
		const QUEUE_PREVIEW_CHARS = 200;
		function previewOf(content) {
			const flat = content.map((block) => block.type === "text" ? block.text : `[${block.type}]`).join(" ").replace(/\s+/g, " ").trim();
			const chars = Array.from(flat);
			return chars.length > QUEUE_PREVIEW_CHARS ? `${chars.slice(0, QUEUE_PREVIEW_CHARS).join("")}…` : flat;
		}
		function textOf(content) {
			if (!content.every((block) => block.type === "text")) return null;
			return content.map((block) => block.text).join("");
		}
		/** Authoritative transient queue projection and durable steering handoff. */
		var SessionQueueMirror = class {
			current = [];
			/**
			* Return the current immutable queue projection.
			* @returns current queue rows.
			*/
			snapshot() {
				return this.current;
			}
			/**
			* Replace from one authoritative stream queue frame.
			* @param items - complete host queue snapshot.
			*/
			replace(items) {
				this.current = items.map((item) => {
					const content = item.message.content;
					return {
						id: item.id,
						messageId: item.message.id,
						placement: item.placement,
						...item.rpcId === void 0 ? {} : { rpcId: item.rpcId },
						content,
						preview: previewOf(content),
						text: textOf(content)
					};
				});
			}
			/**
			* Retire a transient steering row once its durable message enters the log.
			* @param event - newly contiguous durable Session event.
			* @returns whether the projection changed.
			*/
			acceptDurable(event) {
				if (event.type !== "user/message") return false;
				const messageId = event.data.id;
				const index = this.current.findIndex((item) => item.placement === "steering" && item.messageId === messageId);
				if (index < 0) return false;
				this.current = this.current.filter((_item, candidate) => candidate !== index);
				return true;
			}
		};
		/**
		* Owns a session's event window, lifecycle state, and observable
		* snapshot. React bindings remain outside this data layer. Features see only
		* the {@link SessionFace} slice (ISession verbs + the snapshot source); the
		* remaining public members are Session Controller internals.
		*/
		var Session = class {
			sessionId;
			remote;
			options;
			baseSeq = 0;
			hasMore = false;
			openState = "cold";
			openError = null;
			openPromise = null;
			/** Bumped by stream replacement to invalidate an in-flight doOpen. Stale
			*  passes drop all writes once the generation moves on. */
			openGeneration = 0;
			loadingOlder = false;
			/** Authoritative stream-only inbox snapshot; pending work never hits history. */
			queueMirror = new SessionQueueMirror();
			running = false;
			address;
			parentAvailable;
			/**
			* Sticky send marker, private input of the composerPhase derivation: set
			* synchronously before prompt()'s first await, never reset — the blank →
			* engaging edge of the phase machine (see ComposerPhase).
			*/
			promptAttempted = false;
			/** A first accepted prompt stays in the engaging phase until its turn is observable. */
			firstPromptPendingTurn = false;
			/** Empty-log mirror (see ConversationSnapshot.blank); unknown bare sessions begin conservatively blank. */
			blankBit = true;
			removed = false;
			promptError = null;
			lastAgentError = null;
			/** Local submission echoes, insertion-ordered (see SessionSnapshot.pendingSubmissions). */
			pendingSubmissions = [];
			/** Per-echo settlement state; `retiring` latches the first observation so a
			*  queue frame and its durable event cannot both retire one echo. */
			submissionSettlements = /* @__PURE__ */ new Map();
			/** Owns the addressed page/follow lifecycle while this Session is open. */
			events;
			/**
			* Per-session projection value store (push model; see the session-projection
			* subsystem page, docs/subsystems/session-projection.md): finished whole
			* values computed on the Host, seeded by the tail page's
			* projections block and updated by Session Controller control frames under the
			* one higher-seq-wins rule. Keys are read via `projections.faceOf(key)`
			* (the useProjection resolution face); the conversation snapshot never
			* carries projection values, and no client-side domain folding exists.
			* Manager-owned when constructed through SessionManager (frames route and
			* the store outlives instantiation, the title-snapshot precedent); a bare
			* construction gets a private store.
			*/
			projections;
			/** Contiguous history and live tail consumed by Conversation assembly. */
			eventSource = new MutableSessionEventSource();
			snapshotCache;
			notifier;
			/**
			* Agent-scoped cordis context, bound once by ClientSessions when it
			* mints the scope (the client mirror of the host Agent's loopCtx). The
			* Session dispatches its own scoped events through it; undefined means
			* unbound (bare object-layer construction) or already pruned — both skip
			* dispatch-dependent behavior rather than fail.
			*/
			actx;
			/**
			* @param sessionId - Host session identity (client sessions are always Host-born).
			* @param remote - generated Remote namespaces this session calls.
			* @param options - optional manager-owned state observers.
			*/
			constructor(sessionId, remote, options = {}) {
				this.sessionId = sessionId;
				this.remote = remote;
				this.options = options;
				this.projections = options.projections ?? new ProjectionValueStore();
				this.address = options.address;
				this.parentAvailable = options.parentAvailable;
				this.notifier = new Notifier(() => {
					this.snapshotCache = this.buildSnapshot();
				});
				this.snapshotCache = this.buildSnapshot();
			}
			/**
			* Bind the Agent-scoped context minted by ClientSessions (single write;
			* a second bind is a wiring error and throws). Direction stays one-way at
			* this binding boundary: consumers still reach the Session via `sessions.sessionOf`,
			* while the Session holds its own dispatch point (host Agent.loopCtx
			* mirror).
			* @param actx - the agent's scoped context.
			*/
			bindScope(actx) {
				if (this.actx !== void 0) throw new Error(`session ${this.sessionId} already has a bound scope`);
				this.actx = actx;
			}
			/** Release the bound scope at prune time (a later rebind accompanies a freshly minted scope). */
			unbindScope() {
				this.actx = void 0;
			}
			/**
			* Register one local submission echo (see the ISession declaration).
			* Synchronous through markDirty: the echo is in the very next snapshot, so
			* the conversation can paint it before the caller starts serializing.
			* @param input - echo content and the optional settlement callback.
			* @returns the minted identity for {@link prompt} plus the pre-prompt abandon path.
			*/
			beginSubmission(input) {
				const requestId = randomUUID();
				this.pendingSubmissions = [...this.pendingSubmissions, {
					requestId,
					time: Date.now(),
					text: input.text,
					images: input.images
				}];
				this.submissionSettlements.set(requestId, {
					onRetire: input.onRetire,
					retiring: false
				});
				this.promptAttempted = true;
				this.notifier.markDirty();
				return {
					requestId,
					abandon: () => {
						this.retireFailedSubmission(requestId);
					}
				};
			}
			/**
			* Send (queue/steer passed through 1:1); failures land in the snapshot's promptError.
			* @param content - text plus browser-owned temporary image uploads.
			* @param mode - queue appends after the current turn; steer interrupts it.
			* @param signal - optional caller cancellation for the complete admission round-trip.
			* @param requestId - identity from {@link beginSubmission}; a failed identified prompt retires its echo.
			* @returns the prompt result (also mirrored into promptError on failure).
			*/
			async prompt(content, mode, signal, requestId) {
				this.promptError = null;
				this.lastAgentError = null;
				this.promptAttempted = true;
				if (this.blankBit) this.firstPromptPendingTurn = true;
				this.notifier.markDirty();
				let result;
				try {
					if (this.address === void 0) {
						const clientTimeZone = resolvedClientTimeZone();
						result = toSessionResult$1(await this.remote.session.prompt({
							requestId: requestId ?? randomUUID(),
							sessionId: this.sessionId,
							mode,
							content,
							clientTimeZone
						}, signal));
					} else if (this.address.mode === "one-shot") result = {
						ok: false,
						error: {
							code: "subagent-not-resumable",
							message: "one-shot subagent conversations are read-only",
							details: { childSessionId: this.address.childSessionId }
						}
					};
					else if (content.some((part) => part.type === "image")) result = {
						ok: false,
						error: {
							code: "attachment-error",
							message: "Image input is unavailable for subagent continuations.",
							details: { reason: "SUBAGENT_IMAGE_UNSUPPORTED" }
						}
					};
					else {
						const routed = toSessionResult$1(await this.remote.subagents.prompt({
							requestId: randomUUID(),
							parentSessionId: this.address.parentSessionId,
							childSessionId: this.address.childSessionId,
							mode: this.address.mode,
							content: content.flatMap((part) => part.type === "text" ? [{
								type: "text",
								text: part.text
							}] : []),
							clientTimeZone: resolvedClientTimeZone()
						}, signal));
						result = routed.ok ? {
							ok: true,
							value: { accepted: true }
						} : routed;
					}
				} catch (error) {
					result = transportResult(error);
				}
				if (!result.ok) {
					if (requestId !== void 0) this.retireFailedSubmission(requestId);
					this.promptError = {
						op: "send",
						error: result.error
					};
					this.notifier.markDirty();
					return result;
				}
				if (this.blankBit) {
					this.blankBit = false;
					this.options.onEngaged?.(this);
					this.notifier.markDirty();
				}
				return result;
			}
			/**
			* Resolve one image referenced by this session into browser-consumable bytes.
			* @param attachmentId - opaque id found in the folded session log.
			* @returns the authenticated reference and decoded bytes.
			*/
			async readAttachment(attachmentId) {
				try {
					const result = await this.remote.session.attachment({
						sessionId: this.sessionId,
						attachmentId
					});
					if (!result.ok) return toSessionResult$1(result);
					const binary = atob(result.value.data);
					const data = Uint8Array.from(binary, (char) => char.charCodeAt(0));
					return {
						ok: true,
						value: {
							attachment: result.value.attachment,
							data
						}
					};
				} catch (error) {
					return transportResult(error);
				}
			}
			/** Apply one operation to a still-pending queue occurrence. */
			async updateQueue(itemId, action) {
				try {
					return toSessionResult$1(await this.remote.session.updateQueue({
						sessionId: this.sessionId,
						itemId,
						action
					}));
				} catch (error) {
					return transportResult(error);
				}
			}
			/**
			* Stop the active turn while the Host preserves pending inbox work; failures
			* land in promptError (same error-strip display slot). A continuable
			* subagent address routes through `subagents.interruptByParent`, whose durable
			* parent-address authority works without a live parent Agent; a one-shot
			* address stays uncancellable (the UI offers no stop action, so this arm is
			* defensive).
			* @returns the cancel result.
			*/
			async cancel() {
				const address = this.address;
				if (address !== void 0 && address.mode === "one-shot") {
					const result = {
						ok: false,
						error: {
							code: "subagent-delivery-unavailable",
							message: "subagent activation cancellation is unavailable",
							details: { childSessionId: address.childSessionId }
						}
					};
					this.promptError = {
						op: "stop",
						error: result.error
					};
					this.notifier.markDirty();
					return result;
				}
				let result;
				try {
					result = address !== void 0 ? toSessionResult$1(await this.remote.subagents.interruptByParent(address.childSessionId, address.parentSessionId, address.mode)) : toSessionResult$1(await this.remote.session.cancel({ sessionId: this.sessionId }));
				} catch (error) {
					result = transportResult(error);
				}
				if (!result.ok) {
					this.promptError = {
						op: "stop",
						error: result.error
					};
					this.notifier.markDirty();
				}
				return result;
			}
			/**
			* Rename: contract session.rename 1:1. On success settle the 'title'
			* projection cell from the response's `{title, seq}` under the store's
			* higher-seq-wins rule (the push frame arriving later is a no-op replay),
			* so the list row and any useProjection('title') reader update without
			* waiting for the control-stream projection update.
			* @param title - raw title text (the host normalizes acceptance).
			* @returns the rename result (normalized accepted title + title event seq).
			*/
			async rename(title) {
				try {
					const result = toSessionResult$1(await this.remote.session.rename({
						sessionId: this.sessionId,
						title
					}));
					if (result.ok) this.projections.apply("title", result.value.title, result.value.seq);
					return result;
				} catch (error) {
					return transportResult(error);
				}
			}
			/**
			* Execute one slash-command line against this session's agent — pure
			* admission semantics (the host executor durably logs the lifecycle;
			* outcomes render as flow nodes, never as a response echo).
			* @param line - the full command line, leading slash included.
			* @returns the admission result, or the error branch on transport failure.
			*/
			async command(line) {
				const result = await this.remote.commands.execute(this.sessionId, line, []);
				if (!result.ok) return result;
				return {
					ok: true,
					value: { matched: result.value !== void 0 }
				};
			}
			/** First open: pull the tail page (idempotent — in-flight/already-open returns the existing promise). */
			open() {
				if (this.openState === "open") return Promise.resolve();
				if (this.openPromise !== null) return this.openPromise;
				const promise = this.doOpen(this.openGeneration).finally(() => {
					if (this.openPromise === promise) this.openPromise = null;
				});
				this.openPromise = promise;
				return promise;
			}
			/** Page up: pull one earlier page with the window's first seq as beforeSeq and prepend. */
			async loadOlder() {
				if (this.openState !== "open" || !this.hasMore || this.loadingOlder) return;
				const events = this.events;
				if (events === void 0) return;
				this.loadingOlder = true;
				this.notifier.markDirty();
				try {
					await events.prepend({
						beforeSeq: this.baseSeq,
						maxMessages: 50
					});
				} catch (error) {
					if (sessionStreamFailure(error) === void 0) console.error("[session-controller] loadOlder failed:", error);
				} finally {
					this.loadingOlder = false;
					this.notifier.markDirty();
				}
			}
			/** Rebuild an opened history source after address replacement.
			*  Invalidates any in-flight open first; queue state belongs to the independently
			*  reconnecting control stream and remains untouched. */
			async resync() {
				if (this.openState === "cold") return;
				this.openGeneration++;
				const events = this.events;
				this.events = void 0;
				await events?.dispose();
				this.openPromise = null;
				this.openState = "cold";
				this.openError = null;
				this.baseSeq = 0;
				this.notifier.markDirty();
				await this.open();
			}
			/**
			* uSES subscription entry.
			* @param listener - change callback.
			* @returns the unsubscribe function.
			*/
			subscribe(listener) {
				return this.notifier.subscribe(listener);
			}
			/**
			* Cached Session snapshot (rebuilt lazily when dirty with no listeners).
			* @returns the cached reference (stable until the next flush).
			*/
			getSnapshot() {
				this.notifier.ensureFresh();
				return this.snapshotCache;
			}
			/**
			* Replace every transient control value for this Session from one stream baseline.
			* @param queue - complete pending queue for this Session.
			*/
			replaceControl(queue) {
				this.queueMirror.replace(queue);
				this.observeSubmissionQueue(queue);
				this.notifier.markDirty();
			}
			/**
			* Apply one Session-addressed live control update.
			* @param frame - queue replacement addressed to this Session.
			*/
			handleControlFrame(frame) {
				this.queueMirror.replace(frame.items);
				this.observeSubmissionQueue(frame.items);
				this.notifier.markDirty();
			}
			/**
			* Running-bit relay from the host stream (list entry and snapshot stay consistent).
			* @param running - the new running state.
			*/
			handleRunning(running) {
				if (running && this.blankBit) {
					this.blankBit = false;
					this.notifier.markDirty();
				}
				if (running) this.firstPromptPendingTurn = false;
				if (this.running === running) return;
				this.running = running;
				this.notifier.markDirty();
			}
			/**
			* Install or clear the catalog-discovered transport address. A changed
			* address rebuilds an already-open window through its new history route.
			* @param address - direct parent/child address, or undefined for ordinary transport.
			* @param parentAvailable - latest exact-parent availability hint, or undefined before a catalog read.
			*/
			configureSubagent(address, parentAvailable) {
				const same = this.address?.parentSessionId === address?.parentSessionId && this.address?.childSessionId === address?.childSessionId && this.address?.mode === address?.mode;
				this.address = address;
				this.parentAvailable = parentAvailable;
				if (!same && this.openState !== "cold") this.resync();
				else this.notifier.markDirty();
			}
			/**
			* Update only the parent availability hint from a catalog refresh.
			* @param available - whether the exact direct parent is live.
			*/
			handleSubagentParentAvailable(available) {
				if (this.parentAvailable === available) return;
				this.parentAvailable = available;
				this.notifier.markDirty();
			}
			/**
			* Blank-bit relay from the authoritative summary source (`session.list` and
			* `api-session/added`). Monotone: once any signal (local first send,
			* running flip, an earlier summary) cleared it, a stale true never
			* re-blanks.
			* @param blank - the summary's derived empty-log bit.
			*/
			handleBlank(blank) {
				if (blank === this.blankBit) return;
				if (blank && (this.promptAttempted || this.running)) return;
				this.blankBit = blank;
				this.notifier.markDirty();
			}
			/** `api-session/removed` relay: flag the snapshot while retaining the resident instance. */
			handleRemoved() {
				this.removed = true;
				this.notifier.markDirty();
			}
			/**
			* `api-session/error` relay: the outlet for live failures with no turn position.
			* @param message - the stringified error.
			*/
			handleAgentError(message) {
				this.lastAgentError = message;
				this.notifier.markDirty();
			}
			/**
			* Stop the Session's live Remote source.
			* @returns when the Remote iterator has completed teardown.
			*/
			async dispose() {
				for (const requestId of [...this.submissionSettlements.keys()]) this.retireFailedSubmission(requestId);
				this.openGeneration++;
				const events = this.events;
				this.events = void 0;
				await events?.dispose();
			}
			/** @param generation - openGeneration at launch; stale passes cannot publish after replacement. */
			async doOpen(generation) {
				this.openState = "loading";
				this.openError = null;
				this.notifier.markDirty();
				const events = new SessionEventStream(this.remote, this.sessionAddress(), {
					publish: (change) => {
						if (generation !== this.openGeneration || this.events !== events) return;
						this.acceptEventChange(change);
					},
					failed: (error) => {
						this.failEventStream(events, generation, error);
					}
				});
				this.events = events;
				try {
					await events.open({ maxMessages: 50 });
					if (generation !== this.openGeneration || this.events !== events) return;
					this.openState = "open";
				} catch (error) {
					if (generation !== this.openGeneration || this.events !== events) return;
					this.events = void 0;
					this.openState = "error";
					this.openError = openFailure(error);
				} finally {
					if (generation === this.openGeneration) this.notifier.markDirty();
				}
			}
			/** Apply one contiguous journal update already reconciled by the Remote stream. */
			acceptEventChange(change) {
				switch (change.type) {
					case "replace":
						this.installWindow(change.entries, change.hasMore, change.page.projections);
						return;
					case "prepend":
						this.prependWindow(change.entries, change.hasMore);
						return;
					case "append": if (this.appendLive(change.entry)) this.notifier.markDirty();
				}
			}
			/** Replace the complete contiguous window and apply page-owned projection metadata. */
			installWindow(entries, hasMore, projections) {
				this.baseSeq = entries[0]?.event.seq ?? 0;
				this.hasMore = hasMore;
				if (entries.some((entry) => entry.event.type === "turn/start")) this.firstPromptPendingTurn = false;
				if (projections !== void 0) this.projections.seed(projections);
				this.eventSource.replace(entries, hasMore);
				for (const entry of entries) this.observeSubmissionEvent(entry.event);
				this.notifier.markDirty();
			}
			/** Prepend one stream-validated history page. */
			prependWindow(entries, hasMore) {
				this.baseSeq = entries[0]?.event.seq ?? this.baseSeq;
				this.hasMore = hasMore;
				this.eventSource.prepend(entries, hasMore);
			}
			/** Append one stream-validated live event. */
			appendLive(entry) {
				const event = entry.event;
				const awaitingFirstTurn = this.firstPromptPendingTurn;
				if (event.type === "turn/start") this.firstPromptPendingTurn = false;
				const queueChanged = this.queueMirror.acceptDurable(event);
				this.eventSource.append(entry);
				this.observeSubmissionEvent(event);
				return queueChanged || awaitingFirstTurn !== this.firstPromptPendingTurn;
			}
			/** Retire the matching echo when a durable browser-prompt `user/message` becomes visible. */
			observeSubmissionEvent(event) {
				if (this.submissionSettlements.size === 0 || event.type !== "user/message") return;
				const data = event.data;
				const source = data?.source;
				if (source?.kind !== "user" || typeof source.rpcId !== "string") return;
				this.scheduleObservedRetirement(source.rpcId, imageRefsIn(data?.content));
			}
			/** Retire echoes whose prompts landed in the host inbox instead of the log (running-turn submissions). */
			observeSubmissionQueue(items) {
				if (this.submissionSettlements.size === 0) return;
				for (const item of items) if (item.rpcId !== void 0) this.scheduleObservedRetirement(item.rpcId, imageRefsIn(item.message.content));
			}
			/**
			* Latch one observed settlement and remove the echo an animation frame
			* later. The delay keeps the echo in the snapshot until the frame in which
			* the durable node (whose assembly frame was registered first) is
			* renderable; the render-time rpcId dedupe hides the one-frame overlap.
			*/
			scheduleObservedRetirement(requestId, attachments) {
				const settlement = this.submissionSettlements.get(requestId);
				if (settlement === void 0 || settlement.retiring) return;
				settlement.retiring = true;
				scheduleFrame(() => {
					this.finishSubmission(requestId, {
						reason: "observed",
						attachments
					});
				});
			}
			/** Remove one unsettled echo immediately (prompt rejection, abort, or disposal). */
			retireFailedSubmission(requestId) {
				const settlement = this.submissionSettlements.get(requestId);
				if (settlement === void 0 || settlement.retiring) return;
				settlement.retiring = true;
				this.finishSubmission(requestId, { reason: "failed" });
			}
			/** Single removal point: drop the echo, publish, then notify the owner. */
			finishSubmission(requestId, retirement) {
				const settlement = this.submissionSettlements.get(requestId);
				/* v8 ignore next -- retiring latches before every schedule, so one settlement never finishes twice. */
				if (settlement === void 0) return;
				this.submissionSettlements.delete(requestId);
				this.pendingSubmissions = this.pendingSubmissions.filter((echo) => echo.requestId !== requestId);
				this.notifier.markDirty();
				settlement.onRetire?.(retirement);
			}
			/** Publish a terminal background failure only while this stream still owns the Session. */
			failEventStream(events, generation, error) {
				if (generation !== this.openGeneration || this.events !== events) return;
				this.openGeneration++;
				this.events = void 0;
				this.openPromise = null;
				this.openState = "error";
				this.openError = openFailure(error);
				events.dispose();
				this.notifier.markDirty();
			}
			buildSnapshot() {
				return {
					sessionId: this.sessionId,
					queue: this.queueMirror.snapshot(),
					pendingSubmissions: this.pendingSubmissions,
					running: this.running,
					subagent: this.address === void 0 ? null : {
						address: this.address,
						...this.parentAvailable === void 0 ? {} : { parentAvailable: this.parentAvailable }
					},
					removed: this.removed,
					openState: this.openState,
					openError: this.openError,
					hasMore: this.hasMore,
					loadingOlder: this.loadingOlder,
					promptError: this.promptError,
					blank: this.blankBit,
					lastAgentError: this.lastAgentError,
					promptAttempted: this.promptAttempted,
					awaitingFirstTurn: this.firstPromptPendingTurn
				};
			}
			sessionAddress() {
				return this.address === void 0 ? {
					kind: "session",
					sessionId: this.sessionId
				} : {
					kind: "subagent",
					...this.address
				};
			}
		};
		/** Run one callback on the next animation frame, or a macrotask where no frame clock exists. */
		function scheduleFrame(fn) {
			if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => {
				fn();
			});
			else setTimeout(fn, 0);
		}
		/** Image attachment references in one structurally-read content block list, in block order. */
		function imageRefsIn(content) {
			if (!Array.isArray(content)) return [];
			const refs = [];
			for (const block of content) {
				if (typeof block !== "object" || block === null) continue;
				const candidate = block;
				if (candidate.type === "image" && typeof candidate.attachment === "object" && candidate.attachment !== null) refs.push(candidate.attachment);
			}
			return refs;
		}
		/** Convert a terminal Session stream failure to the Client error vocabulary. */
		function openFailure(error) {
			const failure = sessionStreamFailure(error);
			if (failure !== void 0) return failure;
			const folded = transportResult(error);
			/* v8 ignore next -- transportResult never returns an ok result. */
			if (folded.ok) throw new Error("transportResult returned an unexpected success");
			return folded.error;
		}
		/** Narrow a generated Session Remote failure to its service-owned error vocabulary. */
		function toSessionResult$1(result) {
			return result.ok ? result : {
				ok: false,
				error: result.error
			};
		}
		//#endregion
		//#region lib/types/client/sessions/manager.js
		function catalogAvailability(parentAvailable) {
			return parentAvailable === void 0 ? {} : { parentAvailable };
		}
		/** Instance cluster + frame entry + the session list. */
		var SessionManager = class {
			remote;
			sessions = /* @__PURE__ */ new Map();
			/** In-flight Session disposals remain here after instances leave `sessions`, so manager disposal can await quiescence. */
			sessionDisposals = /* @__PURE__ */ new Set();
			/** Latest transient queues, retained independently of Session object materialization. */
			queues = /* @__PURE__ */ new Map();
			/**
			* Sessions that finished running while not selected — the sidebar's green
			* "done" reminder (manager-owned, survives connection generations; cleared
			* on select and session-removed, re-armed by the next completion).
			*/
			completedNotifications = /* @__PURE__ */ new Set();
			/** Last-observed running bits per session; the true→false edge here arms {@link completedNotifications}. */
			prevRunning = /* @__PURE__ */ new Map();
			/** Per-session projection value stores, retained independently of instance arrival (the
			*  title-snapshot precedent, generalized): push frames land here whether or not the Session
			*  is instantiated (list rows read the 'title' key), and an instantiated Session adopts the
			*  same store so history-baseline seeding and frames converge on one row set. */
			projectionStores = /* @__PURE__ */ new Map();
			summaries = [];
			listState = "idle";
			/** Arrival phase; the pending → ready edge fires on the first successful pull (see SessionListPhase). */
			listPhase = "pending";
			listError = null;
			listInflight = null;
			/** Mutations arriving after a list request starts are replayed over its response. */
			listMutations = null;
			addresses = /* @__PURE__ */ new Map();
			catalogs = /* @__PURE__ */ new Map();
			catalogInflight = /* @__PURE__ */ new Map();
			/** Catalog owners whose membership changed while a pull was in flight: one trailing refresh after it settles. */
			catalogStale = /* @__PURE__ */ new Set();
			openCatalogs = /* @__PURE__ */ new Set();
			catalogDebounce = /* @__PURE__ */ new Map();
			/**
			* Background jobs per session, last-wins from Session Controller's control
			* stream. An empty set is stored as an absent key, so absence and `[]` are
			* one representation.
			*/
			jobsBySession = /* @__PURE__ */ new Map();
			selected;
			listSnapshotCache;
			/** Entry-identity cache (reference stability): list rebuilds reuse the previous entry
			*  object when every field matches — wire refreshes mint all-new summary objects, so identity
			*  must be recovered by value or every SessionListItem memo misses on every refresh. */
			entryCache = /* @__PURE__ */ new Map();
			itemsCache = [];
			notifier = new Notifier(() => {
				this.listSnapshotCache = this.buildListSnapshot();
			});
			/**
			* @param remote - generated Remote namespaces the Session cluster calls.
			* @param restoredSelection - persisted real-Session selection candidate.
			*/
			constructor(remote, restoredSelection, restoredAddress) {
				this.remote = remote;
				this.selected = restoredSelection;
				if (restoredAddress !== void 0) this.addresses.set(restoredAddress.childSessionId, restoredAddress);
				this.listSnapshotCache = this.buildListSnapshot();
			}
			/**
			* Select a listed Session or a retained catalog-addressed child.
			* @param sessionId - listed or catalog-addressed Session id.
			*/
			select(sessionId) {
				const address = this.navigationAddress(sessionId);
				if (!this.summaries.some((summary) => summary.sessionId === sessionId) && address === void 0) throw new Error(`sessions.select: unknown session ${sessionId}`);
				if (address !== void 0) this.addresses.set(sessionId, address);
				this.sessions.get(sessionId)?.configureSubagent(address, address === void 0 ? void 0 : this.catalogs.get(address.parentSessionId)?.parentAvailable);
				this.selected = sessionId;
				this.completedNotifications.delete(sessionId);
				this.refreshSubagents(sessionId);
				this.notifier.notifyNow();
			}
			/**
			* Select a healthy child through its durable direct-parent address.
			* @param address - catalog-derived parent and child ids.
			*/
			selectSubagent(address) {
				const catalog = this.catalogs.get(address.parentSessionId);
				const entry = catalog?.entries.find((candidate) => candidate.id === address.childSessionId);
				if (entry === void 0 || entry.kind !== "child" || entry.mode !== address.mode) throw new Error(`sessions.selectSubagent: ${address.childSessionId} is not a healthy catalog child`);
				this.addresses.set(address.childSessionId, address);
				this.sessions.get(address.childSessionId)?.configureSubagent(address, catalog?.parentAvailable);
				this.selected = address.childSessionId;
				this.completedNotifications.delete(address.childSessionId);
				this.refreshSubagents(address.childSessionId);
				this.notifier.notifyNow();
			}
			/** Clear the selection (the layout falls to the no-session view state). */
			clearSelection() {
				this.selected = void 0;
				this.notifier.notifyNow();
			}
			/**
			* Return the durable catalog address retained for one child.
			* @param sessionId - possible addressed child id.
			* @returns The direct-parent address, when navigation discovered one.
			*/
			subagentAddress(sessionId) {
				return this.addresses.get(sessionId);
			}
			/**
			* Resolve an address for breadcrumb navigation without retaining transport authority.
			* @param sessionId - possible child id in an already-loaded catalog.
			* @returns A retained or catalog-derived direct-parent address.
			*/
			navigationAddress(sessionId) {
				const retained = this.addresses.get(sessionId);
				if (retained !== void 0) return retained;
				for (const [parentSessionId, catalog] of this.catalogs) {
					const child = catalog.entries.find((entry) => entry.kind === "child" && entry.id === sessionId);
					if (child?.kind === "child") return {
						parentSessionId,
						childSessionId: sessionId,
						mode: child.mode
					};
				}
			}
			/**
			* Drop a session instance (scope-prune companion: instance
			* and scope share one lifecycle). The host session log is the durable
			* truth — a later get() lazily rebuilds and open() backfills history.
			* @param sessionId - the session to drop.
			*/
			async drop(sessionId) {
				const session = this.sessions.get(sessionId);
				this.sessions.delete(sessionId);
				if (session !== void 0) await this.startSessionDisposal(session);
			}
			/**
			* Stop owned timers and every remaining Session instance.
			* @returns when every Session Remote iterator has completed teardown.
			*/
			async dispose() {
				for (const timer of this.catalogDebounce.values()) clearTimeout(timer);
				this.catalogDebounce.clear();
				this.catalogStale.clear();
				this.openCatalogs.clear();
				const sessions = [...this.sessions.values()];
				this.sessions.clear();
				for (const session of sessions) this.startSessionDisposal(session);
				await this.drainSessionDisposals();
			}
			startSessionDisposal(session) {
				const disposal = session.dispose();
				this.sessionDisposals.add(disposal);
				disposal.then(() => {
					this.sessionDisposals.delete(disposal);
				}, () => {
					this.sessionDisposals.delete(disposal);
				});
				return disposal;
			}
			async drainSessionDisposals() {
				while (this.sessionDisposals.size > 0) await Promise.allSettled([...this.sessionDisposals]);
			}
			/**
			* Lazy build: return the existing instance or construct one (no auto-open —
			* open is triggered by the container's select callback).
			* @param sessionId - the session to get.
			* @returns the resident instance.
			*/
			get(sessionId) {
				let session = this.sessions.get(sessionId);
				if (session === void 0) {
					session = this.createSession(sessionId);
					this.sessions.set(sessionId, session);
					session.replaceControl(this.queues.get(sessionId) ?? []);
					const summary = this.summaries.find((s) => s.sessionId === sessionId);
					if (summary !== void 0) {
						session.handleBlank(summary.blank);
						session.handleRunning(summary.running);
					} else {
						const address = this.addresses.get(sessionId);
						const child = address === void 0 ? void 0 : this.catalogs.get(address.parentSessionId)?.entries.find((entry) => entry.kind === "child" && entry.id === sessionId);
						if (child?.kind === "child") {
							session.handleBlank(false);
							session.handleRunning(child.activity === "running");
						}
					}
				}
				return session;
			}
			createSession(sessionId) {
				const address = this.addresses.get(sessionId);
				const parentAvailable = address === void 0 ? void 0 : this.catalogs.get(address.parentSessionId)?.parentAvailable;
				return new Session(sessionId, this.remote, {
					...address === void 0 ? {} : {
						address,
						...catalogAvailability(parentAvailable)
					},
					onEngaged: (engaged) => {
						this.recordMutation({
							kind: "engaged",
							sessionId: engaged.sessionId
						});
					},
					projections: this.projectionStore(sessionId)
				});
			}
			/** Resident per-session projection store (create-on-demand; outlives instantiation). */
			projectionStore(sessionId) {
				let store = this.projectionStores.get(sessionId);
				if (store === void 0) {
					store = new ProjectionValueStore();
					store.subscribeAny(() => {
						this.notifier.markDirty();
					});
					this.projectionStores.set(sessionId, store);
				}
				return store;
			}
			/**
			* Refresh one direct-child catalog, reusing its in-flight request.
			* @param parentSessionId - catalog owner.
			*/
			refreshSubagents(parentSessionId) {
				const existing = this.catalogInflight.get(parentSessionId);
				if (existing !== void 0) return existing.promise;
				const previous = this.catalogs.get(parentSessionId);
				const expandableRows = /* @__PURE__ */ new Set();
				const activityRows = /* @__PURE__ */ new Map();
				this.catalogs.set(parentSessionId, {
					entries: previous?.entries ?? [],
					...previous?.parentAvailable === void 0 ? {} : { parentAvailable: previous.parentAvailable },
					state: "loading",
					error: null
				});
				this.notifier.markDirty();
				const operation = (async () => {
					try {
						const result = toSessionResult(await this.remote.subagents.list(parentSessionId));
						if (result.ok) {
							const parentAvailable = this.catalogInflight.get(parentSessionId)?.parentAvailableOverride ?? result.value.parentAvailable;
							this.catalogs.set(parentSessionId, {
								...result.value,
								entries: this.withCatalogMutations(result.value.entries, expandableRows, activityRows),
								parentAvailable,
								state: "ready",
								error: null
							});
							for (const [childId, address] of this.addresses) {
								if (address.parentSessionId !== parentSessionId) continue;
								this.sessions.get(childId)?.handleSubagentParentAvailable(parentAvailable);
							}
						} else this.catalogs.set(parentSessionId, {
							entries: this.withCatalogMutations(previous?.entries ?? [], expandableRows, activityRows),
							...catalogAvailability(this.catalogInflight.get(parentSessionId)?.parentAvailableOverride ?? previous?.parentAvailable),
							state: "error",
							error: result.error
						});
					} catch (error) {
						const folded = transportResult(error);
						this.catalogs.set(parentSessionId, {
							entries: this.withCatalogMutations(previous?.entries ?? [], expandableRows, activityRows),
							...catalogAvailability(this.catalogInflight.get(parentSessionId)?.parentAvailableOverride ?? previous?.parentAvailable),
							state: "error",
							error: folded.ok ? null : folded.error
						});
					} finally {
						this.catalogInflight.delete(parentSessionId);
						if (this.catalogStale.delete(parentSessionId)) this.refreshSubagents(parentSessionId);
						this.notifier.markDirty();
					}
				})();
				this.catalogInflight.set(parentSessionId, {
					promise: operation,
					expandableRows,
					activityRows,
					parentAvailableOverride: void 0
				});
				return operation;
			}
			/**
			* Mark whether a catalog menu is consuming live membership updates.
			* @param parentSessionId - catalog owner.
			* @param open - current menu state.
			*/
			setSubagentCatalogOpen(parentSessionId, open) {
				if (open) {
					this.openCatalogs.add(parentSessionId);
					this.refreshSubagents(parentSessionId);
				} else {
					this.openCatalogs.delete(parentSessionId);
					const timer = this.catalogDebounce.get(parentSessionId);
					if (timer !== void 0) {
						clearTimeout(timer);
						this.catalogDebounce.delete(parentSessionId);
					}
				}
			}
			/** Full refresh via session.list (single-flight: an in-flight call is reused). */
			refreshList() {
				if (this.listInflight !== null) return this.listInflight;
				this.listState = "loading";
				this.listError = null;
				const established = this.summaries;
				const mutations = [];
				this.listMutations = mutations;
				this.notifier.markDirty();
				this.listInflight = (async () => {
					try {
						const result = toSessionResult(await this.remote.session.list({}));
						if (result.ok) {
							const baseline = this.listPhase === "pending" ? [...result.value.items] : mergeOrderedBaseline(established, result.value.items, (summary) => summary.sessionId);
							for (const s of baseline) if (!this.prevRunning.has(s.sessionId)) this.prevRunning.set(s.sessionId, s.running);
							let summaries = baseline;
							for (const mutation of mutations) {
								summaries = applyMutation(summaries, mutation);
								this.summaries = summaries;
								this.syncCompletedNotifications();
							}
							this.summaries = summaries;
							this.listState = "idle";
							this.listPhase = "ready";
							this.syncCompletedNotifications();
							for (const s of this.summaries) {
								const session = this.sessions.get(s.sessionId);
								if (session === void 0) continue;
								session.handleBlank(s.blank);
								session.handleRunning(s.running);
							}
							for (const s of result.value.items) {
								const block = s.projections;
								if (block === void 0) continue;
								const store = this.projectionStore(s.sessionId);
								const values = block.values;
								for (const key of Object.keys(values)) store.apply(key, values[key], block.asOfSeq);
							}
						} else {
							this.listState = "error";
							this.listError = result.error;
						}
					} catch (error) {
						this.listState = "error";
						const folded = transportResult(error);
						/* v8 ignore next -- the `? null` arm is unreachable: transportResult always returns ok:false. */
						this.listError = folded.ok ? null : folded.error;
					} finally {
						this.listMutations = null;
						this.listInflight = null;
						this.notifier.markDirty();
					}
				})();
				return this.listInflight;
			}
			/**
			* Search visible session message content without adding transient query
			* state to the list snapshot.
			* @param query - non-blank literal phrase.
			* @param signal - cancellation for superseded UI queries.
			* @returns the Host result or a folded transport error.
			*/
			async search(query, signal) {
				try {
					const result = toSessionResult(await this.remote.session.search({ query }, signal));
					if (!result.ok) return result;
					return {
						ok: true,
						value: {
							items: [...result.value.items],
							hasMore: result.value.hasMore
						}
					};
				} catch (error) {
					return transportResult(error);
				}
			}
			/**
			* Contract session.create; on success merge into summaries immediately (no
			* wait for the next refresh). A created session is blank by definition
			* (entity birth precedes the first message).
			* @param opts - target workspace or working directory, plus an optional caller-owned id.
			* @returns the create result.
			*/
			async create(opts = {}) {
				try {
					const shared = opts.sessionId === void 0 ? {} : { sessionId: opts.sessionId };
					const payload = opts.workspaceId !== void 0 ? {
						workspaceId: opts.workspaceId,
						...shared
					} : {
						...opts.cwd === void 0 ? {} : { cwd: opts.cwd },
						...shared
					};
					const result = toSessionResult(await this.remote.session.create(payload));
					if (result.ok) this.recordMutation({
						kind: "upsert",
						summary: {
							sessionId: result.value.sessionId,
							updatedAt: Date.now(),
							running: false,
							blank: true,
							...opts.cwd !== void 0 ? { cwd: opts.cwd } : {}
						}
					});
					else {
						const publishedSessionId = workspaceAttachSessionId(result.error);
						if (publishedSessionId !== void 0) this.recordMutation({
							kind: "upsert",
							summary: {
								sessionId: publishedSessionId,
								updatedAt: Date.now(),
								running: false,
								blank: true
							}
						});
					}
					return result;
				} catch (error) {
					return transportResult(error);
				}
			}
			/**
			* Contract session.fork; on success merge the child into summaries
			* immediately (same synchronous-addressability guarantee as create). The
			* child carries the source's history, so it is never blank; lineage rides
			* parentSessionId so the list nests it under its source. A child published
			* before Workspace attachment fails is also reconciled into the list.
			* @param opts - source session and the optional seq anchoring the cut.
			* @returns the fork result (the child session id).
			*/
			async fork(opts) {
				try {
					const source = this.summaries.find((s) => s.sessionId === opts.sessionId);
					const result = toSessionResult(await this.remote.session.fork({
						sessionId: opts.sessionId,
						...opts.atSeq === void 0 ? {} : { atSeq: opts.atSeq }
					}));
					const childId = result.ok ? result.value.sessionId : workspaceAttachSessionId(result.error);
					if (childId !== void 0) this.recordMutation({
						kind: "upsert",
						summary: {
							sessionId: childId,
							updatedAt: Date.now(),
							running: false,
							blank: false,
							parentSessionId: opts.sessionId,
							...source?.cwd !== void 0 ? { cwd: source.cwd } : {}
						}
					});
					return result;
				} catch (error) {
					return transportResult(error);
				}
			}
			/**
			* Insert-or-enrich a locally synthesized summary: a new id prepends; an
			* existing entry only gains fields it lacks (the session-added frame and the
			* create() echo race — whichever lands second must fill the placeholder's
			* missing cwd/parentSessionId, never overwrite list-refresh data).
			*/
			mergeSummary(summary) {
				this.recordMutation({
					kind: "upsert",
					summary
				});
			}
			/** Apply immediately and retain for replay when a list response is in flight. */
			recordMutation(mutation) {
				this.listMutations?.push(mutation);
				this.summaries = applyMutation(this.summaries, mutation);
				this.syncCompletedNotifications();
				this.notifier.markDirty();
			}
			/**
			* uSES subscription entry for useSessionList.
			* @param listener - change callback.
			* @returns the unsubscribe function.
			*/
			subscribe(listener) {
				return this.notifier.subscribe(listener);
			}
			/**
			* Cached list snapshot (rebuilt lazily when dirty with no listeners).
			* @returns the cached reference (stable until the next flush).
			*/
			getListSnapshot() {
				this.notifier.ensureFresh();
				return this.listSnapshotCache;
			}
			/**
			* Apply a complete control baseline or one later replacement frame.
			* @param frame - baseline or live control replacement from Session Controller.
			*/
			handleControlFrame(frame) {
				if (frame.type === "baseline") {
					this.replaceControlBaseline(frame.value);
					return;
				}
				if (frame.type === "projection") {
					this.projectionStore(frame.sessionId).apply(frame.key, frame.value, frame.seq);
					this.notifier.markDirty();
					return;
				}
				if (frame.type === "jobs") {
					if (frame.jobs.length === 0) this.jobsBySession.delete(frame.sessionId);
					else this.jobsBySession.set(frame.sessionId, frame.jobs);
					this.notifier.markDirty();
					return;
				}
				this.queues.set(frame.sessionId, frame.items);
				this.sessions.get(frame.sessionId)?.handleControlFrame(frame);
			}
			replaceControlBaseline(baseline) {
				this.queues.clear();
				for (const [sessionId, items] of Object.entries(baseline.queues)) this.queues.set(sessionId, items);
				this.jobsBySession.clear();
				for (const [sessionId, jobs] of Object.entries(baseline.jobs)) if (jobs.length > 0) this.jobsBySession.set(sessionId, jobs);
				for (const [sessionId, block] of Object.entries(baseline.projections)) {
					const store = this.projectionStore(sessionId);
					store.truncate(block.asOfSeq);
					store.seed(block);
				}
				for (const [sessionId, session] of this.sessions) session.replaceControl(this.queues.get(sessionId) ?? []);
				this.notifier.markDirty();
			}
			/**
			* Apply one Session-list addition forwarded through `ctx.remote.$on`.
			* @param summary - current Host summary for the added Session.
			*/
			handleSessionAdded(summary) {
				this.mergeSummary(summary);
				this.sessions.get(summary.sessionId)?.handleBlank(summary.blank);
				const projections = summary.projections;
				if (projections !== void 0) {
					const store = this.projectionStore(summary.sessionId);
					for (const [key, value] of Object.entries(projections.values)) store.apply(key, value, projections.asOfSeq);
				}
				if (summary.origin === "subagent" && summary.parentSessionId !== void 0) this.markCatalogParentExpandable(summary.parentSessionId);
				if (summary.parentSessionId !== void 0 && (this.selected === summary.parentSessionId || this.openCatalogs.has(summary.parentSessionId))) this.scheduleCatalogRefresh(summary.parentSessionId);
			}
			/**
			* Apply one Session removal forwarded through `ctx.remote.$on`.
			* @param sessionId - removed Session identity.
			*/
			handleSessionRemoved(sessionId) {
				const durableSubagent = this.summaries.find((candidate) => candidate.sessionId === sessionId)?.origin === "subagent" || this.addresses.has(sessionId);
				this.recordMutation(durableSubagent ? {
					kind: "status",
					sessionId,
					running: false
				} : {
					kind: "remove",
					sessionId
				});
				this.updateCatalogActivity(sessionId, false);
				if (durableSubagent) this.sessions.get(sessionId)?.handleRunning(false);
				else this.sessions.get(sessionId)?.handleRemoved();
				this.queues.delete(sessionId);
				this.jobsBySession.delete(sessionId);
				if (!durableSubagent) this.projectionStores.delete(sessionId);
				const inflightCatalog = this.catalogInflight.get(sessionId);
				if (inflightCatalog !== void 0) {
					inflightCatalog.parentAvailableOverride = false;
					this.catalogStale.add(sessionId);
				}
				const ownedCatalog = this.catalogs.get(sessionId);
				if (ownedCatalog !== void 0 && ownedCatalog.parentAvailable) this.catalogs.set(sessionId, {
					...ownedCatalog,
					parentAvailable: false
				});
				for (const [childId, address] of this.addresses) if (address.parentSessionId === sessionId) this.sessions.get(childId)?.handleSubagentParentAvailable(false);
			}
			/**
			* Apply one live Agent running-state change.
			* @param sessionId - Session whose Agent state changed.
			* @param running - current Agent running state.
			*/
			handleSessionStatus(sessionId, running) {
				this.recordMutation({
					kind: "status",
					sessionId,
					running
				});
				this.sessions.get(sessionId)?.handleRunning(running);
				this.updateCatalogActivity(sessionId, running);
			}
			/**
			* Advance Session-list activity from one user-authored durable message.
			* @param sessionId - Session whose activity changed.
			* @param updatedAt - durable message timestamp.
			*/
			handleSessionActivity(sessionId, updatedAt) {
				this.recordMutation({
					kind: "activity",
					sessionId,
					updatedAt
				});
			}
			/**
			* Surface one live Agent failure on an already-materialized Session.
			* @param sessionId - Session whose Agent failed.
			* @param message - caller-visible failure description.
			*/
			handleSessionError(sessionId, message) {
				this.sessions.get(sessionId)?.handleAgentError(message);
			}
			/**
			* Repair one re-established Host-event generation with queryable baselines.
			* Opened Session follow streams resume independently through API Gateway.
			*/
			handleConnected() {
				this.refreshList();
				const selectedAddress = this.selected === void 0 ? void 0 : this.addresses.get(this.selected);
				if (selectedAddress !== void 0) this.refreshSubagents(selectedAddress.parentSessionId);
				if (this.selected !== void 0) this.refreshSubagents(this.selected);
				for (const parentSessionId of this.openCatalogs) this.refreshSubagents(parentSessionId);
			}
			/** Debounce membership refetches while one parent catalog is selected or open. */
			scheduleCatalogRefresh(parentSessionId) {
				if (this.catalogDebounce.has(parentSessionId)) return;
				const timer = setTimeout(() => {
					this.catalogDebounce.delete(parentSessionId);
					if (this.catalogInflight.has(parentSessionId)) {
						this.catalogStale.add(parentSessionId);
						return;
					}
					this.refreshSubagents(parentSessionId);
				}, 50);
				this.catalogDebounce.set(parentSessionId, timer);
			}
			/** Apply one Agent-driver transition to loaded and in-flight catalogs. */
			updateCatalogActivity(childSessionId, running) {
				const activity = running ? "running" : "inactive";
				for (const inflight of this.catalogInflight.values()) inflight.activityRows.set(childSessionId, activity);
				let changed = false;
				for (const [parentSessionId, catalog] of this.catalogs) {
					if (!catalog.entries.some((entry) => entry.kind === "child" && entry.id === childSessionId && entry.activity !== activity)) continue;
					const entries = catalog.entries.map((entry) => {
						if (entry.kind !== "child" || entry.id !== childSessionId) return entry;
						return {
							...entry,
							activity
						};
					});
					changed = true;
					this.catalogs.set(parentSessionId, {
						...catalog,
						entries
					});
				}
				if (changed) this.notifier.markDirty();
			}
			/** Preserve and project a positive expandability hint after one direct subagent publishes. */
			markCatalogParentExpandable(parentSessionId) {
				this.applyCatalogParentExpandable(parentSessionId);
				for (const inflight of this.catalogInflight.values()) inflight.expandableRows.add(parentSessionId);
			}
			/** Apply one positive expandability hint to every loaded catalog containing that unique row id. */
			applyCatalogParentExpandable(parentSessionId) {
				let changed = false;
				for (const [catalogParentId, catalog] of this.catalogs) {
					if (!catalog.entries.some((entry) => entry.kind === "child" && entry.id === parentSessionId && !entry.hasChildren)) continue;
					const entries = catalog.entries.map((entry) => {
						if (entry.kind !== "child" || entry.id !== parentSessionId || entry.hasChildren) return entry;
						return {
							...entry,
							hasChildren: true
						};
					});
					changed = true;
					this.catalogs.set(catalogParentId, {
						...catalog,
						entries
					});
				}
				if (changed) this.notifier.markDirty();
			}
			/** Fold request-local row mutations into one catalog result before publication. */
			withCatalogMutations(entries, expandableRows, activityRows) {
				return entries.map((entry) => {
					if (entry.kind !== "child") return entry;
					const activity = activityRows.get(entry.id);
					if (!expandableRows.has(entry.id) && activity === void 0) return entry;
					return {
						...entry,
						...expandableRows.has(entry.id) ? { hasChildren: true } : {},
						...activity === void 0 ? {} : { activity }
					};
				});
			}
			/**
			* Reconcile completion reminders against the latest summaries, eagerly after
			* every mutation and pull (a snapshot-build-time pass would collapse
			* consecutive status frames into one observation). A running→idle edge of a
			* non-selected session arms its reminder; running disarms it; removal drops
			* it. First observation only records the running bit — sessions already
			* idle at load get no reminder.
			*/
			syncCompletedNotifications() {
				const seen = /* @__PURE__ */ new Set();
				for (const s of this.summaries) {
					seen.add(s.sessionId);
					const prev = this.prevRunning.get(s.sessionId);
					if (prev === void 0) {
						this.prevRunning.set(s.sessionId, s.running);
						continue;
					}
					if (prev && !s.running) {
						if (s.sessionId !== this.selected) this.completedNotifications.add(s.sessionId);
					} else if (s.running) this.completedNotifications.delete(s.sessionId);
					this.prevRunning.set(s.sessionId, s.running);
				}
				for (const id of this.prevRunning.keys()) if (!seen.has(id)) this.prevRunning.delete(id);
				for (const id of this.completedNotifications) if (!seen.has(id)) this.completedNotifications.delete(id);
			}
			buildListSnapshot() {
				const items = flattenLineage(this.summaries.map((summary) => {
					const projectionStore = this.projectionStores.get(summary.sessionId);
					const title = projectionStore?.get("title");
					const projectionValues = projectionStore?.values();
					return {
						...summary,
						...typeof title === "string" && title !== "" ? { title } : {},
						...projectionValues === void 0 ? {} : { projectionValues }
					};
				}), this.completedNotifications).map((entry) => {
					const prev = this.entryCache.get(entry.sessionId);
					if (prev !== void 0 && prev.updatedAt === entry.updatedAt && prev.running === entry.running && prev.blank === entry.blank && prev.parentSessionId === entry.parentSessionId && prev.cwd === entry.cwd && prev.origin === entry.origin && prev.title === entry.title && prev.depth === entry.depth && prev.projectionValues === entry.projectionValues && prev.completed === entry.completed) return prev;
					this.entryCache.set(entry.sessionId, entry);
					return entry;
				});
				for (const id of this.entryCache.keys()) if (!items.some((e) => e.sessionId === id)) this.entryCache.delete(id);
				if (!(items.length === this.itemsCache.length && items.every((e, i) => e === this.itemsCache[i]))) this.itemsCache = items;
				const selected = this.selected;
				const current = selected !== void 0 && (items.some((item) => item.sessionId === selected) || this.addresses.has(selected)) ? selected : void 0;
				return {
					items: this.itemsCache,
					current,
					state: this.listState,
					phase: this.listPhase,
					error: this.listError,
					subagentsByParent: Object.fromEntries(this.catalogs),
					jobsBySession: Object.fromEntries(this.jobsBySession),
					currentAddress: current === void 0 ? void 0 : this.addresses.get(current)
				};
			}
		};
		/** Apply one list mutation without deriving display order. */
		function applyMutation(summaries, mutation) {
			switch (mutation.kind) {
				case "upsert": {
					const existing = summaries.find((summary) => summary.sessionId === mutation.summary.sessionId);
					if (existing === void 0) return [mutation.summary, ...summaries];
					const filled = {
						...existing,
						blank: existing.blank && mutation.summary.blank,
						...existing.cwd === void 0 && mutation.summary.cwd !== void 0 ? { cwd: mutation.summary.cwd } : {},
						...existing.parentSessionId === void 0 && mutation.summary.parentSessionId !== void 0 ? { parentSessionId: mutation.summary.parentSessionId } : {},
						...existing.origin === void 0 && mutation.summary.origin !== void 0 ? { origin: mutation.summary.origin } : {}
					};
					if (filled.cwd === existing.cwd && filled.parentSessionId === existing.parentSessionId && filled.origin === existing.origin && filled.blank === existing.blank) return [...summaries];
					return summaries.map((summary) => summary.sessionId === mutation.summary.sessionId ? filled : summary);
				}
				case "remove": return summaries.filter((summary) => summary.sessionId !== mutation.sessionId);
				case "status": return summaries.map((summary) => summary.sessionId === mutation.sessionId && (summary.running !== mutation.running || mutation.running && summary.blank) ? {
					...summary,
					running: mutation.running,
					blank: summary.blank && !mutation.running
				} : summary);
				case "activity": return summaries.map((summary) => summary.sessionId === mutation.sessionId && mutation.updatedAt > summary.updatedAt ? {
					...summary,
					updatedAt: mutation.updatedAt
				} : summary);
				case "engaged": return summaries.map((summary) => summary.sessionId === mutation.sessionId && summary.blank ? {
					...summary,
					blank: false
				} : summary);
			}
		}
		/** Temporary source-plane bridge while the Host contract and client project build independently. */
		function workspaceAttachSessionId(error) {
			return error.code === "workspace-attach-failed" ? error.details.sessionId : void 0;
		}
		/** Narrow a generated Session Remote failure to its service-owned error vocabulary. */
		function toSessionResult(result) {
			return result.ok ? result : {
				ok: false,
				error: result.error
			};
		}
		//#endregion
		//#region lib/types/client/sessions/service.js
		/** Structured session-create failure. */
		var SessionCreateError = class extends Error {
			rpcError;
			requestedSessionId;
			name = "SessionCreateError";
			/**
			* @param rpcError - Host business or folded transport error.
			* @param requestedSessionId - caller-preallocated id used for later stream/list reconciliation.
			*/
			constructor(rpcError, requestedSessionId) {
				super(`session create failed: ${rpcError.code}: ${rpcError.message}`);
				this.rpcError = rpcError;
				this.requestedSessionId = requestedSessionId;
			}
		};
		/** Structured session-fork failure. */
		var SessionForkError = class extends Error {
			rpcError;
			sourceSessionId;
			name = "SessionForkError";
			/**
			* @param rpcError - Host business or folded transport error.
			* @param sourceSessionId - the session the fork was cut from.
			*/
			constructor(rpcError, sourceSessionId) {
				super(`session fork failed: ${rpcError.code}: ${rpcError.message}`);
				this.rpcError = rpcError;
				this.sourceSessionId = sourceSessionId;
			}
		};
		/**
		* Display title projection: durable title, project directory basename, then
		* the raw id.
		*/
		function displayTitleOf(title, cwd, id) {
			if (title !== void 0) return title;
			if (cwd !== void 0 && cwd !== "") {
				const base = workspaceTitleOf(cwd);
				if (base !== "") return base;
			}
			return id;
		}
		/**
		* Increment a trailing fork number while preserving its half-width or
		* full-width parentheses; an unnumbered title starts with ` (1)`.
		* @param title - source session's durable title.
		* @returns the title assigned to the fork child.
		*/
		function increasedForkTitle(title) {
			const ascii = /^(.*?)\((\d+)\)$/u.exec(title);
			if (ascii?.[1] !== void 0 && ascii[2] !== void 0) return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`;
			const fullWidth = /^(.*?)（(\d+)）$/u.exec(title);
			if (fullWidth?.[1] !== void 0 && fullWidth[2] !== void 0) return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`;
			return `${title} (1)`;
		}
		/** Root sessions service: list store, current selection, object-layer manager, scope tree, bindings, and breadcrumb routes. */
		var ClientSessions = class {
			rootCtx;
			/**
			* The wire schema's own result bound, re-exposed for presentation plugins as
			* injected data. Not per-connection state: the `session.search` response
			* schema caps `items` at this constant, so every transport (fixture included)
			* reports the same number.
			*/
			searchResultLimit = 20;
			/** List snapshot store (list RPC + host stream increments; re-pulled on reconnect) — the useSessions standard feed, current included. */
			list;
			/** The object-layer instance cluster and frame dispatch entry. */
			manager;
			/**
			* Persisted selection cell (the durable half of `list.current`). Private on
			* purpose: reads go through the list snapshot; writes through {@link
			* ClientSessions.open} / {@link ClientSessions.clear}. Projection
			* validates it against the live list instead of destructively pruning, so a
			* selection survives transient list states (reconnect re-pull) and
			* resurfaces when its session returns.
			*/
			selection;
			scopes = /* @__PURE__ */ new Map();
			/** In-flight scope drops remain here after records leave `scopes`, so root disposal can await quiescence. */
			scopeDrops = /* @__PURE__ */ new Set();
			/**
			* The staged session id — follows `list.current` exactly, holding its last
			* defined value across masked gaps (a transiently absent selection blanks
			* `current` without moving the stage, so reconnect re-pulls and removals
			* keep the staged scope's frozen view alive until the stage moves on).
			*/
			watched;
			/** Removed-while-staged sessions whose teardown waits for the stage to move away. */
			deferredRemovals = /* @__PURE__ */ new Set();
			/**
			* @param ctx - client root context (scope fibers mount under it).
			* @param remote - generated Remote namespaces shared with every Session.
			*/
			constructor(rootCtx, remote) {
				this.rootCtx = rootCtx;
				this.selection = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({}, { persist: { name: "dsh.sessions.current" } });
				const restored = this.selection.getSnapshot();
				this.manager = new SessionManager(remote, restored.sessionId, restored.subagentAddress);
				this.list = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
					ids: [],
					byId: {},
					current: void 0,
					phase: "pending",
					subagentsByParent: {},
					jobsBySession: {},
					currentAddress: void 0
				});
				const disposeManagerProjection = this.manager.subscribe(() => {
					this.projectList();
				});
				const disposeStageFollower = this.list.subscribe(() => {
					this.followCurrent();
				});
				rootCtx.effect(() => async () => {
					disposeStageFollower();
					disposeManagerProjection();
					const scopes = [...this.scopes];
					this.scopes.clear();
					this.deferredRemovals.clear();
					this.watched = void 0;
					for (const [id, record] of scopes) this.startScopeDrop(id, record);
					await this.drainScopeDrops();
					await this.manager.dispose();
				}, "session-controller.client.sessions");
				rootCtx.reflect.provide("sessions", this, void 0);
			}
			/**
			* Select a listed or retained catalog-addressed session as current.
			* @param id - listed or addressed session id.
			*/
			open(id) {
				this.manager.select(id);
			}
			/**
			* Open a healthy catalog child through its direct-parent address.
			* @param address - catalog-derived parent and child ids.
			*/
			openSubagent(address) {
				this.manager.selectSubagent(address);
			}
			/**
			* Resolve an already discovered direct-parent address without opening it.
			* Feature plugins use this to avoid Agent-bound RPCs in persisted child views.
			* @param id - possible addressed child id.
			* @returns The retained address, when present.
			*/
			subagentAddress(id) {
				return this.manager.subagentAddress(id);
			}
			/**
			* Inform the Session Controller whether a catalog menu is consuming membership updates.
			* @param parentSessionId - selected parent.
			* @param open - menu state.
			*/
			setSubagentCatalogOpen(parentSessionId, open) {
				this.manager.setSubagentCatalogOpen(parentSessionId, open);
			}
			/**
			* Refresh one direct-child catalog.
			* @param parentSessionId - catalog owner.
			*/
			refreshSubagents(parentSessionId) {
				return this.manager.refreshSubagents(parentSessionId);
			}
			/**
			* Clear the current selection so the layout shows the no-session empty
			* state (new-session affordance and the workspace preselection flow).
			* Wipes the persisted selection too — a reload stays on empty until the
			* user opens or starts a session. The staged scope keeps its frozen view
			* per the masked-gap contract until the next open() moves the stage.
			*/
			clear() {
				this.manager.clearSelection();
			}
			/**
			* Refresh the real Session baseline, reusing an in-flight pull.
			* @returns completion of the current or newly started baseline pull.
			*/
			refresh() {
				return this.manager.refreshList();
			}
			/**
			* Search the Host's visible message-content index. Results stay
			* request-local; the list snapshot remains the metadata authority.
			* @param query - non-blank literal phrase.
			* @param signal - cancellation for a superseded search.
			* @returns bounded results or a business/transport error.
			*/
			search(query, signal) {
				return this.manager.search(query, signal);
			}
			/**
			* Apply one Session Controller live-control frame.
			* @param frame - baseline or live control replacement.
			*/
			handleControlFrame(frame) {
				this.manager.handleControlFrame(frame);
			}
			/**
			* Apply one remotely forwarded Session-list addition.
			* @param summary - current Host summary for the added Session.
			*/
			handleSessionAdded(summary) {
				this.manager.handleSessionAdded(summary);
			}
			/**
			* Apply one remotely forwarded Session removal.
			* @param sessionId - removed Session identity.
			*/
			handleSessionRemoved(sessionId) {
				this.manager.handleSessionRemoved(sessionId);
			}
			/**
			* Apply one remotely forwarded running-state change.
			* @param args - Session identity and current Agent running state.
			*/
			handleSessionStatus(...args) {
				this.manager.handleSessionStatus(...args);
			}
			/**
			* Apply one remotely forwarded list-activity change.
			* @param args - Session identity and durable activity timestamp.
			*/
			handleSessionActivity(...args) {
				this.manager.handleSessionActivity(...args);
			}
			/**
			* Apply one remotely forwarded Agent failure.
			* @param args - Session identity and caller-visible failure description.
			*/
			handleSessionError(...args) {
				this.manager.handleSessionError(...args);
			}
			/** Rebuild the Session baseline and every opened window after connection. */
			handleConnected() {
				this.manager.handleConnected();
			}
			/**
			* Create a session on the host. Resolution guarantee: by the time the
			* promise resolves, the created session is in the list store and
			* {@link ClientSessions.binding} resolves it — callers (New Session
			* draft hand-off) may address the scope synchronously, without waiting a
			* notifier flush. The synchronous projection below makes this structural
			* rather than an accident of microtask ordering.
			* @param opts - target workspace or directory and an optional preallocated id.
			* @returns the new session id.
			* @throws {SessionCreateError} with the requested id.
			*/
			async create(opts = {}) {
				const result = await this.manager.create(opts);
				if (!result.ok) throw new SessionCreateError(result.error, opts.sessionId);
				this.projectList();
				return result.value.sessionId;
			}
			/**
			* Fork a session from a completed-turn prefix of the source (same
			* synchronous-addressability guarantee as {@link ClientSessions.create}:
			* on resolution the child is in the list store and open() can target it).
			* @param opts - source session id, the optional event seq anchoring the
			*   cut (the boundary is the first turn/end at or after it; an in-log
			*   anchor in an open turn is unavailable rather than clipped backward),
			*   and whether to increment an inherited durable title before resolving.
			*   A fractional anchor floors to a real event seq: the frozen nodes of an
			*   interrupted turn carry flow-ordering seqs between two events, and the
			*   wire takes integers only.
			* @returns the child session id.
			* @throws {SessionForkError} with the source id.
			* @throws {Error} when a requested child-title rename fails after creation.
			*/
			async fork(opts) {
				const sourceTitle = opts.increaseTitle ? this.list.getSnapshot().byId[opts.sessionId]?.title : void 0;
				const result = await this.manager.fork({
					sessionId: opts.sessionId,
					...opts.atSeq === void 0 ? {} : { atSeq: Math.floor(opts.atSeq) }
				});
				if (!result.ok) throw new SessionForkError(result.error, opts.sessionId);
				this.projectList();
				const childId = result.value.sessionId;
				if (sourceTitle !== void 0) {
					const child = this.binding(childId)?.session;
					if (child === void 0) throw new Error(`fork child "${childId}" is not locally addressable`);
					const renamed = await child.rename(increasedForkTitle(sourceTitle));
					if (!renamed.ok) throw new Error(`fork child rename failed: ${renamed.error.code}: ${renamed.error.message}`);
				}
				return childId;
			}
			/**
			* Resolve an Agent-scoped context view (use-and-discard).
			* @param id - session id (the agent identity — 1:1 same axis).
			* @returns scoped ctx, or undefined for a session neither listed nor already scoped.
			*/
			scope(id) {
				return this.resolve(id)?.ctx;
			}
			/**
			* Materialize the Agent scope named by a validated Host Remote Event.
			* The first successful Session-list baseline becomes authoritative for its
			* lifetime; until then, transport streams may address the scope in either
			* arrival order.
			* @param id - Host-projected Agent identity (the matching Session id).
			* @returns the identity-stable Agent Context.
			*/
			resolveAgentScope(id) {
				return (this.scopes.get(id) ?? this.materializeScope(id)).ctx;
			}
			/**
			* Read the Agent scope tag off a context. Service-method boundary: fetch
			* bundles must reach scope resolution through ctx.sessions — a cross-bundle
			* value import of the standalone helper would inline a second module
			* instance whose private tag Symbol never matches.
			* @param ctx - any client context.
			* @returns the session id, or undefined on root contexts.
			*/
			scopeOf(ctx) {
				return scopeOf(ctx);
			}
			/**
			* Resolve the business Session behind an Agent-scoped context — the one
			* hop every scoped consumer (event listeners, per-session controllers)
			* takes from ctx-space into object-space (the client mirror of host
			* `agent.session`). Same service-method boundary as
			* {@link ClientSessions.scopeOf}.
			* @param ctx - an Agent-scoped context.
			* @returns the session face, or undefined when the ctx is untagged or its scope was pruned.
			*/
			sessionOf(ctx) {
				const id = scopeOf(ctx);
				if (id === void 0) return void 0;
				return this.scopes.get(id)?.binding.session;
			}
			/**
			* Resolve the stable session binding (scope-addressed assembly feed). Pure
			* resolution — no staging, no window side effects.
			* @param id - session id.
			* @returns binding, or undefined for a session neither listed nor already scoped.
			*/
			binding(id) {
				return this.resolve(id)?.binding;
			}
			/**
			* Move the stage to the list's current session: sweep teardowns deferred
			* behind the previous occupant and pull the new occupant's history window.
			* Staging IS the open signal — the window opens ⟺ the session is on stage
			* — and open() is idempotent (an in-flight or completed open no-ops; a
			* failed one retries the next time current is touched).
			*/
			followCurrent() {
				const snapshot = this.list.getSnapshot();
				const current = snapshot.current;
				if (current === void 0 || snapshot.byId[current] === void 0 || current === this.watched) return;
				this.watched = current;
				this.sweepDeferred();
				const record = this.resolve(current);
				/* v8 ignore next 3 -- defensive: current is always a listed id (open()
				* validates and the projection masks absent selections), so resolve
				* cannot miss; kept so a future current writer cannot crash the notify. */
				if (record !== void 0) {
					record.session.open();
					this.manager.refreshSubagents(current);
				}
			}
			/**
			* Lazily mint the scope + binding for an eligible session. Eligibility and
			* prune share one predicate: listed on the host or selected
			* through a retained subagent address. Breadcrumb-only ancestors remain
			* summary data and do not keep scopes alive.
			*/
			resolve(id) {
				const existing = this.scopes.get(id);
				if (existing !== void 0) return existing;
				if (!this.eligible(id)) return void 0;
				return this.materializeScope(id);
			}
			/** Materialize one scope after its caller establishes that the id may be addressed. */
			materializeScope(id) {
				const { fiber, ctx } = createScope(this.rootCtx, id);
				const session = this.manager.get(id);
				session.bindScope(ctx);
				const record = {
					fiber,
					ctx,
					binding: {
						sessionId: id,
						session,
						eventSource: session.eventSource,
						ctx
					},
					session
				};
				this.scopes.set(id, record);
				return record;
			}
			/** The one aliveness predicate shared by scope mint and prune: host-listed or currently addressed. */
			eligible(id) {
				const { ids, current } = this.list.getSnapshot();
				return current === id || ids.includes(id);
			}
			/** Project the manager's list snapshot into the store (title derivation is display-only). */
			projectList() {
				const { items, current, phase, subagentsByParent, jobsBySession, currentAddress } = this.manager.getListSnapshot();
				const ids = [];
				const byId = {};
				for (const entry of items) {
					ids.push(entry.sessionId);
					byId[entry.sessionId] = {
						id: entry.sessionId,
						displayTitle: displayTitleOf(entry.title, entry.cwd, entry.sessionId),
						running: entry.running,
						...entry.completed ? { completed: true } : {},
						blank: entry.blank,
						updatedAt: entry.updatedAt,
						...entry.projectionValues === void 0 ? {} : { projectionValues: entry.projectionValues },
						...entry.title !== void 0 ? { title: entry.title } : {},
						...entry.cwd !== void 0 ? { cwd: entry.cwd } : {},
						...entry.parentSessionId !== void 0 ? { parentId: entry.parentSessionId } : {},
						...entry.origin !== void 0 ? { origin: entry.origin } : {}
					};
				}
				if (current !== void 0 && currentAddress !== void 0) {
					const seen = /* @__PURE__ */ new Set();
					let address = currentAddress;
					while (address !== void 0 && !seen.has(address.childSessionId)) {
						const childId = address.childSessionId;
						seen.add(childId);
						const child = subagentsByParent[address.parentSessionId]?.entries.find((entry) => entry.kind === "child" && entry.id === childId);
						if (child?.kind !== "child") break;
						const displayTitle = child.label ?? childId;
						const summary = byId[childId];
						if (summary === void 0) byId[childId] = {
							id: childId,
							displayTitle,
							parentId: address.parentSessionId,
							origin: "subagent",
							running: child.activity === "running",
							blank: false,
							updatedAt: 0
						};
						else if (summary.displayTitle !== displayTitle) byId[childId] = {
							...summary,
							displayTitle
						};
						const parent = byId[address.parentSessionId];
						if (parent !== void 0 && parent.origin !== "subagent") break;
						address = this.manager.navigationAddress(address.parentSessionId);
					}
				}
				const persisted = this.selection.getSnapshot().sessionId;
				if (current === void 0) {
					if (persisted !== void 0) this.selection.set({});
				} else if (byId[current] !== void 0 && (persisted !== current || this.selection.getSnapshot().subagentAddress?.childSessionId !== currentAddress?.childSessionId || this.selection.getSnapshot().subagentAddress?.parentSessionId !== currentAddress?.parentSessionId || this.selection.getSnapshot().subagentAddress?.mode !== currentAddress?.mode)) this.selection.set({
					sessionId: current,
					...currentAddress === void 0 ? {} : { subagentAddress: currentAddress }
				});
				this.list.set({
					ids,
					byId,
					current,
					phase,
					subagentsByParent,
					jobsBySession,
					currentAddress
				});
				this.pruneScopes();
			}
			/** Tear down scope + instance for no-longer-eligible sessions off stage; the staged one defers until the stage moves. */
			pruneScopes() {
				if (this.list.getSnapshot().phase === "pending") return;
				for (const [id, record] of this.scopes) {
					if (this.eligible(id)) continue;
					if (id === this.watched) {
						this.deferredRemovals.add(id);
						continue;
					}
					this.scopes.delete(id);
					this.deferredRemovals.delete(id);
					this.startScopeDrop(id, record);
				}
			}
			startScopeDrop(id, record) {
				const drop = this.dropScope(id, record);
				this.scopeDrops.add(drop);
				drop.then(() => {
					this.scopeDrops.delete(drop);
				}, () => {
					this.scopeDrops.delete(drop);
				});
			}
			async drainScopeDrops() {
				while (this.scopeDrops.size > 0) await Promise.allSettled([...this.scopeDrops]);
			}
			/**
			* One teardown for the whole per-session axis: the scope
			* fiber (cascading every actx-registered effect: input shell, slash
			* controller, popup, plugin stores, listeners), the session-keyed slot
			* registrations and the Session instance itself — the host session log is the
			* durable truth, a reopen lazily rebuilds and backfills via open().
			*/
			async dropScope(id, record) {
				record.session.unbindScope();
				await Promise.allSettled([record.fiber.dispose(), this.manager.drop(id)]);
			}
			/** Run deferred teardowns whose session is no longer staged (called when the stage moves). */
			sweepDeferred() {
				for (const id of [...this.deferredRemovals]) {
					/* v8 ignore next -- defensive: only the staged id ever defers, and every
					* stage move sweeps first, so the set cannot contain the id the stage just
					* moved to; kept as a guard against future extra sweep call sites. */
					if (id === this.watched) continue;
					if (this.eligible(id)) {
						this.deferredRemovals.delete(id);
						continue;
					}
					const record = this.scopes.get(id);
					this.deferredRemovals.delete(id);
					/* v8 ignore next -- defensive: prune deletes a scope and its deferral
					* together, so a deferred id always still owns its record; kept so a
					* future teardown path cannot double-dispose. */
					if (record !== void 0) {
						this.scopes.delete(id);
						this.startScopeDrop(id, record);
					}
				}
			}
		};
		//#endregion
		//#region lib/types/client/index.js
		/** Client Session object layer, Agent scopes, and Remote lifecycle wiring. */
		/** Required wire, Remote, and Context projection services. */
		const inject = [
			"connection",
			"typert",
			"remote",
			"remote.commands",
			"remote.session",
			"remote.subagents"
		];
		/**
		* Install Client Session state and its reconnecting control stream.
		* @param ctx - Client Cordis context.
		*/
		function apply(ctx) {
			const connection = ctx.get("connection");
			const remotes = ctx.remote;
			const sessions = new ClientSessions(ctx, remotes);
			ctx.remote.$on("api-session/added", (summary) => {
				sessions.handleSessionAdded(summary);
			});
			ctx.remote.$on("api-session/removed", (sessionId) => {
				sessions.handleSessionRemoved(sessionId);
			});
			ctx.remote.$on("api-session/status", (sessionId, running) => {
				sessions.handleSessionStatus(sessionId, running);
			});
			ctx.remote.$on("api-session/activity", (sessionId, updatedAt) => {
				sessions.handleSessionActivity(sessionId, updatedAt);
			});
			ctx.remote.$on("api-session/error", (sessionId, message) => {
				sessions.handleSessionError(sessionId, message);
			});
			const control = createSessionControlStream(remotes, {
				accept: (frame) => {
					sessions.handleControlFrame(frame);
				},
				failed: (error) => {
					console.error("[session-controller] control stream failed:", error);
				}
			});
			control.start();
			ctx.on("connection/reset", () => {
				sessions.handleConnected();
			});
			if (connection.generation.getSnapshot() !== void 0) sessions.handleConnected();
			ctx.typert.contexts.registerClient("agent", {
				identity: (candidate) => sessions.scopeOf(candidate),
				resolve: (sessionId) => sessions.resolveAgentScope(sessionId)
			});
			ctx.effect(() => async () => {
				await control.dispose();
			}, "session-controller.client.control");
		}
		//#endregion
		exports.MutableSessionEventSource = MutableSessionEventSource;
		exports.SESSION_SEARCH_RESULT_LIMIT = SESSION_SEARCH_RESULT_LIMIT;
		exports.SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS;
		exports.SessionCreateError = SessionCreateError;
		exports.SessionEventStream = SessionEventStream;
		exports.SessionForkError = SessionForkError;
		exports.apply = apply;
		exports.createScope = createScope;
		exports.createSessionControlStream = createSessionControlStream;
		exports.inject = inject;
		exports.scopeOf = scopeOf;
		exports.sessionStreamFailure = sessionStreamFailure;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map