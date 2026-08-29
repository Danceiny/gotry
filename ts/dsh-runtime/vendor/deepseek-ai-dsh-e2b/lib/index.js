import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { CommandExitError, FileNotFoundError, FileType, FileType as FileType$1, Sandbox, Sandbox as Sandbox$1, SandboxNotFoundError, SandboxNotFoundError as SandboxNotFoundError$1 } from "e2b";
//#region lib/types/index.js
/**
* Shared ownership of one E2B sandbox. Capability adapters await the same SDK
* handle, so filesystem and process operations inhabit one remote Linux world.
* @module @deepseek-ai/dsh-e2b
*/
/**
* Quote one opaque argument for the SDK's unavoidable `/bin/bash -l -c` layer.
* @param value - Exact argument value to preserve.
* @returns A single shell word with no interpolation.
*/
function quoteE2BShellArg(value) {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
/**
* Isolate E2B's hard-coded login shell behind a fresh randomized home path.
* @param overrides - Additional environment entries for the internal command.
* @returns A fresh mutable map that the E2B SDK may extend.
*/
function e2bControlEnvs(overrides = {}) {
	return {
		...overrides,
		HOME: `/.dsh-e2b-control-${randomUUID()}`
	};
}
/**
* Creates one lazily consumable E2B SDK handle and deletes the sandbox at
* timeout or disposal. Creation begins at plugin construction; adapters await
* {@link getSandbox} before their first operation.
*/
var E2BRuntime = class extends Service {
	static Config = z.object({
		apiKey: z.string(),
		cwd: z.string().default("/home/user/workspace"),
		timeoutMs: z.number().default(3e5)
	});
	/** Validated remote working directory shared by provider adapters. */
	cwd;
	/** Remote directory reserved for adapter-owned process and terminal state. */
	runtimeRoot;
	config;
	ready;
	disposed = false;
	constructor(ctx, config) {
		super(ctx, "e2b");
		const resolved = config;
		const apiKey = config.apiKey ?? process.env.E2B_API_KEY;
		this.config = {
			apiKey: apiKey ?? "",
			cwd: resolved.cwd,
			timeoutMs: resolved.timeoutMs
		};
		this.validate();
		this.cwd = this.config.cwd;
		this.runtimeRoot = posix.join(this.cwd, ".dsh-e2b");
		this.ready = this.open();
		this.ready.catch(() => {});
		ctx.effect(() => async () => {
			this.disposed = true;
			let sandbox;
			try {
				sandbox = await this.ready;
			} catch (_sandboxSetupFailure) {
				return;
			}
			try {
				await sandbox.kill();
			} catch (error) {
				if (!(error instanceof SandboxNotFoundError$1)) throw error;
			}
		}, "e2b sandbox teardown");
	}
	/**
	* Return the shared live SDK handle.
	* @returns the created sandbox after the configured cwd exists.
	* @throws when E2B rejects creation or the service is disposing.
	*/
	async getSandbox() {
		if (this.disposed) throw new Error("E2B sandbox service is disposing");
		const sandbox = await this.ready;
		if (this.disposed) throw new Error("E2B sandbox service is disposing");
		return sandbox;
	}
	validate() {
		if (this.config.apiKey.length === 0) throw new Error("dsh-e2b: configure apiKey or set E2B_API_KEY");
		if (!posix.isAbsolute(this.config.cwd)) throw new Error(`dsh-e2b: cwd must be an absolute Linux path: ${this.config.cwd}`);
		if (!Number.isFinite(this.config.timeoutMs) || this.config.timeoutMs <= 0) throw new Error("dsh-e2b: timeoutMs must be a positive finite number");
	}
	async open() {
		const sandbox = await Sandbox$1.create({
			apiKey: this.config.apiKey,
			timeoutMs: this.config.timeoutMs,
			secure: true,
			lifecycle: { onTimeout: "kill" }
		});
		try {
			await sandbox.files.makeDir(this.cwd);
			await sandbox.files.makeDir(this.runtimeRoot);
			const runtimeRoot = await sandbox.files.getInfo(this.runtimeRoot);
			if (runtimeRoot.type !== FileType$1.DIR || runtimeRoot.symlinkTarget !== void 0) throw new Error(`dsh-e2b: runtime root must be a real directory: ${this.runtimeRoot}`);
			await sandbox.commands.run(`chmod 700 -- ${quoteE2BShellArg(this.runtimeRoot)}`, { envs: e2bControlEnvs() });
			return sandbox;
		} catch (error) {
			try {
				await sandbox.kill();
			} catch (_sandboxSetupRollbackFailure) {}
			throw error;
		}
	}
};
//#endregion
export { CommandExitError, E2BRuntime, E2BRuntime as default, FileNotFoundError, FileType, Sandbox, SandboxNotFoundError, e2bControlEnvs, quoteE2BShellArg };
