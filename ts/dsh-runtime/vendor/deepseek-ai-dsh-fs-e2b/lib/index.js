import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { FileSystem, FsError, FsTargetKey, FsVersion } from "@deepseek-ai/dsh-fs";
import { CommandExitError, FileNotFoundError, FileType, e2bControlEnvs, quoteE2BShellArg } from "@deepseek-ai/dsh-e2b";
//#region lib/types/index.js
/**
* E2B provider for the filesystem capability seam. Paths, contents, and
* atomic staging files remain inside the shared remote sandbox.
* @module @deepseek-ai/dsh-fs-e2b
*/
const VERSION_METADATA_KEY = "dsh-version";
const BINARY_SAMPLE_BYTES = 8192;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
function assertNotAborted(signal, operation) {
	if (signal?.aborted === true) throw new FsError(`${operation} aborted`, "FS_ABORTED");
}
function normalizeLineEndings(value) {
	return value.replaceAll("\r\n", "\n");
}
function detectsCrlf(value) {
	const sample = value.slice(0, 4096);
	const crlf = sample.split("\r\n").length - 1;
	return crlf > sample.split("\n").length - 1 - crlf;
}
function restoreLineEndings(value, crlf) {
	return crlf ? normalizeLineEndings(value).replaceAll("\n", "\r\n") : value;
}
function decodeText(bytes, displayPath, binarySampleBytes) {
	if (bytes.subarray(0, binarySampleBytes).includes(0)) throw new FsError(`cannot read "${displayPath}": binary file`, "FS_NOT_TEXT");
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, "FS_NOT_TEXT", { cause: error });
	}
}
function decodeCanonicalPath(encoded) {
	if (encoded.length === 0 || !BASE64.test(encoded)) throw new Error("fs-e2b: canonical path transport returned invalid base64");
	const framed = Buffer.from(encoded, "base64");
	if (framed.toString("base64") !== encoded || framed.length < 2 || framed.at(-1) !== 0 || framed.subarray(0, -1).includes(0)) throw new Error("fs-e2b: canonical path transport returned invalid NUL framing");
	let path;
	try {
		path = new TextDecoder("utf-8", { fatal: true }).decode(framed.subarray(0, -1));
	} catch (error) {
		throw new Error("fs-e2b: canonical path is not valid UTF-8", { cause: error });
	}
	if (!posix.isAbsolute(path)) throw new Error("fs-e2b: canonical path is not absolute");
	return path;
}
function signalOpts(signal) {
	return signal === void 0 ? {} : { signal };
}
function commandOpts(signal) {
	return {
		envs: e2bControlEnvs(),
		...signalOpts(signal)
	};
}
async function openReadStream(sandbox, target, signal) {
	try {
		const read = await sandbox.files.read(String(target.targetKey), {
			format: "stream",
			...signalOpts(signal)
		});
		return typeof read === "string" ? new ReadableStream({ start(controller) {
			controller.close();
		} }) : read;
	} catch (error) {
		throw mapError(error, "read", target.displayPath, signal);
	}
}
function entryType(entry) {
	switch (entry.type) {
		case FileType.FILE: return "file";
		case FileType.DIR: return "directory";
		default: return "other";
	}
}
function entryVersion(entry) {
	const facts = JSON.stringify([
		entry.metadata?.[VERSION_METADATA_KEY],
		entry.path,
		entry.type,
		entry.size,
		entry.mode,
		entry.modifiedTime?.toISOString(),
		entry.symlinkTarget
	]);
	return FsVersion(`e2b:${createHash("sha256").update(facts).digest("hex")}`);
}
function mapError(error, operation, displayPath, signal) {
	if (error instanceof FsError) return error;
	if (signal?.aborted === true || error instanceof DOMException && error.name === "AbortError") return new FsError(`${operation} aborted`, "FS_ABORTED", { cause: error });
	if (error instanceof FileNotFoundError) return new FsError(`cannot ${operation} "${displayPath}": not found`, "FS_NOT_FOUND", { cause: error });
	if (/permission denied|operation not permitted/i.test(String(error))) return new FsError(`cannot ${operation} "${displayPath}": permission denied`, "FS_PERMISSION_DENIED", { cause: error });
	return new FsError(`cannot ${operation} "${displayPath}": ${String(error)}`, "FS_IO_ERROR", { cause: error });
}
function literalEdit(content, request, displayPath) {
	const oldString = normalizeLineEndings(request.oldString);
	const newString = normalizeLineEndings(request.newString);
	if (oldString.length === 0) throw new FsError(`cannot edit "${displayPath}": old_string must be non-empty`, "FS_EDIT_NOT_FOUND");
	let matches = 0;
	let offset = 0;
	while (true) {
		const found = content.indexOf(oldString, offset);
		if (found < 0) break;
		matches += 1;
		offset = found + oldString.length;
	}
	if (matches === 0) throw new FsError(`cannot edit "${displayPath}": old_string was not found`, "FS_EDIT_NOT_FOUND");
	if (!request.replaceAll && matches !== 1) throw new FsError(`cannot edit "${displayPath}": old_string matched ${matches} times`, "FS_AMBIGUOUS_EDIT");
	return request.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
}
/** Remote filesystem backend sharing the sandbox owned by `ctx.e2b`. */
var E2BFileSystem = class extends FileSystem {
	static inject = ["e2b"];
	locks = /* @__PURE__ */ new Map();
	async resolve(path, opts) {
		assertNotAborted(opts?.signal, "resolve");
		if (path.trim().length === 0) throw new FsError("file_path must be a non-empty string", "FS_NOT_FOUND");
		const displayPath = posix.resolve(opts?.cwd ?? this.ctx.e2b.cwd, path);
		try {
			const sandbox = await this.ctx.e2b.getSandbox();
			const targetKey = await this.canonicalPath(sandbox, displayPath, opts?.signal);
			assertNotAborted(opts?.signal, "resolve");
			return {
				targetKey: FsTargetKey(targetKey),
				displayPath
			};
		} catch (error) {
			throw mapError(error, "resolve", displayPath, opts?.signal);
		}
	}
	processPath(target) {
		return String(target.targetKey);
	}
	fileUrl(target) {
		const path = this.processPath(target);
		if (!posix.isAbsolute(path)) throw new Error(`fs-e2b: expected an absolute process path: ${JSON.stringify(path)}`);
		return `file://${path.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
	}
	contains(parent, child) {
		const relative = posix.relative(this.processPath(parent), this.processPath(child));
		return relative === "" || relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative);
	}
	async stat(target, signal) {
		assertNotAborted(signal, "stat");
		const entry = await this.probe(String(target.targetKey), target.displayPath, signal);
		if (entry === void 0) return void 0;
		return {
			version: entryVersion(entry),
			type: entryType(entry),
			...entry.type === FileType.FILE ? { size: entry.size } : {}
		};
	}
	async lstat(path, opts, signal) {
		assertNotAborted(signal, "lstat");
		if (path.trim().length === 0) throw new FsError("file_path must be a non-empty string", "FS_NOT_FOUND");
		const displayPath = posix.resolve(opts?.cwd ?? this.ctx.e2b.cwd, path);
		const entry = await this.probe(displayPath, displayPath, signal);
		if (entry === void 0) return void 0;
		const type = entry.symlinkTarget !== void 0 ? "symlink" : entry.type === FileType.FILE ? "file" : entry.type === FileType.DIR ? "directory" : "other";
		return {
			version: entryVersion(entry),
			type,
			...entry.type === FileType.FILE ? { size: entry.size } : {}
		};
	}
	async readText(target, signal) {
		const sandbox = await this.ctx.e2b.getSandbox();
		await this.requireRegular(target, signal);
		try {
			const bytes = await sandbox.files.read(String(target.targetKey), {
				format: "bytes",
				...signalOpts(signal)
			});
			assertNotAborted(signal, "read");
			return decodeText(bytes, target.displayPath, BINARY_SAMPLE_BYTES);
		} catch (error) {
			throw mapError(error, "read", target.displayPath, signal);
		}
	}
	async readBytes(target, signal, maxBytes) {
		const sandbox = await this.ctx.e2b.getSandbox();
		const info = await this.requireRegular(target, signal);
		if (info.size !== void 0 && info.size > maxBytes) throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, "FS_TOO_LARGE");
		const reader = (await openReadStream(sandbox, target, signal)).getReader();
		const chunks = [];
		let bytes = 0;
		let completed = false;
		try {
			while (true) {
				assertNotAborted(signal, "read");
				const next = await reader.read();
				if (next.done) break;
				bytes += next.value.byteLength;
				if (bytes > maxBytes) throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, "FS_TOO_LARGE");
				chunks.push(next.value);
			}
			completed = true;
		} catch (error) {
			throw mapError(error, "read", target.displayPath, signal);
		} finally {
			if (!completed) try {
				await reader.cancel();
			} catch (_streamCancellationFailure) {}
			reader.releaseLock();
		}
		const whole = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			whole.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return whole;
	}
	async streamText(target, signal) {
		const sandbox = await this.ctx.e2b.getSandbox();
		await this.requireRegular(target, signal);
		const stream = await openReadStream(sandbox, target, signal);
		const displayPath = target.displayPath;
		return { async *[Symbol.asyncIterator]() {
			const reader = stream.getReader();
			const decoder = new TextDecoder("utf-8", { fatal: true });
			let sampledBytes = 0;
			let completed = false;
			try {
				while (true) {
					assertNotAborted(signal, "read");
					const next = await reader.read();
					if (next.done) break;
					if (sampledBytes < BINARY_SAMPLE_BYTES) {
						const sample = next.value.subarray(0, BINARY_SAMPLE_BYTES - sampledBytes);
						if (sample.includes(0)) throw new FsError(`cannot read "${displayPath}": binary file`, "FS_NOT_TEXT");
						sampledBytes += sample.length;
					}
					let text;
					try {
						text = decoder.decode(next.value, { stream: true });
					} catch (error) {
						throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, "FS_NOT_TEXT", { cause: error });
					}
					if (text.length > 0) yield text;
				}
				try {
					decoder.decode();
				} catch (error) {
					throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, "FS_NOT_TEXT", { cause: error });
				}
				completed = true;
			} catch (error) {
				throw mapError(error, "read", displayPath, signal);
			} finally {
				if (!completed) try {
					await reader.cancel();
				} catch (_streamCancellationFailure) {}
				reader.releaseLock();
			}
		} };
	}
	async listDir(target, signal) {
		const info = await this.stat(target, signal);
		if (info === void 0) throw new FsError(`cannot list "${target.displayPath}": not found`, "FS_NOT_FOUND");
		if (info.type !== "directory") throw new FsError(`cannot list "${target.displayPath}": not a directory`, "FS_NOT_DIRECTORY");
		try {
			const sandbox = await this.ctx.e2b.getSandbox();
			const listed = await sandbox.files.list(String(target.targetKey), {
				depth: 1,
				...signalOpts(signal)
			});
			const entries = [];
			for (const entry of listed) {
				const displayPath = posix.join(target.displayPath, entry.name);
				const canonical = entry.symlinkTarget === void 0 ? entry.path : await this.canonicalPath(sandbox, entry.path, signal);
				const resolved = entry.symlinkTarget === void 0 ? entry : await this.probe(canonical, displayPath, signal);
				entries.push({
					name: entry.name,
					type: resolved === void 0 ? "other" : entryType(resolved),
					target: {
						targetKey: FsTargetKey(canonical),
						displayPath
					},
					...resolved !== void 0 ? { version: entryVersion(resolved) } : {},
					...resolved?.type === FileType.FILE ? { size: resolved.size } : {}
				});
			}
			return entries.sort((left, right) => left.name.localeCompare(right.name));
		} catch (error) {
			throw mapError(error, "list", target.displayPath, signal);
		}
	}
	async writeText(target, content, expected, signal) {
		return this.withLock(String(target.targetKey), async () => {
			const existing = await this.probe(String(target.targetKey), target.displayPath, signal);
			if (existing !== void 0 && entryType(existing) !== "file") throw new FsError(`cannot write "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
			this.checkWriteIntent(existing, expected, target);
			const before = existing === void 0 ? null : await this.readForDiff(target, signal);
			const version = await this.writeAtomic(target, content, existing, expected?.kind === "createIfAbsent", signal);
			return {
				operation: existing === void 0 ? "create" : "update",
				version,
				before,
				after: normalizeLineEndings(content)
			};
		});
	}
	async editText(target, edit, expected, signal) {
		return this.withLock(String(target.targetKey), async () => {
			const existing = await this.probe(String(target.targetKey), target.displayPath, signal);
			if (existing === void 0) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
			if (entryType(existing) !== "file") throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
			if (expected !== void 0 && entryVersion(existing) !== expected.version) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
			const raw = await this.readForEdit(target, signal);
			const before = normalizeLineEndings(raw);
			const after = literalEdit(before, edit, target.displayPath);
			const storage = restoreLineEndings(after, detectsCrlf(raw));
			return {
				version: await this.writeAtomic(target, storage, existing, false, signal),
				before,
				after
			};
		});
	}
	async withLock(targetKey, operation) {
		const run = (this.locks.get(targetKey) ?? Promise.resolve()).then(operation, operation);
		const tail = run.then(() => void 0, () => void 0);
		this.locks.set(targetKey, tail);
		try {
			return await run;
		} finally {
			if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey);
		}
	}
	async canonicalPath(sandbox, path, signal) {
		try {
			return decodeCanonicalPath((await sandbox.commands.run(`set -o pipefail; realpath -mz -- ${quoteE2BShellArg(path)} | base64 -w0`, commandOpts(signal))).stdout);
		} catch (error) {
			if (error instanceof CommandExitError) throw new Error(error.stderr || error.message, { cause: error });
			throw error;
		}
	}
	async probe(path, displayPath, signal) {
		assertNotAborted(signal, "stat");
		try {
			const entry = await (await this.ctx.e2b.getSandbox()).files.getInfo(path, signalOpts(signal));
			assertNotAborted(signal, "stat");
			return entry;
		} catch (error) {
			if (error instanceof FileNotFoundError) return void 0;
			throw mapError(error, "stat", displayPath, signal);
		}
	}
	async requireRegular(target, signal) {
		const info = await this.stat(target, signal);
		if (info === void 0) throw new FsError(`cannot read "${target.displayPath}": not found`, "FS_NOT_FOUND");
		if (info.type !== "file") throw new FsError(`cannot read "${target.displayPath}": not a regular file`, "FS_NOT_REGULAR_FILE");
		return info;
	}
	checkWriteIntent(existing, expected, target) {
		if (expected?.kind === "createIfAbsent" && existing !== void 0) throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, "FS_NOT_OBSERVED");
		if (expected?.kind === "replaceIfVersion") {
			if (existing === void 0 || entryVersion(existing) !== expected.version) throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, "FS_STALE_VERSION");
		}
	}
	async readForDiff(target, signal) {
		try {
			const bytes = await (await this.ctx.e2b.getSandbox()).files.read(String(target.targetKey), {
				format: "bytes",
				...signalOpts(signal)
			});
			assertNotAborted(signal, "read");
			return normalizeLineEndings(decodeText(bytes, target.displayPath, bytes.length));
		} catch (error) {
			if (error instanceof FsError && error.code === "FS_NOT_TEXT") return null;
			throw mapError(error, "read", target.displayPath, signal);
		}
	}
	async readForEdit(target, signal) {
		try {
			const bytes = await (await this.ctx.e2b.getSandbox()).files.read(String(target.targetKey), {
				format: "bytes",
				...signalOpts(signal)
			});
			assertNotAborted(signal, "edit");
			return decodeText(bytes, target.displayPath, bytes.length);
		} catch (error) {
			throw mapError(error, "edit", target.displayPath, signal);
		}
	}
	async writeAtomic(target, content, existing, createIfAbsent, signal) {
		assertNotAborted(signal, "write");
		const sandbox = await this.ctx.e2b.getSandbox();
		const targetPath = String(target.targetKey);
		const versionId = randomUUID();
		const stagingDirectory = posix.join(posix.dirname(targetPath), `.dsh-${randomUUID()}.tmp`);
		const temporary = posix.join(stagingDirectory, "content");
		let stagingDirectoryCreated = false;
		try {
			if (!await sandbox.files.makeDir(stagingDirectory, signalOpts(signal))) throw new Error("private staging directory already exists");
			stagingDirectoryCreated = true;
			await sandbox.commands.run(`chmod 700 -- ${quoteE2BShellArg(stagingDirectory)}`, commandOpts(signal));
			assertNotAborted(signal, "write");
			await sandbox.files.write(temporary, content, {
				metadata: { [VERSION_METADATA_KEY]: versionId },
				...signalOpts(signal)
			});
			assertNotAborted(signal, "write");
			const mode = existing === void 0 ? 384 : existing.mode & 511;
			await sandbox.commands.run(`chmod ${mode.toString(8)} -- ${quoteE2BShellArg(temporary)}`, commandOpts(signal));
			assertNotAborted(signal, "write");
			let committed;
			if (createIfAbsent) {
				const staged = await sandbox.files.getInfo(temporary, signalOpts(signal));
				assertNotAborted(signal, "write");
				const targetArg = quoteE2BShellArg(targetPath);
				const publication = await sandbox.commands.run(`if ln -T -- ${quoteE2BShellArg(temporary)} ${targetArg}; then printf created; elif test -e ${targetArg} || test -L ${targetArg}; then printf exists; else exit 1; fi`, commandOpts(void 0));
				if (publication.stdout === "exists") throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, "FS_NOT_OBSERVED");
				if (publication.stdout !== "created") throw new Error("guarded create returned an invalid publication result");
				committed = {
					...staged,
					name: posix.basename(targetPath),
					path: targetPath
				};
			} else committed = await sandbox.files.rename(temporary, targetPath);
			try {
				await sandbox.files.remove(stagingDirectory);
			} catch (_committedStagingCleanupFailure) {}
			return entryVersion(committed);
		} catch (error) {
			if (stagingDirectoryCreated) try {
				await sandbox.files.remove(stagingDirectory);
			} catch (_stagingDirectoryAlreadyAbsentOrCleanupFailed) {}
			throw mapError(error, "write", target.displayPath, signal);
		}
	}
};
//#endregion
export { E2BFileSystem, E2BFileSystem as default };
