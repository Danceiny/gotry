import { resolve } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { canonicalPath } from "@deepseek-ai/dsh-sandbox";
//#region lib/types/session-mode.js
/**
* Per-session sandbox-mode override: the session log as the store. A runtime
* switch (a UI policy control or test scenario) is recorded as one
* `sandbox/mode` event on the session it applies to;
* `effective = fold(events) ?? the deployment default`, so an override
* survives restart by replay, two sessions can never see each other's state,
* and there is no external config store. The event is log-only (the
* `approval/*` precedent): the policy owner projects the fold into each model
* request, while enforcing tools report operation-specific boundary markers.
* EXECUTION honors the same fold through `ctx.sandboxPolicy.resolve()` — it
* stamps the mode together with the calling session's workspace root onto each
* capability call, weakest-precedence beneath an escalation grant.
*
* The override is policy state shared by every enforcing family (bash and
* filesystem alike), so it lives here in the policy package rather than in any
* one capability's seam.
*
* @module dsh-sandbox-policy/session-mode
*/
/** Every {@link SandboxMode}, for option advertisement and runtime validation of untrusted mode strings. */
const SANDBOX_MODES = [
	"read-only",
	"workspace-write",
	"danger-full-access"
];
/**
* The session's sandbox-mode override: the last `sandbox/mode` event in the
* log, or undefined when the session never switched (callers apply the
* deployment default). The pure fold — resume needs no catch-up machinery
* because replaying the log IS the state.
* @param events - session events in log order (other event types are skipped).
* @returns the mode of the last switch event, or undefined without one.
*/
function effectiveSandboxMode(events) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event.type === "sandbox/mode") return event.data.mode;
	}
}
/**
* THE write path for a session's sandbox-mode override: appends exactly one
* `sandbox/mode` event — the switch IS its event; nothing mutates mode state
* out of band. Takes effect on the session's next confined call (bash or fs)
* — the consumers fold on every read.
* @param session - the session the override belongs to.
* @param mode - the mode every subsequent confined call in this session runs
*   under (until the next switch).
*/
function setSandboxMode(session, mode) {
	session.append("sandbox/mode", { mode });
}
//#endregion
//#region lib/types/index.js
/**
* The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
* deployment's sandbox fallbacks plus per-session resolution: the file-effect
* {@link SandboxMode}, the `workspace-write` root, and the override kit (the
* `sandbox/mode` event, its fold, and its write path, from `./session-mode.ts`).
* Before each agent request, the owner also contributes the resolved policy to
* the cache-safe runtime-context snapshot. The agent loop logs that snapshot as
* model history, so replay reconstructs the same mode and root the enforcing
* consumers resolve without rewriting the stable system prompt.
*
* Enforcing filesystem, one-shot bash, and terminal backends read the SAME
* resolved policy here. The context describes that policy without inventorying
* capabilities, while each backend retains its own enforcement dialect and each
* tool owns its operation-specific denial and escalation guidance. The service
* reads session state once at each operation boundary; executors and providers
* remain session-free.
*
* @module @deepseek-ai/dsh-sandbox-policy
*/
/** Resolve filesystem identity before lexical normalization can erase symlink-sensitive components. */
function resolveWorkspaceRoot(path) {
	return resolve(canonicalPath(path));
}
/** Render the policy without claiming which capabilities are mounted. */
function renderPolicyContext(policy) {
	switch (policy.mode) {
		case "read-only": return "Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.";
		case "workspace-write": return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}. Some platform temporary areas may also be writable.`;
		case "danger-full-access": return "Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.";
		/* v8 ignore next 4 -- SandboxMode is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
		default: {
			const mode = policy.mode;
			throw new Error(`unreachable sandbox mode: ${String(mode)}`);
		}
	}
}
/**
* The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment
* default mode, fallback workspace root, and current request-time policy
* section. Tool layers call {@link resolve} for each execution so a session's
* mode log and immutable cwd travel together to every enforcing capability.
*/
var SandboxPolicyService = class extends Service {
	static Config = z.object({
		mode: z.union([
			"read-only",
			"workspace-write",
			"danger-full-access"
		]).default("read-only"),
		workspaceRoot: z.string()
	});
	/** The deployment default mode — the fallback beneath a session override. */
	defaultMode;
	/** The absolute `workspace-write` fallback root for calls without a session cwd. */
	workspaceRoot;
	constructor(ctx, config) {
		super(ctx, "sandboxPolicy");
		this.defaultMode = config.mode;
		this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd());
		ctx.inject(["systemPrompt"], (scope) => {
			scope.systemPrompt.context({
				name: "sandbox:policy",
				order: 110,
				text: (context) => {
					const session = context.agent?.session;
					return session === void 0 ? "" : renderPolicyContext(this.resolve({ session }));
				}
			});
		});
	}
	/**
	* Resolve the complete policy for one capability call. An approved explicit
	* mode outranks the session's last `sandbox/mode` event, which outranks the
	* deployment default. A session cwd is its workspace-write boundary; the
	* configured root is the fallback for agentless calls and sessions without a
	* cwd.
	* @param request - optional session and approved mode override.
	* @returns the fully resolved per-call mode and absolute workspace root.
	*/
	resolve(request = {}) {
		const { session } = request;
		return {
			mode: request.mode ?? (session === void 0 ? void 0 : this.overrideOf(session)) ?? this.defaultMode,
			workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),
			...session === void 0 ? {} : { sessionId: session.id }
		};
	}
	/**
	* Read the session override without applying the deployment default.
	* @param session - session whose log supplies the override.
	* @returns the last logged mode, or `undefined` without one.
	*/
	overrideOf(session) {
		return effectiveSandboxMode(session.events);
	}
};
//#endregion
export { SANDBOX_MODES, SandboxPolicyService, SandboxPolicyService as default, effectiveSandboxMode, setSandboxMode };
