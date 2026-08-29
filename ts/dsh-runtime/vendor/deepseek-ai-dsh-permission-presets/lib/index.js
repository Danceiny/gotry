import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { SANDBOX_MODES, effectiveSandboxMode, setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { APPROVAL_POLICIES, effectiveApprovalPolicy, setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
//#region lib/types/index.js
/**
* User-facing permission presets over the independent sandbox-mode and
* approval-policy knobs. A switch records the selected preset, then writes
* changed knobs through their canonical setters. Execution, prompt narration,
* and replay keep reading their knob folds. The preset event preserves user
* intent when two presets share a bundle. The read side ships as the
* `permissions` session projection; the write side ships as the
* `/permission` command — both optional children over the same service.
*
* @module dsh-permission-presets
*/
/**
* Returned when effective knob values match no table entry. Clients may show
* it as the current value, but it is never a switch target or event payload.
*/
const CUSTOM_PRESET = "custom";
/** Settings namespace carrying the default for future sessions. */
const PERMISSION_SETTINGS_NAMESPACE = settingsNamespace("permission");
/**
* Fold the last selected preset from the durable log; replay needs no catch-up
* state.
* @param events - session events in log order; other event types are ignored.
* @returns the last selected preset, or undefined when none was recorded.
*/
function effectivePermissionPreset(events) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event.type === "permission/preset") return event.data.preset;
	}
}
const knobStateSchema = z$1.object({
	preset: z$1.string().nullable(),
	sandbox: z$1.union([
		z$1.literal("read-only"),
		z$1.literal("workspace-write"),
		z$1.literal("danger-full-access")
	]).nullable(),
	approval: z$1.union([z$1.literal("ask"), z$1.literal("never")]).nullable()
}).strict();
/** State for the empty log: every knob at its composition default. */
const EMPTY_KNOBS = {
	preset: null,
	sandbox: null,
	approval: null
};
/**
* One-event knob transition (the projection unit's `apply`). Uninterested
* events return the same reference — the registry's change gate.
* @param state - the folded knob state before `event`.
* @param event - one committed session event.
* @returns the next state; the same reference when the event is not a knob.
*/
function applyKnobEvent(state, event) {
	switch (event.type) {
		case "permission/preset": return {
			...state,
			preset: event.data.preset
		};
		case "sandbox/mode": return {
			...state,
			sandbox: event.data.mode
		};
		case "approval/policy": return {
			...state,
			approval: event.data.policy
		};
		default: return state;
	}
}
/** Whole-log knob fold (the cold-read parallel of {@link applyKnobEvent}). */
function foldKnobs(events) {
	let state = EMPTY_KNOBS;
	for (const event of events) state = applyKnobEvent(state, event);
	return state;
}
/**
* Owns the deployment's permission presets and their write path. Requires a
* confining `ctx.shell` executor and `ctx.approval`; unmatched knob values are
* reported as {@link CUSTOM_PRESET}, not an error.
*/
var PermissionPresetService = class extends Service {
	static Config = z.object({
		presets: z.dict(z.object({
			sandbox: z.union(SANDBOX_MODES).required(),
			approval: z.union(APPROVAL_POLICIES).required(),
			name: z.string(),
			description: z.string()
		})).default({
			"workspace-write": {
				sandbox: "workspace-write",
				approval: "ask",
				name: "workspace-write",
				description: "Write inside the workspace and permitted temporary directories; wider retries require approval."
			},
			"danger-full-access": {
				sandbox: "danger-full-access",
				approval: "never",
				name: "danger-full-access",
				description: "Full file access without approval prompts."
			}
		}),
		defaultPreset: z.string()
	});
	static inject = [
		"shell",
		"approval",
		"sessions"
	];
	presets;
	defaultSettings;
	constructor(ctx, config) {
		super(ctx, "permissionPresets");
		this.presets = config.presets;
		if ("custom" in this.presets) throw new Error(`permission: "${CUSTOM_PRESET}" is reserved for the derived not-a-preset state and cannot name a table entry`);
		if (ctx.shell.sandboxMode === void 0) throw new Error("permission: the mounted bash executor does not confine (no sandboxMode) — presets bundle a sandbox mode, so composing this plugin over an unconfined executor is a misconfiguration");
		const inferredDefault = this.derive(EMPTY_KNOBS);
		const defaultPreset = config.defaultPreset ?? inferredDefault;
		if (defaultPreset === "custom") throw new Error("permission: composed sandbox and approval defaults match no preset; configure defaultPreset explicitly");
		this.resolve(defaultPreset);
		const baseSettings = { defaultPreset };
		this.defaultSettings = () => baseSettings;
		const presetChoices = this.names.map((name) => {
			const choice = z.const(name);
			const label = this.presets[name]?.name;
			return label === void 0 ? choice : choice.description(label);
		});
		installSettingsSection(ctx, PERMISSION_SETTINGS_NAMESPACE, z.object({ defaultPreset: z.union(presetChoices).required() }), baseSettings, {
			setSource: (current) => {
				this.defaultSettings = current;
			},
			onChange: () => {}
		});
		ctx.on("session/created", (session) => {
			this.pinInitialPermission(session);
		});
		for (const session of ctx.sessions.list()) this.pinInitialPermission(session);
		const selectSchema = z$1.object({
			options: z$1.array(z$1.object({
				value: z$1.string().min(1),
				name: z$1.string().min(1),
				description: z$1.string().optional()
			})),
			currentValue: z$1.string().min(1)
		});
		ctx.inject(["sessionProjections"], (projectionCtx) => {
			projectionCtx.sessionProjections.register({
				key: "permissions",
				stateSchema: knobStateSchema,
				init: () => EMPTY_KNOBS,
				apply: applyKnobEvent,
				wire: {
					viewSchema: selectSchema,
					view: (state) => this.selectFor(state)
				},
				stateVersion: 1
			});
		});
		ctx.inject(["commands"], (commandCtx) => {
			commandCtx.commands.register({
				name: "permission",
				description: "Switch the permission preset (sandbox mode + approval policy)",
				input: { hint: "<preset>" },
				handler: ({ agent, rawInput }) => {
					const name = rawInput.trim();
					if (name === "") return {
						kind: "success",
						text: `current preset ${this.current(agent.session.events)} (available: ${this.names.join(", ")})`
					};
					if (!this.names.includes(name)) return {
						kind: "error",
						text: `unknown preset "${name}" (available: ${this.names.join(", ")})`
					};
					this.apply(agent.session, name, (policy) => {
						this.ctx.approval.setPolicy(agent, policy);
					});
					return {
						kind: "success",
						text: `preset ${name}`
					};
				}
			});
		});
	}
	/**
	* The advertised preset names, in the preset table's declaration order.
	* @returns every switchable preset name.
	*/
	get names() {
		return Object.keys(this.presets);
	}
	/**
	* The preset currently selected as the default for future sessions.
	* @returns the resolved settings value, or the composition default without
	* a mounted settings provider.
	*/
	get defaultPreset() {
		return this.defaultSettings().defaultPreset;
	}
	/**
	* Resolve the preset matching the effective knob values. A still-matching
	* last selection wins shared-bundle ties; otherwise the first table match
	* wins, or {@link CUSTOM_PRESET} when no entry matches.
	* @param events - the session's events in log order.
	* @returns the effective preset name, or `custom` when nothing matches.
	*/
	current(events) {
		return this.derive(foldKnobs(events));
	}
	/** Resolve the preset for one folded knob state (the shared mathematics of `current` and the projection unit). */
	derive(state) {
		const sandbox = state.sandbox ?? this.ctx.shell.sandboxMode;
		const approval = state.approval ?? this.ctx.approval.config.policy ?? "ask";
		const matches = (spec) => spec.sandbox === sandbox && spec.approval === approval;
		if (state.preset !== null) {
			const spec = this.presets[state.preset];
			if (spec !== void 0 && matches(spec)) return state.preset;
		}
		for (const [name, spec] of Object.entries(this.presets)) if (matches(spec)) return name;
		return CUSTOM_PRESET;
	}
	/**
	* Build the whole select value for one folded knob state: every table
	* option in declaration order, `custom` appended exactly while derived.
	* @param state - the folded knob overrides.
	* @returns the `permissions` projection payload.
	*/
	selectFor(state) {
		const currentValue = this.derive(state);
		return {
			options: [...this.names.map((name) => this.optionOf(name)), ...currentValue === "custom" ? [this.optionOf(CUSTOM_PRESET)] : []],
			currentValue
		};
	}
	/**
	* Resolve a preset's knob bundle.
	* @param name - the preset name to resolve.
	* @returns the configured bundle.
	* @throws when `name` is not in the table.
	*/
	resolve(name) {
		const spec = this.presets[name];
		if (spec === void 0) throw new Error(`permission: unknown preset "${name}" (known: ${Object.keys(this.presets).join(", ")})`);
		return spec;
	}
	/**
	* Build the client option for a table entry or {@link CUSTOM_PRESET}. A
	* missing label falls back to the table key.
	* @param name - a table key, or `custom`.
	* @returns the option a client renders.
	* @throws when `name` is neither a table key nor `custom`.
	*/
	optionOf(name) {
		if (name === "custom") return {
			value: CUSTOM_PRESET,
			name: "Custom",
			description: "Current sandbox and approval settings do not match a preset."
		};
		const spec = this.resolve(name);
		return {
			value: name,
			name: spec.name ?? name,
			...spec.description !== void 0 ? { description: spec.description } : {}
		};
	}
	/**
	* Record a changed preset, then update each changed knob through its own
	* setter. Selecting the effective preset again appends nothing.
	* @param session - the session the switch belongs to.
	* @param name - the preset to switch to; unknown names throw.
	*/
	set(session, name) {
		this.apply(session, name, (policy) => {
			setApprovalPolicy(session, policy);
		});
	}
	/** Apply one preset with the caller-selected live or initialization policy writer. */
	apply(session, name, setApproval) {
		const spec = this.resolve(name);
		if (this.current(session.events) !== name) session.append("permission/preset", { preset: name });
		const events = session.events;
		if (spec.sandbox !== (effectiveSandboxMode(events) ?? this.ctx.shell.sandboxMode)) setSandboxMode(session, spec.sandbox);
		if (spec.approval !== (effectiveApprovalPolicy(events) ?? this.ctx.approval.config.policy ?? "ask")) setApproval(spec.approval);
	}
	/**
	* Fill every missing permission fact before a session is published. A
	* genuinely fresh session uses the current user default; seeded or partially
	* initialized sessions preserve their effective knob values and only gain
	* the missing durable facts.
	*/
	pinInitialPermission(session) {
		const events = session.events;
		const selected = effectivePermissionPreset(events);
		const sandbox = effectiveSandboxMode(events);
		const approval = effectiveApprovalPolicy(events);
		const seeded = events.some((event) => event.type === "session/end-seed");
		if (selected === void 0 && sandbox === void 0 && approval === void 0 && !seeded) {
			const name = this.defaultPreset;
			const spec = this.resolve(name);
			session.append("permission/preset", { preset: name });
			setSandboxMode(session, spec.sandbox);
			setApprovalPolicy(session, spec.approval);
			return;
		}
		const state = {
			preset: selected ?? null,
			sandbox: sandbox ?? null,
			approval: approval ?? null
		};
		const effective = this.derive(state);
		if (selected === void 0 && effective !== "custom") session.append("permission/preset", { preset: effective });
		if (sandbox === void 0) setSandboxMode(session, this.ctx.shell.sandboxMode);
		if (approval === void 0) setApprovalPolicy(session, this.ctx.approval.config.policy ?? "ask");
	}
};
//#endregion
export { CUSTOM_PRESET, PERMISSION_SETTINGS_NAMESPACE, PermissionPresetService, PermissionPresetService as default, applyKnobEvent, effectivePermissionPreset };
