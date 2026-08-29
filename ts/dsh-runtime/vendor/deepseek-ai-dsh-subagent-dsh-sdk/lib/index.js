import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { AssistantOutputFold, NO_START_CAPABILITIES, assertPositiveFinite, resolveChildCwd, settleRunResult, subprocessRunHandle, validateConfiguredCwd } from "@deepseek-ai/dsh-subagent";
import { randomUUID } from "node:crypto";
import { DeepSeekHarness, JsonRpcResponseError, SdkProtocolError, TransportClosedError } from "@deepseek-ai/dsh-sdk-client";
import { SessionId } from "@deepseek-ai/dsh-session";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
//#region lib/types/run.js
/**
* Fresh-process SDK subagent client. Drives one child DeepSeek Harness
* runtime over stdio JSON-RPC through `@deepseek-ai/dsh-sdk-client` and owns
* cancellation and quiescent disposal. It publishes after the child
* handshake, maps child failures to stop reasons, and tears down to
* quiescence. The SDK client spawns the child rather than using
* `ctx.subprocess` — the subprocess seam's documented exception for
* SDK-managed transports — so this driver applies the seam's shared env scrub.
*
* @module @deepseek-ai/dsh-subagent-dsh-sdk/run
*/
/** EOF grace for child flush and nested-process teardown; wider than the signal grace below. */
const DEFAULT_DISPOSE_EOF_GRACE_MS = 6e3;
/** Default POSIX grace between SIGTERM and SIGKILL on dispose (the `disposeGraceMs` config). */
const DEFAULT_DISPOSE_GRACE_MS = 3e3;
/** Default bound on the protocol `shutdown` exchange during dispose. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1e3;
/** Fixed safe failure text derived only from provider-owned structured facts. */
function failureDiagnostic(facts) {
	return `Subagent failure (${[
		"provider: DSH SDK",
		`stage: ${facts.stage}`,
		`category: ${facts.category}`
	].join("; ")})`;
}
var SdkRunFailure = class extends Error {
	facts;
	constructor(facts, cause) {
		super(`subagent-dsh-sdk: ${failureDiagnostic(facts)}`, { cause });
		this.facts = facts;
		this.name = "SdkRunFailure";
	}
};
/** Runtime constructor seam replaced only by package-local fake-runtime tests. */
const internals = { createHarness: (options) => new DeepSeekHarness(options) };
/**
* Hide a pre-spawn workspace/configuration failure behind fixed safe facts.
* @param cause - original Host failure retained on the Error cause chain.
* @returns an Error whose message contains only the fixed DSH SDK failure line.
*/
function sdkConfigurationFailure(cause) {
	return new SdkRunFailure({
		stage: "initialize",
		category: "configuration"
	}, cause);
}
/** Classify one SDK rejection without reading its message or stderr tail. */
function sdkFailure(error, stage) {
	return new SdkRunFailure(error instanceof TransportClosedError ? {
		stage,
		category: "transport"
	} : error instanceof SdkProtocolError || error instanceof JsonRpcResponseError ? {
		stage,
		category: "protocol"
	} : {
		stage,
		category: "unknown"
	}, error);
}
/**
* Map one child terminal reason to its complete shared result outcome.
* @param reason - the owned child run's final durable turn reason, or
* `undefined` when it settled without running a turn.
* @returns the shared stop reason and any additional safe diagnostic.
*/
function sdkChildOutcome(reason) {
	switch (reason?.kind) {
		case "completed": return { stopReason: "completed" };
		case "max-tokens": return { stopReason: "max-tokens" };
		case "aborted": return reason.reason.kind === "disposed" ? {
			stopReason: "aborted",
			diagnostic: failureDiagnostic({
				stage: "session-run",
				category: "child-disposed"
			})
		} : { stopReason: "aborted" };
		case "blocked": return { stopReason: "refusal" };
		case "error": return {
			stopReason: "error",
			diagnostic: failureDiagnostic({
				stage: "session-run",
				category: "child-error"
			})
		};
		case "interrupted": return { stopReason: "error" };
		case void 0: return {
			stopReason: "error",
			diagnostic: failureDiagnostic({
				stage: "session-run",
				category: "missing-terminal"
			})
		};
		default: return {
			stopReason: "error",
			diagnostic: failureDiagnostic({
				stage: "session-run",
				category: "child-unknown"
			})
		};
	}
}
/** Normalize an unknown thrown value to an Error (the catch binding is `unknown`). */
function toError(value) {
	/* v8 ignore next */
	return value instanceof Error ? value : new Error(String(value));
}
/** Report an original Host failure without letting the observation sink replace it. */
function reportFailure(spec, error) {
	try {
		spec.onError?.(toError(error), "error");
	} catch {}
}
/** Map an SDK-owned failed-start aggregate into safe initialize/shutdown lines. */
function sdkStartupFailure(spec, error) {
	if (!(error instanceof AggregateError) || error.errors.length < 2) {
		reportFailure(spec, error);
		return sdkFailure(error, "initialize");
	}
	const initializeError = error.errors[0];
	const cleanupError = error.errors[1];
	reportFailure(spec, initializeError);
	reportFailure(spec, cleanupError);
	const initializeFailure = sdkFailure(initializeError, "initialize");
	const cleanupFailure = new SdkRunFailure({
		stage: "shutdown",
		category: "unknown"
	}, cleanupError);
	return new AggregateError([initializeFailure, cleanupFailure], `${initializeFailure.message}; ${cleanupFailure.message}`);
}
/**
* Start and publish one SDK runtime child after its `initialize` handshake.
* Child failures resolve through the run result. Startup rejects with fixed
* safe facts after SDK-owned cleanup; successful cleanup proves process reap.
* Cleanup failure preserves initialize plus shutdown for an ordinary failure,
* or shutdown alone after cancellation, without claiming quiescence. Disposal
* shuts the runtime down and reaps it.
* @param request - the start request; its signal is the cancellation channel.
* @param spec - the resolved spawn spec: profile/patches/home/cwd, the child's
* provider/model/reasoning route, output cap, env, timeouts, and the optional
* error sink.
* @returns the ready run handle for the child subprocess.
*/
async function startSdkRun(request, spec) {
	if (request.signal.aborted) throw new Error("subagent request was aborted before the SDK child started");
	const id = SessionId(randomUUID());
	const harness = internals.createHarness({
		...spec.dshBin === void 0 ? {} : { dshBin: spec.dshBin },
		profile: spec.profile,
		patches: spec.patches,
		dshHome: spec.dshHome,
		processCwd: spec.cwd,
		env: {
			...scrubbedParentEnv(),
			...spec.env
		},
		shutdownTimeoutMs: spec.shutdownTimeoutMs,
		disposeEofGraceMs: spec.disposeEofGraceMs,
		disposeGraceMs: spec.disposeGraceMs,
		cwd: spec.cwd,
		provider: spec.provider,
		model: spec.model,
		...spec.reasoningEffort === void 0 ? {} : { reasoningEffort: spec.reasoningEffort },
		...spec.maxTokens === void 0 ? {} : { maxTokens: spec.maxTokens }
	});
	const flags = { cancelled: false };
	let signalCancelSettled;
	const cancelSettled = new Promise((resolve) => {
		signalCancelSettled = resolve;
	});
	const requestCancel = () => {
		if (flags.cancelled) return;
		flags.cancelled = true;
		signalCancelSettled();
	};
	const onAbort = () => {
		requestCancel();
	};
	request.signal.addEventListener("abort", onAbort, { once: true });
	const cancelledStartup = /* @__PURE__ */ new Error("subagent cancelled before the SDK child initialized");
	try {
		await Promise.race([harness.start(), cancelSettled.then(() => {
			throw cancelledStartup;
		})]);
		/* v8 ignore next */
		if (flags.cancelled) throw cancelledStartup;
	} catch (error) {
		request.signal.removeEventListener("abort", onAbort);
		if (error !== cancelledStartup) throw sdkStartupFailure(spec, error);
		try {
			await harness.close();
		} catch (cleanupError) {
			reportFailure(spec, cleanupError);
			const cleanupFailure = new SdkRunFailure({
				stage: "shutdown",
				category: "unknown"
			}, cleanupError);
			throw new AggregateError([cleanupFailure], cleanupFailure.message);
		}
		throw new Error("subagent request was aborted before the SDK child started");
	}
	const childSessionId = `session-${randomUUID().replaceAll("-", "")}`;
	const fold = new AssistantOutputFold();
	const observe = (notification) => {
		if (notification.method !== "session.event" || notification.params.sessionId !== childSessionId) return;
		fold.push(notification.params.event);
	};
	const collectOutput = () => fold.collect() ?? [];
	const teardown = async () => {
		try {
			await harness.close();
		} catch (error) {
			reportFailure(spec, error);
			throw new SdkRunFailure({
				stage: "shutdown",
				category: "unknown"
			}, error);
		}
	};
	let diagnostic;
	return subprocessRunHandle({
		id,
		result: settleRunResult({
			attempt: async () => {
				try {
					const turn = await Promise.race([harness.session(childSessionId).run(request.prompt, { onNotification: observe }), cancelSettled.then(() => "cancelled")]);
					if (turn === "cancelled") return {
						output: collectOutput(),
						stopReason: "aborted"
					};
					const outcome = sdkChildOutcome(turn.events.findLast((event) => event.type === "turn/end")?.data.reason);
					diagnostic = outcome.diagnostic;
					return {
						output: collectOutput(),
						...outcome
					};
				} catch (error) {
					diagnostic = failureDiagnostic(sdkFailure(error, "session-run").facts);
					throw error;
				}
			},
			collectOutput,
			collectDiagnostic: () => diagnostic,
			cancelled: () => flags.cancelled,
			onError: spec.onError,
			signal: request.signal,
			onAbort
		}),
		signal: request.signal,
		onAbort,
		requestCancel,
		teardown
	});
}
//#endregion
//#region lib/types/index.js
/**
* Out-of-process SDK subagent backend. Each child is a complete DeepSeek
* Harness runtime in its own process — own named profile and patch composition,
* session, model route, and tools — driven over stdio JSON-RPC through the
* TypeScript SDK client, so it shares no Cordis context. It accepts the
* provider/model/reasoning/maxTokens subset of `agentOptions`; other start
* features remain unsupported. The ONE thing it reads off `request.parent`
* is the session's workspace cwd. This plugin uses named
* exports only; a default would hide its loader metadata (see
* `docs/postmortem/0001-acp-default-export-drops-inject.md`).
* @module @deepseek-ai/dsh-subagent-dsh-sdk
*/
const name = "subagent-dsh-sdk";
const inject = ["subagents"];
const Config = z.object({
	providerName: z.string().default("dsh-sdk"),
	dshBin: z.string(),
	profile: z.string().default("sdk"),
	patches: z.array(z.string()).default([]),
	dshHome: z.string().required(),
	cwd: z.string(),
	provider: z.string().default("deepseek-official"),
	model: z.string().default("deepseek-v4-flash"),
	maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
	env: z.dict(z.string()).default({}),
	shutdownTimeoutMs: z.number().default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
	disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
	disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS)
});
/** Resolve one configured runtime file against the harness launch directory and require a regular file. */
function resolveConfiguredFile(field, value) {
	const path = resolve(value);
	try {
		if (statSync(path).isFile()) return path;
	} catch {}
	throw new TypeError(`subagent-dsh-sdk ${field} must name an existing file: ${path}`);
}
/** DSH SDK can apply Agent route options while the other start features remain child-owned. */
const SDK_START_CAPABILITIES = Object.freeze({
	...NO_START_CAPABILITIES,
	agentOptions: true
});
/** Merge the request's supported route fields over this provider instance's defaults. */
function resolveSdkRoute(config, requested) {
	const maxTokens = requested?.maxTokens ?? config.maxTokens;
	return {
		provider: requested?.provider ?? config.provider,
		model: requested?.model ?? config.model,
		...requested?.reasoningEffort === void 0 ? {} : { reasoningEffort: requested.reasoningEffort },
		...maxTokens === void 0 ? {} : { maxTokens }
	};
}
/**
* The SDK provider. It resolves Agent route options into the child runtime's
* process-wide handshake; output schema, depth, tool filter, and persona stay
* unsupported because their ownership does not cross this process boundary.
*/
var SdkSubagentProvider = class {
	name;
	ctx;
	config;
	capabilities = SDK_START_CAPABILITIES;
	agentRouteDefaults;
	inheritsParentContext = false;
	constructor(name, ctx, config) {
		this.name = name;
		this.ctx = ctx;
		this.config = config;
		this.agentRouteDefaults = Object.freeze({
			provider: config.provider,
			model: config.model
		});
	}
	start(request) {
		if (request.signal.aborted) throw new Error("subagent request was aborted before the SDK child started");
		let cwd;
		try {
			cwd = resolveChildCwd("subagent-dsh-sdk", this.config.cwd, request.parent.session.header.cwd);
		} catch (error) {
			const failure = sdkConfigurationFailure(error);
			this.ctx.logger.warn(`subagent-dsh-sdk "${this.name}": child start failed: %o`, error);
			throw failure;
		}
		const route = resolveSdkRoute(this.config, request.agentOptions);
		return startSdkRun(request, {
			...this.config.dshBin === void 0 ? {} : { dshBin: this.config.dshBin },
			profile: this.config.profile,
			patches: this.config.patches,
			dshHome: this.config.dshHome,
			cwd,
			...route,
			env: this.config.env,
			shutdownTimeoutMs: this.config.shutdownTimeoutMs,
			disposeEofGraceMs: this.config.disposeEofGraceMs,
			disposeGraceMs: this.config.disposeGraceMs,
			onError: (error, stopReason) => {
				this.ctx.logger.warn(`subagent-dsh-sdk "${this.name}": child run failed (${stopReason}): ${error.message}`);
			}
		});
	}
};
function apply(ctx, config) {
	const resolved = config;
	assertPositiveFinite("subagent-dsh-sdk", "shutdownTimeoutMs", resolved.shutdownTimeoutMs);
	assertPositiveFinite("subagent-dsh-sdk", "disposeEofGraceMs", resolved.disposeEofGraceMs);
	assertPositiveFinite("subagent-dsh-sdk", "disposeGraceMs", resolved.disposeGraceMs);
	if (resolved.maxTokens !== void 0 && (!Number.isSafeInteger(resolved.maxTokens) || resolved.maxTokens <= 0)) throw new TypeError("subagent-dsh-sdk maxTokens must be a positive safe integer");
	if (!isAbsolute(resolved.dshHome)) throw new TypeError("subagent-dsh-sdk dshHome must be an absolute path");
	const launchPaths = {
		...resolved,
		patches: resolved.patches.map((path, index) => resolveConfiguredFile(`patches[${String(index)}]`, path)),
		...resolved.dshBin === void 0 ? {} : { dshBin: resolveConfiguredFile("dshBin", resolved.dshBin) }
	};
	const configuredCwd = validateConfiguredCwd("subagent-dsh-sdk", resolved.cwd);
	const validated = configuredCwd === void 0 ? launchPaths : {
		...launchPaths,
		cwd: configuredCwd
	};
	ctx.subagents.registerProvider(new SdkSubagentProvider(validated.providerName, ctx, validated));
}
//#endregion
export { Config, apply, inject, name };
