/**
 * Service Definition for the subagent capability seam (`ctx.subagents`): a named-provider registry plus a
 * capability-validating asynchronous start API. Providers establish a
 * child before returning its run, so fulfillment is the single publication and
 * ownership-transfer boundary.
 *
 * Multiple providers coexist: each registers under a unique name and callers
 * select one by name.
 *
 * This package owns the Service Definition role of the capability seam. Service Providers
 * (`@deepseek-ai/dsh-subagent-spawn-in-process`, `-fork`, `-acp`) and the model-facing
 * consumer (`@deepseek-ai/dsh-tool-subagent`) are separate packages.
 *
 * Public operations express caller intent: `start` returns one published owned
 * one-shot run, `startContinuable` establishes a durable continuable child, and
 * `followup` delivers later content without exposing whether the child is
 * resident. Continuable children never become a {@link SubagentRun}: the
 * continuation manager holds their `AgentHandle` directly and orders every turn
 * through the child's own inbox, so providers contribute only the detached
 * creation spec and see no handle, turn, or teardown. Child and descendant
 * discovery read the live session store and optional session persistence
 * directly and do not require that continuation runtime.
 *
 * Same-process providers are trusted typed collaborators. Requests, provider
 * descriptors, results, and lifecycle payloads are borrowed immutable values;
 * serialization and hostile-input validation belong at real process, worker,
 * persistence, and model boundaries.
 *
 * @module @deepseek-ai/dsh-subagent
 */
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { canonicalClientTimeZone, catalogView, rejectCatalogRead, rejectControl, rejectPrompt, validateControlRequest, } from "./control.js";
import { SubagentError } from "./error.js";
import { assertSubagentMaxDepth } from "./depth.js";
import { createActivationObserver, createLifecycleEmitter, observeRun } from "./lifecycle.js";
import SubagentContinuationManager from "./continuation.js";
import SubagentActivationSetupRegistry from "./activation-setup-registry.js";
import { listChildren as listSubagentChildren, listDescendants as listSubagentDescendants } from "./list-children.js";
import { snapshotSubagentDescriptor } from "./descriptor.js";
import { subagentIdentityProjectionDefinition, subagentTimingProjectionDefinition } from "./projection.js";
export * from "./out-of-process.js";
export { AssistantOutputFold, finalAssistantOutput } from "./assistant-output.js";
export { SubagentRunId } from "./types.js";
export { foldSubagentDescriptor, snapshotSubagentDescriptor, SUBAGENT_DESCRIPTOR_VERSION, } from "./descriptor.js";
export { seedDescriptorTurn } from "./descriptor-seed.js";
export { SubagentError } from "./error.js";
export { settleRun } from "./run-settlement.js";
export { assertSubagentMaxDepth, delegationDepthOf } from "./depth.js";
export { appendDelegatedPolicyOverrides, applyChildComposition, captureDelegatedPolicyOverrides, childSessionMeta, parentAgentOptionsForDelegation, resolveChildAgentOptions, resolveChildDepth, SubagentDepthError, } from "./child-agent.js";
/** Named provider registry with one-shot runs, durable discovery, and continuable-child operations. */
let SubagentRuntime = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _remoteExportList_decorators;
    let _prompt_decorators;
    let _interruptByParent_decorators;
    return class SubagentRuntime extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _remoteExportList_decorators = [Remote('list')];
            _prompt_decorators = [Remote('prompt')];
            _interruptByParent_decorators = [Remote('interruptByParent')];
            __esDecorate(this, null, _remoteExportList_decorators, { kind: "method", name: "remoteExportList", static: false, private: false, access: { has: obj => "remoteExportList" in obj, get: obj => obj.remoteExportList }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _prompt_decorators, { kind: "method", name: "prompt", static: false, private: false, access: { has: obj => "prompt" in obj, get: obj => obj.prompt }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _interruptByParent_decorators, { kind: "method", name: "interruptByParent", static: false, private: false, access: { has: obj => "interruptByParent" in obj, get: obj => obj.interruptByParent }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        providers = (__runInitializers(this, _instanceExtraInitializers), new Map());
        continuations;
        /** Deployment contributions composed into unpublished continuable children. */
        setupRegistry = new SubagentActivationSetupRegistry();
        /**
         * The contained lifecycle-edge publisher. Built here because scoped dispatch
         * keys its carrier by this exact service instance, whose own context filter
         * composes into the carrier.
         */
        emitLifecycle;
        constructor(ctx) {
            super(ctx, 'subagents');
            this.emitLifecycle = createLifecycleEmitter(this.ctx, parent => scopeTarget(this, parent));
            ctx.inject(['agents'], (childCtx) => {
                const manager = new SubagentContinuationManager(childCtx, {
                    prepareContinuable: (name, request) => this.prepareContinuable(name, request),
                    observeActivation: (provider, childId, parent) => this.observeActivation(provider, childId, parent),
                }, this.setupRegistry);
                this.continuations = manager;
                childCtx.effect(() => () => {
                    /* v8 ignore else -- one injected binding owns the slot until its fiber disposes. */
                    if (this.continuations === manager)
                        this.continuations = undefined;
                }, 'subagents.continuationBinding()');
            });
            ctx.inject(['sessionProjections'], (projectionCtx) => {
                projectionCtx.sessionProjections.register(subagentTimingProjectionDefinition);
                projectionCtx.sessionProjections.register(subagentIdentityProjectionDefinition);
            });
        }
        /**
         * Establish one durable continuable child and deliver its initial prompt.
         * Resolves when the child's inbox accepts that prompt, without waiting for the
         * turn to start or for the message to reach the Session log; any earlier
         * failure rejects with no ids and rolls back the child entirely.
         * @param spec - provider, delegation request, and caller cancellation.
         * @returns the durable child id and the accepted prompt's message id.
         * @throws when continuation services are unavailable or materialization fails.
         */
        async startContinuable(spec) {
            return this.requireContinuations().startContinuable(spec);
        }
        /**
         * Deliver one later message to a continuable child as its next FIFO turn. A
         * resident child's Agent inbox accepts it directly (waking a `waiting`
         * Activation), while an absent one is cold-resumed from its persisted
         * Session. The Agent inbox is the only queue, so every accepted message has
         * one observable order.
         * @param parent - the exact live direct parent authorizing this delivery.
         * @param childId - durable child session id.
         * @param content - user-role content to deliver.
         * @param options - the message source fields and caller cancellation, which stops the
         *   operation only before inbox acceptance.
         * @returns the accepted message's inbox id.
         * @throws when continuation services are unavailable, parent authority is
         *   rejected, or the message was not admitted.
         */
        async followup(parent, childId, content, options) {
            return this.requireContinuations().followup(parent, childId, content, options);
        }
        /**
         * Interrupt one live continuable child's current turn under a human parent
         * address or an exact live ancestor Agent. Fire-and-return: the cancel
         * signal is issued before this returns, but the target may keep running
         * until it observes the signal. Unclaimed pending inbox work, the Activation,
         * and published descendants are preserved; claimed work is not requeued.
         * Once the interrupted driver is idle, a waking send resumes the parked FIFO
         * queue. An absent target — including a one-shot or unknown id —
         * is an accepted no-op, as is a manager-less composition, which cannot own a
         * live Activation.
         * @param targetSessionId - the durable child session id to interrupt.
         * @param authority - the human parent address or exact live ancestor Agent.
         * @throws {SubagentError} `UNAUTHORIZED` when the authority does not own the
         *   live target.
         */
        interrupt(targetSessionId, authority) {
            this.continuations?.interrupt(targetSessionId, authority);
        }
        /**
         * Deliver selected content from one live continuable child to its durable
         * direct parent. The child is the authority credential; callers cannot name a
         * recipient. Reporting does not conclude the child's turn or Activation.
         * @param child - exact live reporting child.
         * @param content - selected model-facing content.
         * @param options - parent scheduling and pre-acceptance cancellation.
         * @returns the stable identity of the parent-accepted message.
         * @throws when continuation services are unavailable, sender authorization
         *   fails, or the direct parent is not live.
         */
        async reportFrom(child, content, options) {
            return this.requireContinuations().reportFrom(child, content, options);
        }
        /**
         * Compose one deployment capability into every continuable child's
         * unpublished creation context on fresh creation and cold resume. Grants wait
         * for the next Activation; removing the contribution revokes every resident
         * installation immediately.
         * @param contribution - synchronous child-scope installer.
         * @returns the exact Cordis effect disposer.
         */
        registerContinuableSetup(contribution) {
            // oxlint-disable-next-line typescript/no-misused-promises -- synchronous disposer
            return this.ctx.effect(() => this.setupRegistry.register(contribution), 'subagents.registerContinuableSetup()');
        }
        /**
         * Close continuable admission below exact live parent Agents, stop only their
         * visible descendant Activations synchronously, then await admitted scoped
         * materializations and release those forests child-first. The scoped cutoff
         * lasts until each exact parent leaves the registry; unrelated parent trees
         * remain live.
         * @param parents - exact host-owned parent Agents entering teardown.
         * @returns once every retained descendant Activation released its `AgentHandle`.
         * @throws an aggregate error after all branches settle when any failed.
         */
        async drainContinuableDescendants(parents) {
            const manager = this.continuations;
            // Absent continuation services means nothing was ever materialized.
            if (manager === undefined)
                return;
            await manager.drainDescendants(parents);
        }
        /**
         * Release selected resident continuable direct children of one exact live
         * parent. Other children of the same parent remain admitted and resident.
         * Absent targets and a manager-less composition are accepted no-ops.
         * @param parent - exact live direct parent authorizing the selected release.
         * @param childIds - durable direct-child ids to release when resident.
         * @returns once every selected Activation released its `AgentHandle`.
         * @throws {SubagentError} `UNAUTHORIZED` when a resident target belongs to a
         *   different parent or the supplied parent identity is stale.
         */
        async drainContinuableChildren(parent, childIds) {
            const manager = this.continuations;
            if (manager === undefined)
                return;
            await manager.drainChildren(parent, childIds);
        }
        /**
         * Enumerate the parent's direct session-backed subagents without loading or
         * resuming an Agent. The Session query service supplies one live-preferred
         * corpus and shared point observations; the projection cache supplies
         * immutable descriptor hits without opening cold logs. The registered
         * `subagent` projection remains the sole mode/label classifier.
         *
         * Every query receives `signal`, and the listing rechecks cancellation
         * around each await. Read rejections that settle
         * after an abort become a stable `SubagentError` with code `CANCELLED`.
         * @param parentSessionId - parent session whose direct children are listed.
         * @param signal - caller-owned cancellation forwarded to Session queries
         *   and observed around every read await.
         * @returns children and per-child diagnostics ordered by `createdAt`, then id.
         * @throws {@link SubagentError} when the projection registry or the session
         *   store is not mounted, or the caller cancels the listing.
         */
        listChildren(parentSessionId, signal) {
            return listSubagentChildren(this.ctx, parentSessionId, signal);
        }
        /**
         * Enumerate the root's complete session-backed subagent tree in stable
         * pre-order from one live-preferred corpus, without loading or resuming an
         * Agent. Ordinary sessions and one-shot children remain traversal nodes so
         * continuable descendants below them are discovered; each returned entry
         * adds its durable `parentId` and root-relative `depth`. Identity resolution,
         * diagnostics, optional persistence, and cancellation follow the same
         * projection-backed contract as {@link listChildren}.
         * @param rootSessionId - session whose complete descendant tree is listed.
         * @param signal - caller-owned cancellation forwarded to persistence reads
         *   and observed around every read await.
         * @returns children and per-candidate diagnostics with tree position, in
         *   stable pre-order.
         * @throws {@link SubagentError} under the same conditions as {@link listChildren}.
         */
        listDescendants(rootSessionId, signal) {
            return listSubagentDescendants(this.ctx, rootSessionId, signal);
        }
        /**
         * Remote face of {@link listChildren} for one browser: the durable listing
         * plus live Agent activity and the delivery-time parent availability hint.
         * Parent availability is a hint; {@link prompt} performs the authoritative
         * check. Named apart from the provider-name {@link list}, which owns the
         * member.
         * @param parentSessionId - parent session whose direct children are listed.
         * @param signal - carrier cancellation forwarded to Session queries.
         * @returns the catalog view for that parent.
         * @throws {TypertRemoteFailure} `bad-request` for an empty parent id,
         *   `cancelled` for an aborted read, `subagent-projections-unavailable` when
         *   the deployment has no projection registry, otherwise `internal`.
         */
        async remoteExportList(parentSessionId, signal) {
            validateControlRequest('subagent.list', { parentSessionId });
            try {
                return catalogView(this.ctx, parentSessionId, await this.listChildren(parentSessionId, signal));
            }
            catch (error) {
                return rejectCatalogRead(error, signal);
            }
        }
        /**
         * Deliver one browser-authored message to a continuable child through the
         * exact live direct parent, retaining the caller-minted request identity and
         * validated browser zone on the accepted message. Success identifies the
         * message the child's FIFO inbox accepted; later execution is independent of
         * this call.
         * @param request - durable address, minted identity, content, and optional browser zone.
         * @param signal - carrier cancellation, owning the call until inbox acceptance.
         * @returns the accepted message's inbox identity.
         * @throws {TypertRemoteFailure} `bad-request`, `invalid-time-zone`,
         *   `subagent-parent-unavailable`, `subagent-not-resumable`,
         *   `subagent-unauthorized`, `subagent-delivery-unavailable`, `cancelled`, or
         *   `internal`.
         */
        async prompt(request, signal) {
            const { parentSessionId, childSessionId, clientTimeZone } = request;
            validateControlRequest('subagent.prompt', request);
            const canonicalTimeZone = clientTimeZone === undefined
                ? undefined
                : canonicalClientTimeZone(clientTimeZone);
            if (clientTimeZone !== undefined && canonicalTimeZone === undefined) {
                return rejectControl('invalid-time-zone', 'clientTimeZone must be UTC or a valid IANA Area/Location name', { value: clientTimeZone });
            }
            const parent = this.ctx.get('agents')?.get(parentSessionId);
            if (parent === undefined) {
                return rejectControl('subagent-parent-unavailable', `parent session "${parentSessionId}" is not live`, { parentSessionId });
            }
            const source = {
                kind: 'user',
                rpcId: request.requestId,
                ...(canonicalTimeZone === undefined ? {} : { clientTimeZone: canonicalTimeZone }),
            };
            const content = [...request.content];
            try {
                return { messageId: await this.followup(parent, childSessionId, content, { source, signal }) };
            }
            catch (error) {
                return rejectPrompt(error, childSessionId, signal);
            }
        }
        /**
         * Remote face of {@link interrupt} under one durable parent address. No
         * catalog, history, persistence, or parent Agent lookup runs: the core
         * primitive alone authorizes the address against the live Activation, which
         * is what keeps a live child interruptible while its parent Agent is offline.
         * Absent, idle, and already-completed targets are accepted no-ops there.
         * @param childSessionId - durable child session id to interrupt.
         * @param parentSessionId - durable direct parent whose authority is claimed.
         * @param mode - required continuable-address discriminator.
         * @returns acknowledgement that the cancel signal was admitted, not that the target is quiescent.
         * @throws {TypertRemoteFailure} `bad-request` for an empty id,
         *   `subagent-unauthorized` when the address does not own the live target,
         *   otherwise `internal`.
         */
        interruptByParent(childSessionId, parentSessionId, mode) {
            validateControlRequest('subagent.interrupt', { childSessionId, parentSessionId, mode });
            try {
                this.interrupt(childSessionId, { kind: 'user', parentSessionId });
            }
            catch (error) {
                if (error instanceof SubagentError && error.code === 'UNAUTHORIZED') {
                    return rejectControl('subagent-unauthorized', 'subagent does not belong to this parent', { childSessionId });
                }
                return rejectControl('internal', 'subagent interrupt failed', {});
            }
            return { accepted: true };
        }
        /**
         * Register a provider under its name. Registration is effect-scoped and HMR
         * safe; removing a provider blocks new starts but does not revoke runs that
         * were already returned to their holders.
         * @param provider - the trusted provider implementation.
         * @returns the exact Cordis effect disposer.
         */
        registerProvider(provider) {
            const name = provider.name;
            // oxlint-disable-next-line typescript/no-misused-promises -- synchronous disposer
            return this.ctx.effect(function* () {
                if (this.providers.has(name)) {
                    throw new SubagentError(`a subagent provider named "${name}" is already registered`, 'DUPLICATE_PROVIDER');
                }
                this.providers.set(name, provider);
                yield () => {
                    this.providers.delete(name);
                    this.emitLifecycle('subagent/provider-removed', name);
                };
                // A throwing added-listener unwinds the yielded rollback, matching the
                // repository's fail-loud registration semantics.
                this.ctx.emit('subagent/provider-added', provider);
            }.bind(this), 'subagents.registerProvider()');
        }
        /**
         * Look up a provider by name.
         * @param name - the provider name.
         * @returns the provider, or undefined when absent.
         */
        getProvider(name) {
            return this.providers.get(name);
        }
        /**
         * List registered provider names in insertion order.
         * @returns the registered names.
         */
        list() {
            return [...this.providers.keys()];
        }
        /**
         * Establish a published child on the named provider. Capability and semantic
         * checks run before delegation. Provider ownership lasts until its promise
         * fulfills; a rejection therefore has no run for the caller to dispose and
         * emits no run lifecycle events. Post-publication turn and infrastructure
         * failures settle through the returned run.
         * @param name - the provider to use.
         * @param request - child label, prompt, parent, signal, and optional capabilities.
         * @returns the published holder-owned run.
         */
        async start(name, request) {
            const provider = this.expectProvider(name);
            this.assertCapabilities(provider, request);
            assertSubagentMaxDepth(request.maxDepth);
            if (request.outputSchema !== undefined)
                assertObjectJsonSchema(request.outputSchema);
            const descriptor = snapshotSubagentDescriptor({
                mode: 'one-shot',
                provider: name,
                ...request.label !== undefined ? { label: request.label } : {},
            });
            const resolved = { ...request, descriptor };
            return observeRun(this.emitLifecycle, name, request.parent, await provider.start(resolved));
        }
        /**
         * Resolve one provider's detached continuable-creation contribution. Method
         * presence on the provider IS the capability, so a provider without it is
         * rejected before the manager reserves any child resources.
         */
        async prepareContinuable(name, request) {
            const provider = this.expectProvider(name);
            if (provider.prepareContinuable === undefined) {
                throw new SubagentError(`subagent provider "${provider.name}" does not support continuable children `
                    + '(no prepareContinuable capability)', 'UNSUPPORTED_CAPABILITY');
            }
            return provider.prepareContinuable(request);
        }
        /** Look up a provider for dispatch or fail loud. */
        expectProvider(name) {
            const provider = this.providers.get(name);
            if (provider === undefined) {
                throw new SubagentError(`no subagent provider registered for "${name}"`, 'NO_PROVIDER');
            }
            return provider;
        }
        /** Resolve the optional continuable-subagent manager or fail loud. */
        requireContinuations() {
            if (this.continuations === undefined) {
                throw new SubagentError('continuable subagents require the agents service', 'CONTINUATION_UNAVAILABLE');
            }
            return this.continuations;
        }
        /**
         * Build the lifecycle observer for one continuable Activation's residency
         * epoch, so the manager publishes its edges without owning event dispatch.
         */
        observeActivation(provider, childId, parent) {
            return createActivationObserver(this.emitLifecycle, provider, childId, parent);
        }
        /** Reject the first requested capability that the provider lacks. */
        assertCapabilities(provider, request) {
            const needs = [
                { when: request.agentOptions !== undefined, cap: 'agentOptions' },
                { when: request.outputSchema !== undefined, cap: 'outputSchema' },
                { when: request.maxDepth !== undefined, cap: 'depthLimit' },
                { when: request.toolFilter !== undefined, cap: 'toolFilter' },
                { when: request.persona !== undefined, cap: 'persona' },
            ];
            for (const { when, cap } of needs) {
                if (when && !provider.capabilities[cap]) {
                    throw new SubagentError(`subagent provider "${provider.name}" does not support the "${cap}" capability`, 'UNSUPPORTED_CAPABILITY');
                }
            }
        }
    };
})();
export { SubagentRuntime };
export default SubagentRuntime;
//# sourceMappingURL=index.js.map