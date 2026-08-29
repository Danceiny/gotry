import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import z from "@deepseek-ai/schemastery";
import { SENSITIVE_ENV_PATTERN, SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { CommandExitError, FileNotFoundError, SandboxNotFoundError, e2bControlEnvs, quoteE2BShellArg } from "@deepseek-ai/dsh-e2b";
import { PassThrough, Writable } from "node:stream";
import { Buffer } from "node:buffer";
//#region lib/types/environment.js
/** Shared remote-environment scrubbing for E2B process and terminal launchers. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
function remoteEnvironmentEntries(raw) {
	const entries = [];
	for (const entry of raw.split("\0")) {
		if (entry.length === 0) continue;
		const separator = entry.indexOf("=");
		if (separator <= 0) continue;
		entries.push([entry.slice(0, separator), entry.slice(separator + 1)]);
	}
	return entries;
}
/**
* Read the remote environment through ASCII base64 so SDK callback chunking cannot corrupt UTF-8.
* @param sandbox - shared E2B execution world.
* @param signal - optional cancellation for the control-plane request.
* @returns the complete NUL-delimited UTF-8 environment.
*/
async function readRemoteEnvironment(sandbox, signal) {
	const lines = (await sandbox.commands.run("set -o pipefail; dsh_e2b_passwd=\"$(getent passwd \"$(id -u)\")\"; IFS=: read -r _ _ _ _ _ dsh_e2b_home _ <<<\"$dsh_e2b_passwd\"; test -n \"$dsh_e2b_home\" -a -d \"$dsh_e2b_home\"; printf '%s' \"$dsh_e2b_home\" | base64 -w 0; printf '\\n'; env -0 | base64 -w 0", {
		envs: e2bControlEnvs(),
		...signal === void 0 ? {} : { signal }
	})).stdout.trim().split("\n");
	if (lines.length !== 2 || !lines.every((line) => BASE64.test(line))) throw new Error("subprocess-e2b: remote environment transport returned invalid base64");
	const [encodedHome, encodedEnvironment] = lines;
	let home;
	let raw;
	try {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		home = decoder.decode(Buffer.from(encodedHome, "base64"));
		raw = decoder.decode(Buffer.from(encodedEnvironment, "base64"));
	} catch (error) {
		throw new Error("subprocess-e2b: remote environment is not valid UTF-8", { cause: error });
	}
	if (!posix.isAbsolute(home) || home.includes("\0")) throw new Error(`subprocess-e2b: remote login home is invalid: ${JSON.stringify(home)}`);
	const environment = new Map(remoteEnvironmentEntries(raw));
	environment.set("HOME", home);
	return [...environment].map(([name, value]) => `${name}=${value}\0`).join("");
}
/**
* Parse an E2B NUL-delimited environment while removing harness-private and credential-shaped names.
* @param raw - The complete NUL-delimited remote environment.
* @returns Mutable retained entries for the caller to overlay and serialize.
*/
function scrubRemoteEnvironment(raw) {
	const environment = /* @__PURE__ */ new Map();
	for (const [name, value] of remoteEnvironmentEntries(raw)) {
		if (name.startsWith("DSH_") || SENSITIVE_ENV_PATTERN.test(name)) continue;
		environment.set(name, value);
	}
	return environment;
}
/**
* Isolate E2B's fixed login-shell bootstrap from user profiles and ambient credentials.
* @param raw - The complete NUL-delimited remote environment.
* @returns Explicit E2B command or PTY overrides for bootstrap-shell startup.
*/
function bootstrapEnvironment(raw) {
	const environment = { TERM: "dumb" };
	for (const [name] of remoteEnvironmentEntries(raw)) if (name.startsWith("DSH_") || SENSITIVE_ENV_PATTERN.test(name)) environment[name] = "";
	return environment;
}
/**
* Overlay explicit entries and serialize one validated E2B environment.
* @param raw - The complete NUL-delimited remote environment.
* @param explicit - Deliberate caller overrides applied after ambient scrubbing; an `undefined` tombstone removes an ambient entry.
* @returns NUL-delimited `name=value` entries accepted by `env -i`.
*/
function serializeRemoteEnvironment(raw, explicit) {
	const environment = scrubRemoteEnvironment(raw);
	for (const [name, value] of Object.entries(explicit ?? {})) {
		if (name.length === 0 || name.includes("=") || name.includes("\0") || value?.includes("\0") === true) throw new Error("subprocess-e2b: environment entries require non-empty NUL-free names without = and NUL-free values");
		if (value === void 0) environment.delete(name);
		else environment.set(name, value);
	}
	return [...environment].map(([name, value]) => `${name}=${value}\0`).join("");
}
//#endregion
//#region lib/types/output.js
/** Bounded host-side projection of a complete output file retained in E2B. */
const BASE64_TEXT = /^[A-Za-z0-9+/]+={0,2}$/u;
/** Reserved non-base64 frame proving that one remote encoder reached clean EOF. */
const E2B_OUTPUT_COMPLETE_FRAME = "!dsh-e2b-output-complete!";
/** Incrementally decode newline-delimited base64 frames emitted by one remote encoder. */
var E2BBase64Decoder = class {
	pending = "";
	complete = false;
	/**
	* Decode every complete newline-delimited frame in one arbitrarily split SDK callback.
	* @param text - ASCII base64 frames from E2B's decoded callback.
	* @returns the complete raw bytes made available by this callback.
	*/
	push(text) {
		if (text.length === 0) return Buffer.alloc(0);
		this.pending += text;
		const decoded = [];
		for (;;) {
			const boundary = this.pending.indexOf("\n");
			if (boundary < 0) break;
			const frame = this.pending.slice(0, boundary);
			this.pending = this.pending.slice(boundary + 1);
			if (frame === "!dsh-e2b-output-complete!") {
				if (this.complete) throw new Error("subprocess-e2b: duplicate output transport completion");
				this.complete = true;
				continue;
			}
			if (this.complete) throw new Error("subprocess-e2b: output transport continued after completion");
			if (!BASE64_TEXT.test(frame)) throw new Error("subprocess-e2b: invalid base64 output transport");
			const bytes = Buffer.from(frame, "base64");
			if (bytes.toString("base64") !== frame) throw new Error("subprocess-e2b: invalid base64 output transport");
			decoded.push(bytes);
		}
		return Buffer.concat(decoded);
	}
	/**
	* Validate clean encoder completion, or discard an interrupted trailing frame after requested termination.
	* @param requireComplete - Whether natural completion requires the reserved EOF frame.
	*/
	finish(requireComplete = true) {
		if (!requireComplete) {
			this.pending = "";
			return;
		}
		if (this.pending.length > 0) throw new Error("subprocess-e2b: truncated base64 output transport");
		if (!this.complete) throw new Error("subprocess-e2b: incomplete output transport");
	}
};
/** Offset reader used for one collect-mode E2B stream. */
var E2BOutputReader = class {
	maxBytes;
	maxSpillBytes;
	spillPath;
	chunks = [];
	retainedBytes = 0;
	totalBytes = 0;
	spillValid = true;
	/**
	* Create a bounded reader over one remote spill path.
	* @param maxBytes - In-memory tail cap.
	* @param maxSpillBytes - Maximum complete remote file size the caller accepts.
	* @param spillPath - Remote full-output path.
	*/
	constructor(maxBytes, maxSpillBytes, spillPath) {
		this.maxBytes = maxBytes;
		this.maxSpillBytes = maxSpillBytes;
		this.spillPath = spillPath;
	}
	/** Total bytes observed from the SDK stream. */
	get size() {
		return this.totalBytes;
	}
	/** Stop advertising a remote spill whose writer did not reach clean EOF. */
	invalidateSpill() {
		this.spillValid = false;
	}
	/**
	* Append one byte-faithful decoded transport event.
	* @param bytes - Raw command bytes recovered from the ASCII SDK transport.
	*/
	push(bytes) {
		if (bytes.length === 0) return;
		const chunk = Buffer.from(bytes);
		this.totalBytes += chunk.length;
		this.chunks.push(chunk);
		this.retainedBytes += chunk.length;
		while (this.retainedBytes > this.maxBytes) {
			const head = this.chunks[0];
			const excess = this.retainedBytes - this.maxBytes;
			if (head.length <= excess) {
				this.chunks.shift();
				this.retainedBytes -= head.length;
			} else {
				this.chunks[0] = head.subarray(excess);
				this.retainedBytes -= excess;
			}
		}
	}
	/** @inheritdoc */
	readFrom(fromByte) {
		const retained = Buffer.concat(this.chunks, this.retainedBytes);
		const firstRetained = this.totalBytes - this.retainedBytes;
		const lossy = fromByte < firstRetained;
		const start = lossy ? 0 : Math.min(retained.length, Math.max(0, fromByte - firstRetained));
		return {
			text: retained.subarray(start).toString("utf8"),
			nextOffset: this.totalBytes,
			lossy,
			...lossy && this.spillValid && this.maxSpillBytes !== void 0 && this.totalBytes <= this.maxSpillBytes ? { spillPath: this.spillPath } : {}
		};
	}
};
//#endregion
//#region lib/types/remote.js
/**
* Shared remote-control helpers for the E2B subprocess adapter: SDK option
* shaping, poll ticks, and the one tolerant process-group signal used by both
* the ordinary-process and terminal teardown ladders.
*/
/**
* Normalize an unknown rejection into an Error.
* @param error - Any thrown or rejected value.
* @returns The value itself when already an Error, else a stringified wrapper.
*/
function asError(error) {
	return error instanceof Error ? error : new Error(String(error));
}
/**
* Shape the optional-signal SDK options object.
* @param signal - Optional cancellation for one SDK request.
* @returns An options fragment that omits an undefined signal.
*/
function signalOpts(signal) {
	return signal === void 0 ? {} : { signal };
}
/**
* Shape control-shell command options with the isolated HOME override.
* @param envs - Explicit environment entries for the control command.
* @param signal - Optional cancellation for the SDK request.
* @returns Options for `sandbox.commands.run` control invocations.
*/
function commandOpts(envs, signal) {
	return {
		envs: e2bControlEnvs(envs),
		...signalOpts(signal)
	};
}
/**
* Resolve after one duration.
* @param ms - Milliseconds to wait.
* @returns Settles after the timeout.
*/
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
* Wait one poll interval or until the signal aborts.
* @param pollMs - Poll cadence in milliseconds.
* @param signal - Optional abort that ends the wait early.
* @returns `true` after a full tick, `false` when aborted first.
*/
function waitTick(pollMs, signal) {
	if (signal?.aborted === true) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, pollMs);
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
/**
* Signal remote process groups, tolerating the shared teardown outcomes: a
* nonzero `kill` (groups already gone) and a disappeared sandbox. Both the
* pgid-keyed process ladder and the sid-keyed terminal ladder deliver signals
* through this single tolerance so they cannot drift apart.
* @param sandbox - Live SDK handle.
* @param envs - Control-shell environment entries.
* @param groups - Positive process-group ids to signal.
* @param signal - `TERM` or `KILL`.
*/
async function signalRemoteGroups(sandbox, envs, groups, signal) {
	try {
		await sandbox.commands.run(`kill -${signal} -- ${groups.map((group) => `-${group}`).join(" ")}`, commandOpts(envs));
	} catch (error) {
		if (!(error instanceof CommandExitError) && !(error instanceof SandboxNotFoundError)) throw error;
	}
}
//#endregion
//#region lib/types/process.js
/** One asynchronously-started E2B command projected onto the subprocess seam. */
const OUTPUT_ENCODER_SOURCE = [
	"(async () => {",
	"  for await (const chunk of process.stdin) {",
	"    if (!process.stdout.write(chunk.toString('base64') + '\\n')) {",
	"      await new Promise(resolve => process.stdout.once('drain', resolve))",
	"    }",
	"  }",
	`  if (!process.stdout.write(${JSON.stringify(E2B_OUTPUT_COMPLETE_FRAME)} + '\\n')) {`,
	"    await new Promise(resolve => process.stdout.once('drain', resolve))",
	"  }",
	"})().catch(() => { process.exitCode = 1 })"
].join("\n");
function isCollect(mode) {
	return mode !== "pipe" && mode !== "inherit";
}
function hasSpill(mode) {
	return isCollect(mode) && mode.spill !== void 0;
}
function isValidProcessId(value) {
	return Number.isSafeInteger(value) && value > 0;
}
var DeferredStdin = class extends Writable {
	ready;
	constructor(ready) {
		super({ decodeStrings: false });
		this.ready = ready;
	}
	_write(chunk, _encoding, callback) {
		this.ready.then((handle) => handle.sendStdin(chunk)).then(() => {
			callback();
		}, (error) => {
			callback(asError(error));
		});
	}
	_final(callback) {
		this.ready.then((handle) => handle.closeStdin()).then(() => {
			callback();
		}, (error) => {
			callback(asError(error));
		});
	}
};
function withinMs(settlement, timeoutMs) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			resolve(void 0);
		}, timeoutMs);
		settlement.then((value) => {
			clearTimeout(timer);
			resolve(value);
		});
	});
}
function commandText(spec, paths) {
	const encoder = `"$dsh_e2b_env_bin" -i "$dsh_e2b_node" -e ${quoteE2BShellArg(OUTPUT_ENCODER_SOURCE)}`;
	const stdoutRedirect = hasSpill(spec.stdio.stdout) ? `> >("$dsh_e2b_tee" --output-error=warn-nopipe >("$dsh_e2b_head" -c ${spec.stdio.stdout.spill.maxBytes} > ${quoteE2BShellArg(paths.stdout)}) | ${encoder} 2>/dev/null)` : `> >(${encoder} 2>/dev/null)`;
	const stderrRedirect = hasSpill(spec.stdio.stderr) ? `2> >("$dsh_e2b_tee" --output-error=warn-nopipe >("$dsh_e2b_head" -c ${spec.stdio.stderr.spill.maxBytes} > ${quoteE2BShellArg(paths.stderr)}) | ${encoder} >&2 2>/dev/null)` : `2> >(${encoder} >&2 2>/dev/null)`;
	const inner = [
		"set +e",
		"dsh_e2b_env_bin=$1",
		"dsh_e2b_node=$2",
		"dsh_e2b_ps=$3",
		"dsh_e2b_tr=$4",
		"dsh_e2b_tee=$5",
		"dsh_e2b_head=$6",
		"dsh_e2b_rm=$7",
		"shift 7",
		"dsh_e2b_pgid=\"$(\"$dsh_e2b_ps\" -o pgid= -p \"$$\" | \"$dsh_e2b_tr\" -d \" \")\"",
		`printf '%s\\n' "$dsh_e2b_pgid" > ${quoteE2BShellArg(paths.pid)}`,
		`mapfile -d '' -t dsh_e2b_env < ${quoteE2BShellArg(paths.environment)}`,
		`"$dsh_e2b_rm" -f -- ${quoteE2BShellArg(paths.environment)}`,
		`"$dsh_e2b_env_bin" -i -- "\${dsh_e2b_env[@]}" "$@" ${stdoutRedirect} ${stderrRedirect}`.trimEnd(),
		"dsh_e2b_status=$?",
		`printf '%s\\n' "$dsh_e2b_status" > ${quoteE2BShellArg(paths.status)}`,
		"wait",
		"exit \"$dsh_e2b_status\""
	].join("\n");
	const argv = spec.argv.map(quoteE2BShellArg).join(" ");
	return [
		`mapfile -d '' -t dsh_e2b_env < ${quoteE2BShellArg(paths.environment)}`,
		"dsh_e2b_env_bin=\"$(command -v env)\"",
		"dsh_e2b_setsid=\"$(command -v setsid)\"",
		"dsh_e2b_bash=\"$(command -v bash)\"",
		"dsh_e2b_node=\"$(command -v node)\"",
		"dsh_e2b_ps=\"$(command -v ps)\"",
		"dsh_e2b_tr=\"$(command -v tr)\"",
		"dsh_e2b_tee=\"$(command -v tee)\"",
		"dsh_e2b_head=\"$(command -v head)\"",
		"dsh_e2b_rm=\"$(command -v rm)\"",
		"for dsh_e2b_tool in \"$dsh_e2b_env_bin\" \"$dsh_e2b_setsid\" \"$dsh_e2b_bash\" \"$dsh_e2b_node\" \"$dsh_e2b_ps\" \"$dsh_e2b_tr\" \"$dsh_e2b_tee\" \"$dsh_e2b_head\" \"$dsh_e2b_rm\"; do",
		"  [[ \"$dsh_e2b_tool\" == /* && -x \"$dsh_e2b_tool\" ]] || exit 125",
		"done",
		`exec "$dsh_e2b_env_bin" -i -- "\${dsh_e2b_env[@]}" "$dsh_e2b_setsid" --wait -- "$dsh_e2b_bash" -c ${quoteE2BShellArg(inner)} dsh-e2b "$dsh_e2b_env_bin" "$dsh_e2b_node" "$dsh_e2b_ps" "$dsh_e2b_tr" "$dsh_e2b_tee" "$dsh_e2b_head" "$dsh_e2b_rm" ${argv}`
	].join("\n");
}
const WAIT_ABORTED = Symbol("wait aborted");
function waitWithSignal(promise, signal) {
	if (signal === void 0) return promise;
	if (signal.aborted) return Promise.resolve(WAIT_ABORTED);
	return new Promise((resolve) => {
		const onAbort = () => {
			cleanup();
			resolve(WAIT_ABORTED);
		};
		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
			return;
		}
		promise.then((value) => {
			cleanup();
			resolve(value);
		});
	});
}
/** E2B-backed subprocess handle with deferred remote PID acquisition. */
var E2BSubprocessHandle = class {
	runtime;
	spec;
	stateDir;
	pollMs;
	stdin;
	stdout;
	stderr;
	collected;
	done;
	commandState = Promise.withResolvers();
	readyState = Promise.withResolvers();
	stdoutDecoder = new E2BBase64Decoder();
	stderrDecoder = new E2BBase64Decoder();
	terminationController = new AbortController();
	/** Releases output waits that survive the command outcome, so blocked SDK callbacks settle. */
	outputReleased = new AbortController();
	stdoutReader;
	stderrReader;
	paths;
	controlEnvs = {};
	remotePid = -1;
	outputTransportError;
	outputDrainExpired = false;
	stateDirectoryCreated = false;
	quiescenceProven = false;
	terminationAttempt;
	terminationFailure;
	terminationSignal = null;
	/**
	* Begin an E2B command without blocking the synchronous subprocess spawn call.
	* @param runtime - Shared E2B sandbox owner.
	* @param spec - Fully resolved subprocess request.
	* @param stateDir - Remote directory retaining process identity, status, and valid spills.
	* @param pollMs - Remote status/liveness poll cadence.
	*/
	constructor(runtime, spec, stateDir, pollMs) {
		this.runtime = runtime;
		this.spec = spec;
		this.stateDir = stateDir;
		this.pollMs = pollMs;
		this.paths = {
			pid: posix.join(stateDir, "pid"),
			status: posix.join(stateDir, "exit-code"),
			environment: posix.join(stateDir, "environment"),
			stdout: posix.join(stateDir, "stdout.log"),
			stderr: posix.join(stateDir, "stderr.log")
		};
		const outMode = spec.stdio.stdout;
		const errMode = spec.stdio.stderr;
		this.stdout = outMode === "pipe" ? new PassThrough() : void 0;
		this.stderr = errMode === "pipe" ? new PassThrough() : void 0;
		this.stdoutReader = isCollect(outMode) ? new E2BOutputReader(outMode.maxBytes, outMode.spill?.maxBytes, this.paths.stdout) : void 0;
		this.stderrReader = isCollect(errMode) ? new E2BOutputReader(errMode.maxBytes, errMode.spill?.maxBytes, this.paths.stderr) : void 0;
		this.collected = {
			...this.stdoutReader !== void 0 ? { stdout: this.stdoutReader } : {},
			...this.stderrReader !== void 0 ? { stderr: this.stderrReader } : {}
		};
		this.stdin = spec.stdio.stdin === "pipe" ? new DeferredStdin(this.readyState.promise) : void 0;
		this.readyState.promise.catch(() => {});
		spec.signal?.addEventListener("abort", this.onAbort, { once: true });
		this.done = this.run();
		this.done.catch(() => {});
		if (spec.signal?.aborted === true) this.terminate();
	}
	/** Remote process id after start; `-1` while E2B startup is pending or after it fails. */
	get pid() {
		return this.remotePid;
	}
	/** @inheritdoc */
	terminate() {
		if (this.quiescenceProven || this.terminationAttempt !== void 0) return;
		this.terminationController.abort(/* @__PURE__ */ new Error("subprocess-e2b: command terminated"));
		this.stdout?.destroy();
		this.stderr?.destroy();
		this.terminationFailure = void 0;
		const attempt = this.terminateRemote();
		this.terminationAttempt = attempt;
		attempt.then(() => {
			this.terminationAttempt = void 0;
		}, (error) => {
			if (!this.quiescenceProven) this.terminationFailure = asError(error);
			this.terminationAttempt = void 0;
		});
	}
	/** @inheritdoc */
	async waitForExit(signal) {
		if (this.quiescenceProven) return true;
		let handle;
		if (this.terminationController.signal.aborted) {
			const observed = await waitWithSignal(this.commandState.promise, signal);
			if (observed === WAIT_ABORTED) return false;
			handle = observed;
			if (handle === void 0) {
				this.markQuiescent();
				return true;
			}
			if (this.remotePid <= 0) {
				const attempt = this.terminationAttempt;
				if (attempt !== void 0 && await waitWithSignal(attempt.catch(() => void 0), signal) === WAIT_ABORTED) return false;
				this.throwTerminationFailure();
				return true;
			}
		} else {
			const observed = await waitWithSignal(this.readyState.promise.catch(() => this.commandState.promise), signal);
			if (observed === WAIT_ABORTED) return false;
			handle = observed;
			if (handle === void 0) {
				this.markQuiescent();
				return true;
			}
		}
		this.throwTerminationFailure();
		let sandbox;
		try {
			sandbox = await this.runtime.getSandbox();
		} catch (error) {
			if (signal?.aborted === true) return false;
			if (error instanceof SandboxNotFoundError) {
				this.markQuiescent();
				return true;
			}
			throw error;
		}
		const processGroupId = this.remotePid > 0 ? this.remotePid : handle.pid;
		while (await this.groupAlive(sandbox, processGroupId, signal)) {
			this.throwTerminationFailure();
			if (!await waitTick(this.pollMs, signal)) return false;
		}
		this.throwTerminationFailure();
		if (signal?.aborted === true) return false;
		this.markQuiescent();
		return true;
	}
	onAbort = () => {
		this.terminate();
	};
	markQuiescent() {
		this.quiescenceProven = true;
		this.terminationFailure = void 0;
	}
	async run() {
		let sandbox;
		let preparing = true;
		try {
			sandbox = await this.runtime.getSandbox();
			await this.prepareState(sandbox);
			preparing = false;
			const handle = await sandbox.commands.run(commandText(this.spec, this.paths), {
				background: true,
				cwd: this.spec.cwd,
				envs: e2bControlEnvs(this.controlEnvs),
				stdin: this.spec.stdio.stdin !== "ignore",
				timeoutMs: 0,
				onStdout: async (data) => {
					await this.dispatchOutput("stdout", data);
				},
				onStderr: async (data) => {
					await this.dispatchOutput("stderr", data);
				}
			});
			const completion = handle.wait();
			completion.catch(() => {});
			if (!isValidProcessId(handle.pid)) {
				const invalidPid = /* @__PURE__ */ new Error(`subprocess-e2b: E2B returned invalid command pid ${handle.pid}`);
				try {
					await handle.kill();
					this.markQuiescent();
				} catch (cleanupError) {
					this.terminationFailure = asError(cleanupError);
					this.commandState.resolve(handle);
					throw new AggregateError([invalidPid, cleanupError], "subprocess-e2b: invalid command pid rollback did not reach quiescence");
				}
				throw invalidPid;
			}
			this.commandState.resolve(handle);
			try {
				this.remotePid = await this.waitForProcessGroupId(sandbox, completion);
			} catch (error) {
				try {
					await this.rollbackUnpublishedGroup(sandbox, handle);
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "subprocess-e2b: process-group publication failed and rollback did not reach quiescence");
				}
				throw error;
			}
			this.readyState.resolve(handle);
			await this.writeBatchStdin(handle);
			const outcome = await this.waitForCommand(sandbox, handle, completion);
			if (this.outputTransportError !== void 0) throw this.outputTransportError;
			const requireCompleteOutput = this.terminationSignal === null && !this.outputDrainExpired;
			this.stdoutDecoder.finish(requireCompleteOutput);
			this.stderrDecoder.finish(requireCompleteOutput);
			await this.finalizeSpills(sandbox);
			return outcome;
		} catch (error) {
			const canceledPreparation = preparing && this.terminationController.signal.aborted;
			let failure = await this.rollbackPublishedFailure(error);
			if (sandbox !== void 0 && this.stateDirectoryCreated) try {
				await this.removeFailedState(sandbox);
			} catch (cleanupError) {
				failure = new AggregateError([failure, cleanupError], "subprocess-e2b: command failed and private state cleanup failed");
			}
			this.commandState.resolve(void 0);
			this.readyState.reject(failure);
			if (canceledPreparation && failure === error) return {
				exitCode: null,
				signal: "SIGTERM"
			};
			throw failure;
		} finally {
			this.spec.signal?.removeEventListener("abort", this.onAbort);
			this.stdout?.end();
			this.stderr?.end();
		}
	}
	async prepareState(sandbox) {
		const signal = this.terminationController.signal;
		const ambient = await readRemoteEnvironment(sandbox, signal);
		this.controlEnvs = bootstrapEnvironment(ambient);
		this.stateDirectoryCreated = true;
		await sandbox.files.makeDir(this.stateDir, { signal });
		await sandbox.commands.run(`chmod 700 -- ${quoteE2BShellArg(this.stateDir)}`, commandOpts(this.controlEnvs, signal));
		const files = [
			{
				path: this.paths.pid,
				data: ""
			},
			{
				path: this.paths.status,
				data: ""
			},
			{
				path: this.paths.environment,
				data: serializeRemoteEnvironment(ambient, this.spec.env)
			},
			...hasSpill(this.spec.stdio.stdout) ? [{
				path: this.paths.stdout,
				data: ""
			}] : [],
			...hasSpill(this.spec.stdio.stderr) ? [{
				path: this.paths.stderr,
				data: ""
			}] : []
		];
		await sandbox.files.write(files, { signal });
		await sandbox.commands.run(`chmod 600 -- ${files.map((file) => quoteE2BShellArg(file.path)).join(" ")}`, commandOpts(this.controlEnvs, signal));
		signal.throwIfAborted();
	}
	async writeBatchStdin(handle) {
		if (typeof this.spec.stdio.stdin !== "object") return;
		try {
			await handle.sendStdin(this.spec.stdio.stdin.data);
			await handle.closeStdin();
		} catch (_processClosedItsInput) {}
	}
	async dispatchOutput(stream, data) {
		let bytes;
		try {
			bytes = stream === "stdout" ? this.stdoutDecoder.push(data) : this.stderrDecoder.push(data);
		} catch (error) {
			this.outputTransportError ??= asError(error);
			(stream === "stdout" ? this.stdout : this.stderr)?.destroy(this.outputTransportError);
			return;
		}
		try {
			if (stream === "stdout") {
				this.stdoutReader?.push(bytes);
				await this.writeOutput(this.stdout, this.spec.stdio.stdout === "inherit" ? process.stdout : void 0, bytes);
				return;
			}
			this.stderrReader?.push(bytes);
			await this.writeOutput(this.stderr, this.spec.stdio.stderr === "inherit" ? process.stderr : void 0, bytes);
		} catch (error) {
			(stream === "stdout" ? this.stdout : this.stderr)?.destroy(asError(error));
		}
	}
	async writeOutput(pipe, inherited, data) {
		const target = pipe ?? inherited;
		if (target === void 0 || data.length === 0 || this.terminationController.signal.aborted) return;
		if (target.destroyed) throw new Error("subprocess output stream is closed");
		if (target.write(data)) return;
		await new Promise((resolve, reject) => {
			const onDrain = () => {
				cleanup();
				resolve();
			};
			const onClose = () => {
				cleanup();
				resolve();
			};
			const onRelease = () => {
				cleanup();
				resolve();
			};
			const onError = (error) => {
				cleanup();
				reject(error);
			};
			const cleanup = () => {
				target.removeListener("drain", onDrain);
				target.removeListener("close", onClose);
				target.removeListener("error", onError);
				this.terminationController.signal.removeEventListener("abort", onRelease);
				this.outputReleased.signal.removeEventListener("abort", onRelease);
			};
			target.once("drain", onDrain);
			target.once("close", onClose);
			target.once("error", onError);
			this.terminationController.signal.addEventListener("abort", onRelease, { once: true });
			this.outputReleased.signal.addEventListener("abort", onRelease, { once: true });
			if (this.terminationController.signal.aborted || this.outputReleased.signal.aborted) onRelease();
		});
	}
	async waitForProcessGroupId(sandbox, completion) {
		const commandSettled = completion.then(() => true, () => true);
		while (true) {
			const value = (await sandbox.files.read(this.paths.pid)).trim();
			if (value.length > 0) {
				const pid = Number(value);
				if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(pid)) throw new Error(`subprocess-e2b: remote wrapper published invalid process-group id ${JSON.stringify(value)}`);
				if (pid <= 1) throw new Error(`subprocess-e2b: unsafe published process-group id ${pid}`);
				return pid;
			}
			if (await Promise.race([commandSettled, waitTick(this.pollMs).then(() => false)])) throw new Error("subprocess-e2b: remote command exited before publishing its process-group id");
		}
	}
	async waitForCommand(sandbox, handle, completion) {
		const settlement = completion.then((result) => ({
			kind: "result",
			result
		}), (error) => ({
			kind: "error",
			error
		}));
		let completed = this.spec.stdio.stdout === "pipe" || this.spec.stdio.stderr === "pipe" ? await settlement : void 0;
		while (true) {
			const rawStatus = (await sandbox.files.read(this.paths.status)).trim();
			if (rawStatus.length > 0) {
				const exitCode = Number(rawStatus);
				if (!/^(?:0|[1-9][0-9]*)$/.test(rawStatus) || !Number.isSafeInteger(exitCode) || exitCode > 255) throw new Error(`subprocess-e2b: remote wrapper published invalid exit code ${JSON.stringify(rawStatus)}`);
				if (completed !== void 0) return this.commandOutcome(completed, exitCode);
				const drained = await withinMs(settlement, this.spec.graceMs);
				if (drained !== void 0) return this.commandOutcome(drained, exitCode);
				this.outputDrainExpired = true;
				this.stdoutReader?.invalidateSpill();
				this.stderrReader?.invalidateSpill();
				this.outputReleased.abort(/* @__PURE__ */ new Error("subprocess-e2b: output drain grace expired"));
				await handle.disconnect();
				return {
					exitCode,
					signal: null
				};
			}
			if (completed !== void 0) return this.commandOutcome(completed);
			completed = await Promise.race([settlement, waitTick(this.pollMs).then(() => void 0)]);
		}
	}
	commandOutcome(settlement, publishedExitCode) {
		if (settlement.kind === "result") return {
			exitCode: publishedExitCode ?? settlement.result.exitCode,
			signal: null
		};
		if (settlement.error instanceof CommandExitError) {
			if (publishedExitCode !== void 0) return {
				exitCode: publishedExitCode,
				signal: null
			};
			return this.terminationSignal === null ? {
				exitCode: settlement.error.exitCode,
				signal: null
			} : {
				exitCode: null,
				signal: this.terminationSignal
			};
		}
		throw settlement.error;
	}
	async rollbackPublishedFailure(error) {
		if (this.remotePid <= 0 || this.quiescenceProven) return error;
		this.terminate();
		try {
			await this.waitForExit();
			return error;
		} catch (cleanupError) {
			return new AggregateError([asError(error), asError(cleanupError)], "subprocess-e2b: command monitoring failed and process-group rollback did not reach quiescence");
		}
	}
	async rollbackUnpublishedGroup(sandbox, handle) {
		await this.forceKillGroup(sandbox, handle, handle.pid);
		this.markQuiescent();
	}
	async terminateRemote() {
		try {
			await this.terminateRemoteInSandbox();
		} catch (error) {
			if (error instanceof SandboxNotFoundError) {
				this.markQuiescent();
				return;
			}
			throw error;
		}
	}
	async terminateRemoteInSandbox() {
		const handle = await this.commandState.promise;
		if (handle === void 0) {
			this.markQuiescent();
			return;
		}
		if (!isValidProcessId(handle.pid) && this.remotePid <= 0) {
			await handle.kill();
			this.markQuiescent();
			return;
		}
		const sandbox = await this.runtime.getSandbox();
		const processGroupId = this.remotePid > 0 ? this.remotePid : handle.pid;
		await this.terminateGroup(sandbox, handle, processGroupId);
	}
	async terminateGroup(sandbox, handle, processGroupId) {
		this.terminationSignal = "SIGTERM";
		try {
			await signalRemoteGroups(sandbox, this.controlEnvs, [processGroupId], "TERM");
			if (await this.waitForGroupExit(sandbox, processGroupId)) {
				this.markQuiescent();
				return;
			}
		} catch (_gracefulTerminationFailure) {}
		this.terminationSignal = "SIGKILL";
		await this.forceKillGroup(sandbox, handle, processGroupId);
		this.markQuiescent();
	}
	async forceKillGroup(sandbox, handle, processGroupId) {
		try {
			await signalRemoteGroups(sandbox, this.controlEnvs, [processGroupId], "KILL");
		} catch (_processGroupKillFailure) {}
		try {
			await handle.kill();
		} catch (_sdkKillFailure) {}
		if (await this.waitForGroupExit(sandbox, processGroupId)) return;
		throw new Error(`subprocess-e2b: remote process group ${processGroupId} remained live after force termination`);
	}
	async waitForGroupExit(sandbox, processGroupId) {
		const deadline = Date.now() + this.spec.graceMs;
		while (await this.groupAlive(sandbox, processGroupId)) {
			if (Date.now() >= deadline) return false;
			await waitTick(this.pollMs);
		}
		return true;
	}
	throwTerminationFailure() {
		if (this.terminationFailure !== void 0) throw this.terminationFailure;
	}
	async groupAlive(sandbox, pid, signal) {
		return (await sandbox.commands.run(`set -o pipefail; ps -eo pgid=,stat= | awk '$1 == ${pid} && $2 !~ /^[ZXx]/ { live=1 } END { if (live) print "live" }'`, commandOpts(this.controlEnvs, signal)).catch((error) => {
			if (signal?.aborted === true) return void 0;
			if (error instanceof SandboxNotFoundError) return {
				exitCode: 0,
				stdout: "",
				stderr: ""
			};
			throw error;
		}))?.stdout.trim() === "live";
	}
	async finalizeSpills(sandbox) {
		const removals = [];
		const collect = (mode, reader, path) => {
			if (!hasSpill(mode)) return;
			const size = reader.size;
			if (this.outputDrainExpired || size <= mode.maxBytes || size > mode.spill.maxBytes) removals.push(sandbox.files.remove(path).catch((_adapterPrivateSpillRemovalFailure) => {}));
		};
		collect(this.spec.stdio.stdout, this.stdoutReader, this.paths.stdout);
		collect(this.spec.stdio.stderr, this.stderrReader, this.paths.stderr);
		await Promise.all(removals);
	}
	async removeFailedState(sandbox) {
		const failures = [];
		for (const path of [this.paths.environment, this.stateDir]) try {
			await sandbox.files.remove(path);
		} catch (error) {
			if (!(error instanceof FileNotFoundError)) failures.push(asError(error));
		}
		if (failures.length > 0) throw new AggregateError(failures, "subprocess-e2b: failed to remove private command state");
	}
};
//#endregion
//#region lib/types/terminal.js
/** E2B PTY allocation and process-session ownership for the subprocess seam. */
const TERMINAL_RUNNER_SOURCE = [
	"#!/bin/bash",
	"set -euo pipefail",
	"dsh_state=$1",
	"mapfile -d '' -t dsh_env < \"$dsh_state/environment\"",
	"mapfile -d '' -t dsh_argv < \"$dsh_state/argv\"",
	"dsh_output_marker=$(<\"$dsh_state/output-marker\")",
	"rm -f -- \"$dsh_state/environment\" \"$dsh_state/argv\" \"$dsh_state/output-marker\" \"$dsh_state/runner.bash\"",
	"if (( ${#dsh_argv[@]} == 0 )); then",
	"  printf 'terminal runner received empty argv\\n' >&2",
	"  exit 125",
	"fi",
	"printf '%s' \"$dsh_output_marker\"",
	"exec env -i -- \"${dsh_env[@]}\" \"${dsh_argv[@]}\"",
	""
].join("\n");
var BootstrapOutputFilter = class {
	marker;
	output;
	ready;
	readyState = Promise.withResolvers();
	pending = Buffer.alloc(0);
	published = false;
	constructor(marker, output) {
		this.marker = marker;
		this.output = output;
		this.ready = this.readyState.promise;
	}
	push(data) {
		if (this.published) {
			this.write(data);
			return;
		}
		const combined = Buffer.concat([this.pending, Buffer.from(data)]);
		const markerOffset = combined.indexOf(this.marker);
		if (markerOffset < 0) {
			const retained = Math.min(combined.length, this.marker.length - 1);
			this.pending = Buffer.from(combined.subarray(combined.length - retained));
			return;
		}
		this.published = true;
		this.pending = Buffer.alloc(0);
		this.readyState.resolve();
		this.write(combined.subarray(markerOffset + this.marker.length));
	}
	write(data) {
		if (data.length > 0 && !this.output.destroyed) this.output.write(data);
	}
};
async function waitForBootstrapOutput(ready, completion, signal) {
	signal?.throwIfAborted();
	await new Promise((resolve, reject) => {
		let settled = false;
		let removeAbort;
		const finish = (complete) => {
			if (settled) return;
			settled = true;
			removeAbort?.();
			complete();
		};
		const onExit = () => {
			finish(() => {
				reject(/* @__PURE__ */ new Error("subprocess-e2b: terminal exited before publishing its output boundary"));
			});
		};
		if (signal !== void 0) {
			const onAbort = () => {
				finish(() => {
					reject(asError(signal.reason));
				});
			};
			signal.addEventListener("abort", onAbort, { once: true });
			removeAbort = () => {
				signal.removeEventListener("abort", onAbort);
			};
		}
		ready.then(() => {
			finish(resolve);
		});
		completion.then(onExit, onExit);
	});
}
function parsePositiveId(value, message) {
	const raw = value.trim();
	const id = Number(raw);
	if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(id)) throw new Error(message);
	return id;
}
function serializeValues(values, kind) {
	for (const value of values) if (value.includes("\0")) throw new Error(`subprocess-e2b: terminal ${kind} must not contain NUL bytes`);
	return values.map((value) => `${value}\0`).join("");
}
async function terminalSessionId(sandbox, pid, envs, signal) {
	const result = await sandbox.commands.run(`ps -o sid= -p ${pid}`, commandOpts(envs, signal));
	signal?.throwIfAborted();
	return parsePositiveId(result.stdout, `subprocess-e2b: cannot resolve process session for terminal ${pid}`);
}
async function sessionProcessGroups(sandbox, sessionId, envs) {
	let result;
	try {
		result = await sandbox.commands.run(`set -o pipefail; ps -eo sid=,pgid=,stat= | awk '$1 == ${sessionId} && $3 !~ /^[ZXx]/ { print $2 }'`, commandOpts(envs));
	} catch (error) {
		if (error instanceof SandboxNotFoundError) return [];
		throw error;
	}
	const groups = /* @__PURE__ */ new Set();
	for (const raw of result.stdout.trim().split(/\s+/)) {
		if (raw.length === 0) continue;
		const group = parsePositiveId(raw, `subprocess-e2b: invalid process group ${JSON.stringify(raw)} in terminal session ${sessionId}`);
		if (group <= 1) throw new Error(`subprocess-e2b: unsafe process group ${group} in terminal session ${sessionId}`);
		groups.add(group);
	}
	return [...groups];
}
async function awaitSessionEmpty(sandbox, sessionId, envs, graceMs, pollMs, kill = false) {
	const deadline = Date.now() + graceMs;
	for (;;) {
		const groups = await sessionProcessGroups(sandbox, sessionId, envs);
		if (groups.length === 0) return groups;
		if (kill) {
			await signalRemoteGroups(sandbox, envs, groups, "KILL");
			if (Date.now() >= deadline) return await sessionProcessGroups(sandbox, sessionId, envs);
		} else if (Date.now() >= deadline) return groups;
		await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
	}
}
async function rollbackUnpublishedTerminal(sandbox, handle, completion, envs, graceMs, pollMs) {
	let topLevelExited = false;
	completion.then(() => {
		topLevelExited = true;
	}, () => {
		topLevelExited = true;
	});
	const validPid = Number.isSafeInteger(handle.pid) && handle.pid > 1;
	const attemptFailures = [];
	let sessionId;
	if (validPid) {
		sessionId = handle.pid;
		try {
			sessionId = await terminalSessionId(sandbox, handle.pid, envs);
		} catch (_sessionLookupFailure) {}
		try {
			let groups = await sessionProcessGroups(sandbox, sessionId, envs);
			if (groups.length > 0) {
				await signalRemoteGroups(sandbox, envs, groups, "TERM");
				groups = await awaitSessionEmpty(sandbox, sessionId, envs, graceMs, pollMs);
			}
			if (groups.length > 0) await awaitSessionEmpty(sandbox, sessionId, envs, graceMs, pollMs, true);
		} catch (error) {
			attemptFailures.push(asError(error));
		}
	}
	if (!topLevelExited) {
		try {
			await handle.kill();
		} catch (error) {
			if (error instanceof SandboxNotFoundError) return;
			attemptFailures.push(asError(error));
		}
		await Promise.race([completion.catch(() => void 0), delay(graceMs)]);
	}
	const proofFailures = [];
	if (sessionId !== void 0) try {
		const groups = await awaitSessionEmpty(sandbox, sessionId, envs, graceMs, pollMs, true);
		if (groups.length > 0) proofFailures.push(/* @__PURE__ */ new Error(`subprocess-e2b: terminal setup rollback failed; surviving process groups: ${groups.join(", ")}`));
	} catch (error) {
		proofFailures.push(asError(error));
	}
	if (!topLevelExited) proofFailures.push(/* @__PURE__ */ new Error(`subprocess-e2b: terminal setup rollback failed; surviving pid: ${handle.pid}`));
	if (proofFailures.length > 0) throw new AggregateError([...attemptFailures, ...proofFailures], "subprocess-e2b: terminal setup rollback did not reach quiescence");
	try {
		await handle.disconnect();
	} catch (error) {
		if (!(error instanceof SandboxNotFoundError)) throw error;
	}
}
/** One E2B PTY and all process groups in its remote process session. */
var E2BTerminalHandle = class {
	sandbox;
	handle;
	output;
	completion;
	sessionId;
	controlEnvs;
	stateDir;
	graceMs;
	pollMs;
	pid;
	done;
	topLevelExited = false;
	cleanup;
	operationController = new AbortController();
	operations = /* @__PURE__ */ new Set();
	terminationSignal = null;
	constructor(sandbox, handle, output, completion, sessionId, controlEnvs, stateDir, graceMs, pollMs) {
		this.sandbox = sandbox;
		this.handle = handle;
		this.output = output;
		this.completion = completion;
		this.sessionId = sessionId;
		this.controlEnvs = controlEnvs;
		this.stateDir = stateDir;
		this.graceMs = graceMs;
		this.pollMs = pollMs;
		this.pid = handle.pid;
		this.done = this.waitForCommand();
	}
	/** @inheritdoc */
	write(data) {
		return this.trackOperation(async (signal) => {
			if (this.topLevelExited) throw new Error("terminal process has exited");
			await this.sandbox.pty.sendInput(this.pid, Buffer.from(data, "utf8"), { signal });
		});
	}
	/** @inheritdoc */
	inspectForeground() {
		return this.trackOperation((signal) => this.inspectForegroundOnce(signal));
	}
	/** @inheritdoc */
	signalForeground(signal) {
		return this.trackOperation(async (operationSignal) => {
			const foreground = await this.inspectForegroundOnce(operationSignal);
			if (foreground === void 0) throw new Error(`subprocess-e2b: cannot resolve foreground process group for terminal ${this.pid}`);
			if (signal === "SIGKILL" && foreground.processGroupId === this.pid) throw new Error("refusing to SIGKILL the terminal shell; terminate the terminal session instead");
			await this.sandbox.commands.run(`kill -${signal.slice(3)} -- -${foreground.processGroupId}`, commandOpts(this.controlEnvs, operationSignal));
			return foreground.processGroupId;
		});
	}
	/** @inheritdoc */
	terminate() {
		if (this.cleanup !== void 0) return this.cleanup;
		this.operationController.abort(/* @__PURE__ */ new Error("subprocess-e2b: terminal is terminating"));
		const cleanup = this.closeAfterOperations();
		this.cleanup = cleanup;
		cleanup.catch((_cleanupFailure) => {
			this.cleanup = void 0;
		});
		return cleanup;
	}
	async inspectForegroundOnce(signal) {
		try {
			return {
				processGroupId: parsePositiveId((await this.sandbox.commands.run(`ps -o tpgid= -p ${this.pid}`, commandOpts(this.controlEnvs, signal))).stdout, `subprocess-e2b: cannot resolve foreground process group for terminal ${this.pid}`),
				inputWaiting: false
			};
		} catch (error) {
			if (error instanceof CommandExitError && (error.exitCode === 1 || this.topLevelExited)) return void 0;
			throw error;
		}
	}
	trackOperation(operation) {
		if (this.operationController.signal.aborted) return Promise.reject(/* @__PURE__ */ new Error("subprocess-e2b: terminal is terminating"));
		const pending = operation(this.operationController.signal);
		this.operations.add(pending);
		pending.then(() => {
			this.operations.delete(pending);
		}, () => {
			this.operations.delete(pending);
		});
		return pending;
	}
	async closeAfterOperations() {
		await Promise.allSettled(this.operations);
		await this.closeOnce();
	}
	async waitForCommand() {
		try {
			return {
				exitCode: (await this.completion).exitCode,
				signal: null
			};
		} catch (error) {
			if (error instanceof CommandExitError) return this.terminationSignal === null ? {
				exitCode: error.exitCode,
				signal: null
			} : {
				exitCode: null,
				signal: this.terminationSignal
			};
			this.output.destroy(error instanceof Error ? error : new Error(String(error)));
			throw error;
		} finally {
			this.topLevelExited = true;
			if (!this.output.destroyed) this.output.end();
		}
	}
	async closeOnce() {
		let groups = await sessionProcessGroups(this.sandbox, this.sessionId, this.controlEnvs);
		if (groups.length > 0) {
			this.terminationSignal = "SIGTERM";
			await signalRemoteGroups(this.sandbox, this.controlEnvs, groups, "TERM");
			groups = await awaitSessionEmpty(this.sandbox, this.sessionId, this.controlEnvs, this.graceMs, this.pollMs);
		}
		if (groups.length === 0 && !this.topLevelExited) await Promise.race([this.done.catch(() => void 0), delay(this.graceMs)]);
		if (groups.length > 0 || !this.topLevelExited) {
			this.terminationSignal = "SIGKILL";
			if (!this.topLevelExited) try {
				await this.handle.kill();
			} catch (error) {
				if (error instanceof SandboxNotFoundError) return;
				throw error;
			}
			groups = await awaitSessionEmpty(this.sandbox, this.sessionId, this.controlEnvs, this.graceMs, this.pollMs, true);
			if (!this.topLevelExited) await Promise.race([this.done.catch(() => void 0), delay(this.graceMs)]);
		}
		if (groups.length > 0) throw new Error(`subprocess-e2b: terminal cleanup failed; surviving process groups: ${groups.join(", ")}`);
		if (!this.topLevelExited) throw new Error(`subprocess-e2b: terminal cleanup failed; surviving pid: ${this.pid}`);
		try {
			await this.handle.disconnect();
		} catch (error) {
			if (!(error instanceof SandboxNotFoundError)) throw error;
		}
		try {
			await this.sandbox.files.remove(this.stateDir);
		} catch (_adapterPrivateStateRemovalFailure) {}
	}
};
/**
* Allocate an E2B PTY, replace its bootstrap shell with the requested argv,
* and return only after the private runner has published readiness.
* @param runtime - Shared E2B sandbox owner.
* @param spec - Fully specified terminal-process request.
* @param stateDir - Private remote directory for one startup transaction.
* @param pollMs - Remote session liveness poll cadence.
* @returns The live subprocess terminal handle.
*/
async function spawnE2BTerminal(runtime, spec, stateDir, pollMs) {
	const sandbox = await runtime.getSandbox();
	spec.signal?.throwIfAborted();
	const paths = {
		runner: posix.join(stateDir, "runner.bash"),
		environment: posix.join(stateDir, "environment"),
		argv: posix.join(stateDir, "argv"),
		outputMarker: posix.join(stateDir, "output-marker")
	};
	const outputMarker = Buffer.from(`dsh-e2b-bootstrap:${randomUUID()}`);
	const output = new PassThrough();
	const outputFilter = new BootstrapOutputFilter(outputMarker, output);
	let handle;
	let completion;
	let stateDirectoryCreated = false;
	let controlEnvs = {};
	try {
		const ambient = await readRemoteEnvironment(sandbox, spec.signal);
		controlEnvs = bootstrapEnvironment(ambient);
		const environment = serializeRemoteEnvironment(ambient, spec.env);
		const argv = serializeValues(spec.argv, "argv");
		stateDirectoryCreated = true;
		await sandbox.files.makeDir(stateDir, signalOpts(spec.signal));
		await sandbox.commands.run(`chmod 700 -- ${quoteE2BShellArg(stateDir)}`, commandOpts(controlEnvs, spec.signal));
		await sandbox.files.write([
			{
				path: paths.runner,
				data: TERMINAL_RUNNER_SOURCE
			},
			{
				path: paths.environment,
				data: environment
			},
			{
				path: paths.argv,
				data: argv
			},
			{
				path: paths.outputMarker,
				data: outputMarker.toString("utf8")
			}
		], signalOpts(spec.signal));
		await sandbox.commands.run(`chmod 600 -- ${quoteE2BShellArg(paths.runner)} ${quoteE2BShellArg(paths.environment)} ${quoteE2BShellArg(paths.argv)} ${quoteE2BShellArg(paths.outputMarker)}`, commandOpts(controlEnvs, spec.signal));
		handle = await sandbox.pty.create({
			rows: spec.rows,
			cols: spec.cols,
			cwd: spec.cwd,
			envs: e2bControlEnvs(controlEnvs),
			timeoutMs: 0,
			onData: (data) => {
				outputFilter.push(data);
			}
		});
		completion = handle.wait();
		completion.catch(() => {});
		spec.signal?.throwIfAborted();
		if (!Number.isSafeInteger(handle.pid) || handle.pid <= 0) throw new Error(`subprocess-e2b: E2B returned invalid terminal pid ${handle.pid}`);
		const command = `exec /bin/bash ${quoteE2BShellArg(paths.runner)} ${quoteE2BShellArg(stateDir)}\r`;
		await sandbox.pty.sendInput(handle.pid, Buffer.from(command), signalOpts(spec.signal));
		await waitForBootstrapOutput(outputFilter.ready, completion, spec.signal);
		const sessionId = await terminalSessionId(sandbox, handle.pid, controlEnvs, spec.signal);
		return new E2BTerminalHandle(sandbox, handle, output, completion, sessionId, controlEnvs, stateDir, spec.graceMs, pollMs);
	} catch (error) {
		output.destroy();
		let terminalQuiescent = handle === void 0;
		let stateRemoved = !stateDirectoryCreated;
		const cleanup = async () => {
			const failures = [];
			if (!terminalQuiescent && handle !== void 0) try {
				if (completion === void 0) await handle.kill();
				else await rollbackUnpublishedTerminal(sandbox, handle, completion, controlEnvs, spec.graceMs, pollMs);
				terminalQuiescent = true;
			} catch (cleanupError) {
				if (cleanupError instanceof SandboxNotFoundError) terminalQuiescent = true;
				else failures.push(asError(cleanupError));
			}
			if (!stateRemoved) try {
				await sandbox.files.remove(stateDir);
				stateRemoved = true;
			} catch (stateError) {
				if (stateError instanceof FileNotFoundError || stateError instanceof SandboxNotFoundError) stateRemoved = true;
				else failures.push(asError(stateError));
			}
			if (failures.length > 0) throw new AggregateError(failures, "subprocess-e2b: terminal setup cleanup did not complete");
		};
		try {
			await cleanup();
		} catch (cleanupError) {
			throw new AggregateError([asError(error), asError(cleanupError)], asError(error).message);
		}
		throw error;
	}
}
//#endregion
//#region lib/types/index.js
/**
* E2B Service Provider for the subprocess capability seam. Each handle starts through the
* shared sandbox and retains command output/status paths in that remote world.
* @module @deepseek-ai/dsh-subprocess-e2b
*/
/**
* Enforce the seam's documented grace bound (positive, finite, one Node timer),
* matching subprocess-local's spawn-time check; an unbounded grace would make
* the remote force-escalation deadline unreachable.
* @param graceMs - The spec's cleanup grace in milliseconds.
*/
function requireRepresentableGrace(graceMs) {
	if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > MAX_TIMER_DELAY_MS) throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
}
/** E2B command manager registered as `ctx.subprocess`. */
var E2BSubprocessRuntime = class extends SubprocessRuntime {
	static inject = ["e2b"];
	static Config = z.object({ pollMs: z.number().default(20) });
	live = /* @__PURE__ */ new Set();
	terminals = /* @__PURE__ */ new Set();
	terminalSetups = /* @__PURE__ */ new Set();
	pollMs;
	disposing = false;
	/** Create the E2B subprocess service and bind its disposal policy. */
	constructor(ctx, config) {
		super(ctx);
		const { pollMs } = config;
		if (!Number.isSafeInteger(pollMs) || pollMs <= 0) throw new Error("subprocess-e2b: pollMs must be a positive safe integer");
		this.pollMs = pollMs;
		ctx.effect(() => async () => {
			this.disposing = true;
			for (const setup of this.terminalSetups) setup.controller.abort(/* @__PURE__ */ new Error("subprocess-e2b: service disposed during terminal setup"));
			await Promise.all([...this.terminalSetups].map((setup) => setup.done));
			const handles = [...this.live];
			const terminals = [...this.terminals];
			const pending = [];
			for (const handle of handles) {
				handle.terminate();
				pending.push(handle.waitForExit().then(async () => {
					await handle.done.catch(() => void 0);
					this.live.delete(handle);
				}));
			}
			for (const terminal of terminals) pending.push(terminal.terminate().then(() => {
				this.terminals.delete(terminal);
			}));
			const failures = (await Promise.allSettled(pending)).flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
			if (failures.length === 1) throw asError(failures[0]);
			if (failures.length > 1) throw new AggregateError(failures, "subprocess-e2b: teardown failed");
		}, "e2b subprocess teardown");
	}
	/** @inheritdoc */
	async resolveExecutable(command, env, signal) {
		if (command.length === 0) throw new Error("subprocess-e2b: executable name must be non-empty");
		signal?.throwIfAborted();
		const sandbox = await this.ctx.e2b.getSandbox();
		if (posix.isAbsolute(command)) {
			await sandbox.commands.run(`test -f ${quoteE2BShellArg(command)} -a -x ${quoteE2BShellArg(command)}`, {
				envs: e2bControlEnvs(),
				...signalOpts(signal)
			});
			signal?.throwIfAborted();
			return command;
		}
		if (command.includes("/")) throw new Error(`subprocess-e2b: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`);
		const path = env?.PATH;
		const prefix = path === void 0 ? "" : `PATH=${quoteE2BShellArg(path)} `;
		const result = await sandbox.commands.run(`${prefix}command -v -- ${quoteE2BShellArg(command)}`, {
			cwd: this.ctx.e2b.cwd,
			envs: e2bControlEnvs(),
			...signalOpts(signal)
		});
		signal?.throwIfAborted();
		const executable = result.stdout.trim();
		if (executable.includes("\n") || !posix.isAbsolute(executable) && !executable.includes("/")) throw new Error(`subprocess-e2b: executable ${JSON.stringify(command)} did not resolve to one absolute path`);
		return posix.resolve(this.ctx.e2b.cwd, executable);
	}
	/** @inheritdoc */
	spawn(spec) {
		if (this.disposing) throw new Error("subprocess-e2b: service is disposing");
		const program = spec.argv[0];
		if (program === void 0 || program.length === 0) throw new Error("invalid argv: expected a non-empty program name at argv[0]");
		requireRepresentableGrace(spec.graceMs);
		if (spec.signal?.aborted === true) throw new Error(`aborted before spawn: ${String(spec.signal.reason)}`);
		const stateDir = posix.join(this.ctx.e2b.runtimeRoot, "processes", randomUUID());
		const handle = new E2BSubprocessHandle(this.ctx.e2b, spec, stateDir, this.pollMs);
		this.live.add(handle);
		const release = async () => {
			await handle.waitForExit();
			this.live.delete(handle);
		};
		handle.done.then(release, release).catch((_automaticReleaseFailure) => {});
		return handle;
	}
	/** @inheritdoc */
	async spawnTerminal(spec) {
		if (this.disposing) throw new Error("subprocess-e2b: service is disposing");
		const program = spec.argv[0];
		if (program === void 0 || program.length === 0) throw new Error("subprocess-e2b: terminal argv must contain a program");
		requireRepresentableGrace(spec.graceMs);
		spec.signal?.throwIfAborted();
		const stateDir = posix.join(this.ctx.e2b.runtimeRoot, "terminals", randomUUID());
		const done = Promise.withResolvers();
		const setup = {
			done: done.promise,
			controller: new AbortController()
		};
		const setupSignal = spec.signal === void 0 ? setup.controller.signal : AbortSignal.any([spec.signal, setup.controller.signal]);
		this.terminalSetups.add(setup);
		try {
			const terminal = await spawnE2BTerminal(this.ctx.e2b, {
				...spec,
				signal: setupSignal
			}, stateDir, this.pollMs);
			this.terminals.add(terminal);
			if (this.disposing) {
				await terminal.terminate();
				this.terminals.delete(terminal);
				throw new Error("subprocess-e2b: service disposed during terminal setup");
			}
			const release = async () => {
				await terminal.terminate();
				this.terminals.delete(terminal);
			};
			terminal.done.then(release, release).catch((_automaticReleaseFailure) => {});
			return terminal;
		} finally {
			this.terminalSetups.delete(setup);
			done.resolve();
		}
	}
};
//#endregion
export { E2BSubprocessRuntime, E2BSubprocessRuntime as default };
