Object.fromEntries(Object.entries({
	BootMessage: {
		type: "required",
		cpuSeconds: "required",
		addressSpaceBytes: "required",
		maxLogBytes: "required",
		maxValueBytes: "required",
		namespaces: "required"
	},
	Namespace: {
		global: "required",
		names: "required",
		errorClass: "optional"
	},
	RunMessage: {
		type: "required",
		program: "required"
	},
	BootAckMessage: { type: "required" },
	CallMessage: {
		type: "required",
		id: "required",
		global: "required",
		name: "required",
		args: "required"
	},
	LogMessage: {
		type: "required",
		text: "required",
		truncated: "optional"
	},
	DoneErrorField: {
		kind: "required",
		message: "required"
	},
	DoneMessage: {
		type: "required",
		value: "optional",
		error: "optional"
	},
	ErrorClass: {
		name: "required",
		memberNameProperty: "required"
	},
	ReplyOk: {
		type: "required",
		id: "required",
		ok: "required",
		value: "required"
	},
	ReplyErr: {
		type: "required",
		id: "required",
		ok: "required",
		message: "required"
	}
}).map(([frame, roles]) => {
	return [frame, {
		required: Object.keys(roles).filter((key) => roles[key] === "required").sort(),
		optional: Object.keys(roles).filter((key) => roles[key] === "optional").sort()
	}];
}));
/**
* The in-band marker text announcing that log capture stopped at the byte
* budget. Shared wire vocabulary: the Python-side LogBuffer emits it when ITS
* ledger exhausts, and the host emits identical text when its own ledger drops
* a frame first (forged fd-3 traffic, stray stdout bytes) — a truncated run
* reads the same however the cap was hit.
* @param maxBytes - the configured `maxLogBytes` the marker names.
* @returns the marker line.
*/
function logTruncationMarker(maxBytes) {
	return `[dsh-code-runtime-python] log capture truncated at ${maxBytes} bytes`;
}
/**
* Serialize one JSON-parse-produced value without recursion. `JSON.stringify`
* recurses per nesting level and throws `RangeError` a few thousand levels
* deep, but the seam's `CodeJsonValue` has no depth limit — an honest deep
* completion or binding resolution below the byte budget must cross intact
* (the worker backend's wire is equally stack-safe). Callers must pass a value
* produced by `JSON.parse` (or equally JSON-plain): only `null`, finite
* numbers, booleans, strings, dense arrays, and plain objects — this encoder
* validates nothing. Output matches compact `JSON.stringify` byte for byte
* EXCEPT on an integral double beyond the safe range, where {@link scalarJson}
* emits the exact integer's BigInt digits rather than `JSON.stringify`'s rounded
* spelling (`1152921504606846976`, not `...847000`) so the seam's lossless-JSON
* promise holds across the wire.
* @param value - a JSON-plain value (e.g. straight from `JSON.parse`).
* @returns the compact JSON encoding.
*/
function encodeJsonPlain(value) {
	const chunks = [];
	const tasks = [{ value }];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if ("text" in task) {
			chunks.push(task.text);
			continue;
		}
		const current = task.value;
		if (typeof current === "string") chunks.push(JSON.stringify(current));
		else if (Array.isArray(current)) {
			chunks.push("[");
			tasks.push({ text: "]" });
			for (let index = current.length - 1; index >= 0; index--) {
				if (index < current.length - 1) tasks.push({ text: "," });
				tasks.push({ value: current[index] });
			}
		} else if (typeof current === "object" && current !== null) {
			const record = current;
			chunks.push("{");
			tasks.push({ text: "}" });
			const keys = Object.keys(record);
			for (let index = keys.length - 1; index >= 0; index--) {
				const key = keys[index];
				if (index < keys.length - 1) tasks.push({ text: "," });
				tasks.push({ value: record[key] });
				tasks.push({ text: `${JSON.stringify(key)}:` });
			}
		} else chunks.push(scalarJson(current));
	}
	return chunks.join("");
}
/**
* One scalar (null, boolean, finite number) as JSON text. A beyond-safe-range
* integral double needs BigInt digits: `String(2 ** 60)` emits the ROUNDED
* `...847000` form, and echoing that to the child would silently change the
* integer the seam promised to carry losslessly — `BigInt(2 ** 60)` prints the
* exact `...846976` the double actually holds.
* @param current - a JSON-plain scalar (JSON.parse emits nothing else).
* @returns its JSON encoding.
*/
function scalarJson(current) {
	if (typeof current === "number" && Number.isInteger(current) && !Number.isSafeInteger(current)) return BigInt(current).toString();
	return String(current);
}
/**
* Exact UTF-8 byte length of one string's compact JSON form (quotes + escapes),
* computed by a single non-allocating scan that stops the instant the running
* total exceeds `maxBytes`. Used instead of `Buffer.byteLength(JSON.stringify(s))`
* so a control-heavy forged string — whose escaped copy expands up to ~6x — is
* rejected BEFORE that copy is materialized: `JSON.stringify` would allocate the
* full escaped form first, the very hundreds-of-MB spike the metered traversal
* exists to avoid. Mirrors `JSON.stringify`'s escaping byte-for-byte: `"` and
* `\` and the five short C0 escapes cost 2, other C0 controls `\uXXXX` cost 6, a
* valid surrogate pair is one astral code point emitted as raw 4-byte UTF-8, a
* LONE surrogate becomes `\uXXXX` at 6, and any other code point costs its raw
* UTF-8 width.
* @param text - the string to meter.
* @param maxBytes - largest serialized size the caller can still admit.
* @returns the exact serialized byte length, or `undefined` once it exceeds `maxBytes`.
*/
function jsonStringBytesUpTo(text, maxBytes) {
	let bytes = 2;
	if (bytes > maxBytes) return void 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
		else if (code < 32) bytes += 6;
		else if (code < 128) bytes += 1;
		else if (code < 2048) bytes += 2;
		else if (code >= 55296 && code <= 56319 && index + 1 < text.length) {
			const next = text.charCodeAt(index + 1);
			if (next >= 56320 && next <= 57343) {
				bytes += 4;
				index++;
			} else bytes += 6;
		} else if (code >= 55296 && code <= 57343) bytes += 6;
		else bytes += 3;
		if (bytes > maxBytes) return void 0;
	}
	return bytes;
}
/**
* Meter a `JSON.parse`-produced done value's compact-JSON byte length AND its
* number losslessness in one traversal, stopping the instant `maxBytes` is
* crossed. This bounds the INCREMENTAL allocation the check itself would add on
* top of the already-parsed value — the enqueued children; strings and keys are
* metered by {@link jsonStringBytesUpTo} without allocating an escaped copy —
* not the parse that produced `value`.
* That upstream width is bounded separately, by the host-side cap on inbound
* fd-3 frame size before `JSON.parse` runs (owned by the runtime that reads the
* channel), so `value` cannot be arbitrarily large when it reaches here. The
* budget is the `maxValueBytes` the boot frame carries — a required wire field
* with no default at this layer. The traversal rejects over-budget BEFORE
* materializing a string's escaped form or enqueuing an array's/object's
* children, so a forgery within that frame cap cannot force those secondary
* allocations. Object key COUNTING is
* unavoidably O(keys) — JS has no lazy own-key iterator, and the parse already
* built the key set — but the check still refuses the per-entry work before the
* enqueue loop. A non-lossless number (non-finite, negative zero) is caught only
* when the value fits the budget — an over-budget value is rejected regardless,
* so the distinction is moot. Same JSON-plain precondition and traversal shape
* as {@link encodeJsonPlain}; a number's byte length is measured through
* {@link scalarJson} (matching the encoder, so a beyond-safe-range integer
* meters its exact BigInt digits, not `JSON.stringify`'s rounded spelling) and
* a string's/key's through {@link jsonStringBytesUpTo} (the exact escaped size,
* scanned without allocating the escaped copy).
* @param value - a JSON-plain value (e.g. straight from `JSON.parse`).
* @param maxBytes - the completion-value budget in bytes.
* @returns `{ ok: true, bytes }` with the exact serialized size, or
* `{ ok: false, reason }` — `over-budget` once the size exceeds `maxBytes`,
* `non-lossless` on a non-finite or negative-zero number.
*/
function checkDoneValue(value, maxBytes) {
	let bytes = 0;
	let nonLossless = false;
	const stack = [value];
	while (stack.length > 0) {
		const current = stack.pop();
		if (typeof current === "number") {
			if (!Number.isFinite(current) || Object.is(current, -0)) nonLossless = true;
			bytes += Buffer.byteLength(scalarJson(current), "utf8");
		} else if (typeof current === "string") {
			const stringBytes = jsonStringBytesUpTo(current, maxBytes - bytes);
			if (stringBytes === void 0) return {
				ok: false,
				reason: "over-budget"
			};
			bytes += stringBytes;
		} else if (Array.isArray(current)) {
			bytes += 2 + (current.length > 1 ? current.length - 1 : 0);
			if (bytes + current.length > maxBytes) return {
				ok: false,
				reason: "over-budget"
			};
			for (const item of current) stack.push(item);
		} else if (typeof current === "object" && current !== null) {
			const record = current;
			let count = 0;
			for (const key in record) if (Object.hasOwn(record, key)) count += 1;
			bytes += 2 + (count > 1 ? count - 1 : 0);
			if (bytes + count * 4 > maxBytes) return {
				ok: false,
				reason: "over-budget"
			};
			for (const key in record) {
				if (!Object.hasOwn(record, key)) continue;
				const keyBytes = jsonStringBytesUpTo(key, maxBytes - bytes);
				if (keyBytes === void 0) return {
					ok: false,
					reason: "over-budget"
				};
				bytes += keyBytes + 1;
				stack.push(record[key]);
			}
		} else bytes += Buffer.byteLength(scalarJson(current), "utf8");
		if (bytes > maxBytes) return {
			ok: false,
			reason: "over-budget"
		};
	}
	if (nonLossless) return {
		ok: false,
		reason: "non-lossless"
	};
	return {
		ok: true,
		bytes
	};
}
/**
* Whether a raw JSON line contains an integer token that would lose precision
* as a JavaScript number. `JSON.parse` silently rounds such a token
* (`9007199254740993` becomes `...992`) BEFORE any validation can see it, so
* the check must read the source text; a beyond-safe-range token whose double
* parse round-trips exactly (`2**53`, `2**60`) is lossless and passes. The scan walks the line skipping string literals (a digit run
* inside a string is data, not a number token) and tests every number token
* in plain integer form — no fraction or exponent, which parse as doubles by
* intent. A reviver cannot do this job: the reviver walk recurses per nesting
* level and would reintroduce the depth limit `encodeJsonPlain` removes.
* @param line - the raw UTF-8 text of one JSON-lines frame.
* @returns true when an unsafe integer token is present outside strings.
*/
function hasUnsafeIntegerToken(line) {
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (char === "\"") {
			for (index++; index < line.length; index++) if (line[index] === "\\") index++;
			else if (line[index] === "\"") break;
			continue;
		}
		if (char === "-" || char !== void 0 && char >= "0" && char <= "9") {
			let end = index + 1;
			while (end < line.length) {
				const c = line[end];
				if (c >= "0" && c <= "9" || c === "." || c === "e" || c === "E" || c === "+" || c === "-") end++;
				else break;
			}
			const token = line.slice(index, end);
			if (/^-?\d+$/.test(token)) {
				const parsed = Number(token);
				if (!Number.isFinite(parsed)) return true;
				if (!Number.isSafeInteger(parsed) && BigInt(token) !== BigInt(parsed)) return true;
			}
			index = end - 1;
		}
	}
	return false;
}
/**
* Lazily yield one plain object's own enumerable property values. A generator
* (not `Object.values`/`Object.entries`) because {@link hasNonLosslessNumber}
* walks breadth it cannot bound: those helpers copy the whole VALUE (or
* key/value pair) list into a fresh array up front, so a wide object would cost
* that second full-breadth allocation before a single value is examined. The
* `for...in` here does not make the walk sublinear — V8 still materializes the
* key-name enumeration when the loop starts — but it avoids the extra value
* array, yielding each value straight off the already-parsed object.
* @param record - a JSON-parse-produced object.
* @yields each own enumerable property value, in key order.
*/
function* ownValues(record) {
	for (const key in record) if (Object.hasOwn(record, key)) yield record[key];
}
/**
* Whether a JSON.parse-produced value contains a number outside lossless
* JSON: non-finite (`1e400` parses to `Infinity`) or negative zero (`-0.0`
* parses to JS `-0`, whose sign bit a re-serialization drops). The honest
* child's validator rejects these before sending, so a frame carrying one is
* forged.
*
* Runs on `call.args`, which — unlike a completion value — has NO seam byte
* cap, so there is no budget to reject a wide payload against the way
* {@link checkDoneValue} does. The traversal therefore holds ONE cursor per
* NESTING LEVEL (an array or {@link ownValues} iterator) instead of one entry
* per member: a forged flat `args` at the top of the host's inbound frame-size
* cap would
* otherwise push tens of millions of stack entries — and `Object.values` would
* copy each object's full breadth — allocating hundreds of megabytes beyond
* what `JSON.parse` already holds. Iterative either way, so a deep frame
* cannot overflow the host stack.
* @param value - a JSON-parse-produced value from an fd-3 frame.
* @returns true when any contained number is non-finite or negative zero.
*/
function hasNonLosslessNumber(value) {
	const cursors = [[value].values()];
	while (cursors.length > 0) {
		const step = cursors.at(-1).next();
		if (step.done === true) {
			cursors.pop();
			continue;
		}
		const current = step.value;
		if (typeof current === "number") {
			if (!Number.isFinite(current) || Object.is(current, -0)) return true;
		} else if (Array.isArray(current)) cursors.push(current.values());
		else if (typeof current === "object" && current !== null) cursors.push(ownValues(current));
	}
	return false;
}
/**
* Runtime shape gate for inbound fd-3 traffic. Model code has full access to
* fd 3 and can post anything — `null`, primitives, poisoned fields — so the
* compile-time union means nothing here: every field is validated and REBUILT
* before the host reads it (forged extras never ride along; a non-number id
* can never be echoed into a reply). Junk returns `undefined` and is dropped
* so a throw in the host's `message` handler cannot crash the host process.
* @param raw - one JSON-parsed frame from fd 3.
* @returns the rebuilt frame, or `undefined` to drop it silently.
*/
function validateChildFrame(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const m = raw;
	switch (m.type) {
		case "boot-ack": return { type: "boot-ack" };
		case "log":
			if (typeof m.text !== "string") return void 0;
			return {
				type: "log",
				text: m.text,
				...m.truncated === true ? { truncated: true } : {}
			};
		case "call":
			if (typeof m.id !== "number" || !Number.isFinite(m.id) || Object.is(m.id, -0) || typeof m.global !== "string" || typeof m.name !== "string") return void 0;
			if (!Object.hasOwn(m, "args")) return void 0;
			if (hasNonLosslessNumber(m.args)) return void 0;
			return {
				type: "call",
				id: m.id,
				global: m.global,
				name: m.name,
				args: m.args
			};
		case "done": {
			const err = m.error;
			if (err === void 0) return m.value === void 0 ? { type: "done" } : {
				type: "done",
				value: m.value
			};
			if (typeof err !== "object" || err === null) return void 0;
			const { kind, message } = err;
			if (typeof message !== "string") return void 0;
			if (kind !== "exception" && kind !== "invalid-output" && kind !== "output-limit") return void 0;
			return m.value === void 0 ? {
				type: "done",
				error: {
					kind,
					message
				}
			} : {
				type: "done",
				value: m.value,
				error: {
					kind,
					message
				}
			};
		}
		default: return;
	}
}
//#endregion
export { checkDoneValue, encodeJsonPlain, hasNonLosslessNumber, hasUnsafeIntegerToken, logTruncationMarker, validateChildFrame };
