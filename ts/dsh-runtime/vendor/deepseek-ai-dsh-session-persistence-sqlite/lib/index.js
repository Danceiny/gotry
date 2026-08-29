import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { DEFAULT_PREPARED_SESSION_CACHE_SIZE, DEFAULT_WRITE_BATCH_MAX_DELAY_MS, MAX_WRITE_BATCH_DELAY_MS, PersistenceCoordinator, SessionPersistence, SessionPersistenceRevision } from "@deepseek-ai/dsh-session-persistence";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { SessionId } from "@deepseek-ai/dsh-session";
import { fileURLToPath } from "node:url";
/** Maximum logical members represented by one packed physical record. */
const MAX_PACKED_ROW_MEMBERS = 1024;
/** Maximum UTF-8 bytes in one packed physical record's data column. */
const MAX_PACKED_DATA_BYTES = 1048576;
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function hasExactKeys(value, keys) {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
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
	if (!isRecord(data) || !hasExactKeys(data, [
		"turn",
		"step",
		"chunk"
	])) return void 0;
	if (typeof data.turn !== "number" || typeof data.step !== "number") return void 0;
	const chunk = data.chunk;
	if (!isRecord(chunk) || typeof chunk.index !== "number") return void 0;
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
function toolCallOf(event) {
	return event.data.chunk;
}
function indexOf(event) {
	return event.data.chunk.index;
}
function continues(previous, next, kind) {
	if (next.seq !== previous.seq + 1 || !Number.isSafeInteger(next.time - previous.time)) return false;
	if (next.data.turn !== previous.data.turn || next.data.step !== previous.data.step) return false;
	if (indexOf(next) !== indexOf(previous)) return false;
	if (kind !== "tool-call-delta") return true;
	const left = toolCallOf(previous);
	const right = toolCallOf(next);
	return left.id === right.id && Object.hasOwn(left, "name") === Object.hasOwn(right, "name") && left.name === right.name;
}
function buildRow(kind, run) {
	const first = run[0];
	const base = {
		turn: first.data.turn,
		step: first.data.step,
		index: indexOf(first),
		dt: run.slice(1).map((event, index) => event.time - run[index].time)
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
				id: call.id,
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
function packedDataBytes(row) {
	return Buffer.byteLength(JSON.stringify(row.data));
}
function emitBoundedRun(out, kind, completeRun) {
	let offset = 0;
	while (completeRun.length - offset >= 3) {
		let low = 3;
		let high = Math.min(completeRun.length - offset, MAX_PACKED_ROW_MEMBERS);
		const largest = buildRow(kind, completeRun.slice(offset, offset + high));
		if (packedDataBytes(largest) <= 1048576) {
			out.push(largest);
			offset += high;
			continue;
		}
		high -= 1;
		let accepted = 0;
		let acceptedRow;
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			const candidate = buildRow(kind, completeRun.slice(offset, offset + middle));
			if (packedDataBytes(candidate) <= 1048576) {
				accepted = middle;
				acceptedRow = candidate;
				low = middle + 1;
			} else high = middle - 1;
		}
		if (accepted === 0) {
			out.push(completeRun[offset]);
			offset += 1;
			continue;
		}
		/* v8 ignore next -- accepted is set only with its same-branch candidate. */
		out.push(acceptedRow ?? malformed(kind, "bounded encoder lost its accepted row"));
		offset += accepted;
	}
	out.push(...completeRun.slice(offset));
}
/**
* Pack eligible logical chunk runs into bounded schema-19 records.
* @param events - logical events in sequence order.
* @returns scalar and packed physical records in equivalent order.
*/
function packChunkRuns(events) {
	const out = [];
	let kind;
	let run = [];
	const flush = () => {
		if (kind === void 0) out.push(...run);
		else emitBoundedRun(out, kind, run);
		kind = void 0;
		run = [];
	};
	for (const event of events) {
		const nextKind = classify(event);
		if (nextKind === void 0) {
			flush();
			out.push(event);
			continue;
		}
		const delta = event;
		const previous = run.at(-1);
		if (nextKind === kind && previous !== void 0 && continues(previous, delta, nextKind)) {
			run.push(delta);
			continue;
		}
		flush();
		kind = nextKind;
		run = [delta];
	}
	flush();
	return out;
}
function malformed(tag, reason) {
	throw new Error(`malformed ${tag} storage row: ${reason}`);
}
function validateRunData(tag, data, payloadKey, serializedBytes) {
	if (typeof data.turn !== "number" || typeof data.step !== "number" || typeof data.index !== "number") malformed(tag, "turn/step/index must be numbers");
	const payload = data[payloadKey];
	if (!Array.isArray(payload) || payload.length < 3 || payload.length > 1024 || payload.some((member) => typeof member !== "string")) malformed(tag, `${payloadKey} must contain 3..${MAX_PACKED_ROW_MEMBERS} strings`);
	const gaps = data.dt;
	if (!Array.isArray(gaps) || gaps.some((gap) => !Number.isSafeInteger(gap))) malformed(tag, "dt must be an array of safe integers");
	if (gaps.length !== payload.length - 1) malformed(tag, "dt length must match the member count");
	if ((serializedBytes ?? Buffer.byteLength(JSON.stringify(data))) > 1048576) malformed(tag, `data exceeds ${MAX_PACKED_DATA_BYTES} UTF-8 bytes`);
	return payload;
}
function validateRow(value, tag, serializedBytes) {
	if (!hasExactKeys(value, [
		"type",
		"seq0",
		"time0",
		"data"
	])) malformed(tag, "invalid envelope fields");
	if (!Number.isSafeInteger(value.seq0) || value.seq0 < 0) malformed(tag, "seq0 must be non-negative");
	if (!Number.isSafeInteger(value.time0)) malformed(tag, "time0 must be a safe integer");
	const data = value.data;
	if (!isRecord(data)) malformed(tag, "data must be an object");
	let payload;
	if (tag === "tool-call-chunks") {
		const withName = hasExactKeys(data, [
			"turn",
			"step",
			"index",
			"id",
			"name",
			"dt",
			"args"
		]);
		if (!withName && !hasExactKeys(data, [
			"turn",
			"step",
			"index",
			"id",
			"dt",
			"args"
		])) malformed(tag, "invalid tool-call data fields");
		if (typeof data.id !== "string" || withName && typeof data.name !== "string") malformed(tag, "id and optional name must be strings");
		payload = validateRunData(tag, data, "args", serializedBytes);
	} else {
		if (!hasExactKeys(data, [
			"turn",
			"step",
			"index",
			"dt",
			"texts"
		])) malformed(tag, "invalid text data fields");
		payload = validateRunData(tag, data, "texts", serializedBytes);
	}
	if (!Number.isSafeInteger(value.seq0 + payload.length - 1)) malformed(tag, "member seqs exceed safe integers");
	let time = value.time0;
	for (const gap of data.dt) {
		time += gap;
		if (!Number.isSafeInteger(time)) malformed(tag, "member times exceed safe integers");
	}
	return value;
}
function expandRow(row) {
	const members = row.type === "tool-call-chunks" ? row.data.args : row.data.texts;
	const events = [];
	let time = row.time0;
	for (let index = 0; index < members.length; index += 1) {
		if (index > 0) time += row.data.dt[index - 1];
		let chunk;
		switch (row.type) {
			case "text-chunks":
				chunk = {
					type: "text-delta",
					index: row.data.index,
					text: members[index]
				};
				break;
			case "reasoning-chunks":
				chunk = {
					type: "reasoning-delta",
					index: row.data.index,
					text: members[index]
				};
				break;
			case "tool-call-chunks":
				chunk = {
					type: "tool-call-delta",
					index: row.data.index,
					id: row.data.id,
					...Object.hasOwn(row.data, "name") ? { name: row.data.name } : {},
					argumentsDelta: members[index]
				};
				break;
		}
		events.push({
			type: "assistant/chunk",
			seq: row.seq0 + index,
			time,
			data: {
				turn: row.data.turn,
				step: row.data.step,
				chunk
			}
		});
	}
	return events;
}
/**
* Decode one packed row from its exact uncompressed data value. The byte bound
* rejects oversized input before JSON parsing and avoids serializing it again.
* @param tag - validated packed physical type.
* @param seq0 - first represented logical sequence number.
* @param time0 - first represented logical timestamp.
* @param serializedData - decoded SQLite data-column text.
* @returns the represented logical events.
*/
function decodeSerializedChunkRow(tag, seq0, time0, serializedData) {
	const bytes = Buffer.byteLength(serializedData);
	if (bytes > 1048576) malformed(tag, `data exceeds ${MAX_PACKED_DATA_BYTES} UTF-8 bytes`);
	return expandRow(validateRow({
		type: tag,
		seq0,
		time0,
		data: JSON.parse(serializedData)
	}, tag, bytes));
}
//#endregion
//#region lib/types/compression.js
/**
* Fixed physical-record compression for SQLite. Schema-owned functions
* encode logical events and decode tagged rows before persistence consumers
* observe them.
* @module @deepseek-ai/dsh-session-persistence-sqlite/compression
*/
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const ZSTD_COMPRESSION_LEVEL = 3;
const DELTA_TAG = 0;
const RUN_TAG = 1;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_ZIGZAG_INTEGER = MAX_SAFE_INTEGER * 2n;
/**
* Schema-19 raw-content zstd dictionary for independently decodable data rows.
* Its exact bytes are part of the physical format; changing the resource
* requires a schema-version bump.
*/
const ZSTD_DICTIONARY = readFileSync(new URL("../resources/zstd-dictionary.bin", import.meta.url));
/** Compress options shared by every data-column frame. */
const DATA_ZSTD_OPTIONS = {
	dictionary: ZSTD_DICTIONARY,
	params: { [constants.ZSTD_c_compressionLevel]: ZSTD_COMPRESSION_LEVEL }
};
const CHUNK_TAGS = [
	"text-chunks",
	"reasoning-chunks",
	"tool-call-chunks"
];
function isChunkTag(value) {
	return CHUNK_TAGS.includes(value);
}
/**
* Decode one physical SQLite row into its complete logical event span.
* @param row - detached SQLite event row.
* @returns every logical event represented by the row.
*/
function decodeRow(row) {
	if (row.is_packed === 0) return [decodeScalarRow(row)];
	if (!isChunkTag(row.type)) throw new Error(`malformed ${row.type} storage row: packed discriminator requires a chunk tag`);
	if (row.source_event_seqs !== null || row.surface_op !== null) throw new Error(`malformed ${row.type} storage row: packed surface fields must be null`);
	return decodeSerializedChunkRow(row.type, row.seq, row.time, decodeData(row.data, MAX_PACKED_DATA_BYTES));
}
/**
* Convert a storage record to SQLite column values.
* @param record - scalar event or packed chunk record.
* @returns column values for one physical insert.
*/
function bindRecord(record) {
	if (isChunkRow(record)) return {
		seq: record.seq0,
		type: record.type,
		time: record.time0,
		data: encodeData(JSON.stringify(record.data)),
		sourceEventSeqs: null,
		surfaceOp: null,
		isPacked: 1
	};
	const event = record;
	const surface = event;
	return {
		seq: event.seq,
		type: event.type,
		time: event.time,
		data: encodeData(JSON.stringify(event.data)),
		sourceEventSeqs: surface.sourceEventSeqs === void 0 ? null : encodeSourceEventSeqs(surface.sourceEventSeqs),
		surfaceOp: surface.surfaceOp === void 0 ? null : JSON.stringify(surface.surfaceOp),
		isPacked: 0
	};
}
function encodeData(serialized) {
	const bytes = Buffer.from(serialized);
	const compressed = zstdCompressSync(bytes, DATA_ZSTD_OPTIONS);
	return compressed.length < bytes.length ? compressed : serialized;
}
function decodeData(value, maxOutputLength) {
	if (typeof value === "string") return value;
	const decoded = maxOutputLength === void 0 ? zstdDecompressSync(value, { dictionary: ZSTD_DICTIONARY }) : zstdDecompressSync(value, {
		dictionary: ZSTD_DICTIONARY,
		maxOutputLength
	});
	return UTF8_DECODER.decode(decoded);
}
function encodeSourceEventSeqs(values) {
	if (values.length === 0) return new Uint8Array();
	const deltas = [DELTA_TAG];
	let previous = 0n;
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index];
		if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("sourceEventSeqs must contain non-negative safe integers");
		const current = BigInt(value);
		appendVarint(deltas, index === 0 ? current : current >= previous ? (current - previous) * 2n : (previous - current) * 2n - 1n);
		previous = current;
	}
	if (!isStrictlyIncreasing(values)) return Uint8Array.from(deltas);
	const runs = [RUN_TAG];
	let start = values[0];
	let end = start;
	for (let index = 1; index < values.length; index += 1) {
		const value = values[index];
		if (value === end + 1) {
			end = value;
			continue;
		}
		appendVarint(runs, BigInt(start));
		appendVarint(runs, BigInt(end - start + 1));
		start = value;
		end = start;
	}
	appendVarint(runs, BigInt(start));
	appendVarint(runs, BigInt(end - start + 1));
	return Uint8Array.from(runs.length < deltas.length ? runs : deltas);
}
function isStrictlyIncreasing(values) {
	return values.every((value, index) => index === 0 || value > values[index - 1]);
}
function appendVarint(bytes, value) {
	let remaining = value;
	while (remaining >= 128n) {
		bytes.push(Number(remaining & 127n) | 128);
		remaining >>= 7n;
	}
	bytes.push(Number(remaining));
}
function decodeSourceEventSeqs(bytes, maxEntries) {
	if (bytes.length === 0) return [];
	if (bytes.length === 1) throw new Error("malformed source_event_seqs storage value: truncated tagged payload");
	switch (bytes[0]) {
		case DELTA_TAG: return decodeDeltaVarints(bytes, 1);
		case RUN_TAG: return decodeRunVarints(bytes, 1, maxEntries);
		default: throw new Error("malformed source_event_seqs storage value: unknown encoding tag");
	}
}
function decodeDeltaVarints(bytes, offset) {
	const values = [];
	let previous = 0n;
	while (offset < bytes.length) {
		const first = values.length === 0;
		const decoded = readVarint(bytes, offset, first ? MAX_SAFE_INTEGER : MAX_ZIGZAG_INTEGER);
		offset = decoded.offset;
		const delta = first ? decoded.value : (decoded.value & 1n) === 0n ? decoded.value / 2n : -((decoded.value + 1n) / 2n);
		const value = first ? delta : previous + delta;
		if (value < 0n || value > MAX_SAFE_INTEGER) throw new Error("malformed source_event_seqs storage value: decoded seq is out of range");
		values.push(Number(value));
		previous = value;
	}
	return values;
}
function decodeRunVarints(bytes, offset, maxEntries) {
	const values = [];
	let previousEnd = -1;
	while (offset < bytes.length) {
		const start = readVarint(bytes, offset, MAX_SAFE_INTEGER);
		const count = readVarint(bytes, start.offset, MAX_SAFE_INTEGER);
		offset = count.offset;
		const first = Number(start.value);
		const length = Number(count.value);
		if (length < 1) throw new Error("malformed source_event_seqs storage value: run count must be positive");
		if (first <= previousEnd || !Number.isSafeInteger(first + length - 1)) throw new Error("malformed source_event_seqs storage value: runs must ascend within safe integers");
		if (length > maxEntries - values.length) throw new Error("malformed source_event_seqs storage value: run exceeds its event sequence");
		for (let index = 0; index < length; index += 1) values.push(first + index);
		previousEnd = first + length - 1;
	}
	return values;
}
function readVarint(bytes, offset, limit) {
	let value = 0n;
	let shift = 0n;
	while (offset < bytes.length) {
		const byte = bytes[offset];
		offset += 1;
		value |= BigInt(byte & 127) << shift;
		if ((byte & 128) === 0) {
			if (shift > 0n && (byte & 127) === 0) throw new Error("malformed source_event_seqs storage value: non-canonical varint");
			if (value > limit) throw new Error("malformed source_event_seqs storage value: varint is out of range");
			return {
				value,
				offset
			};
		}
		shift += 7n;
		if (shift > 56n) throw new Error("malformed source_event_seqs storage value: varint is out of range");
	}
	throw new Error("malformed source_event_seqs storage value: truncated varint");
}
function isChunkRow(record) {
	return isChunkTag(record.type) && "seq0" in record && !("seq" in record);
}
function decodeScalarRow(row) {
	const surfaceFields = {
		...row.source_event_seqs === null ? {} : { sourceEventSeqs: decodeSourceEventSeqs(row.source_event_seqs, row.seq) },
		...row.surface_op === null ? {} : { surfaceOp: JSON.parse(row.surface_op) }
	};
	return {
		type: row.type,
		seq: row.seq,
		time: row.time,
		data: JSON.parse(decodeData(row.data)),
		...surfaceFields
	};
}
/**
* Validate and flatten physical rows into their logical prefix. A malformed
* row or logical gap is committed corruption when a later valid turn end
* exists; otherwise it starts a removable physical tail.
* @param rows - physical rows ordered by their first logical sequence.
* @param base - logical sequence expected from the first selected row.
* @returns the contiguous logical prefix and optional physical deletion base.
*/
function scanRows(rows, base = 0) {
	let lastTurnEndRow = -1;
	for (let index = rows.length - 1; index >= 0; index -= 1) try {
		if (decodeRow(rows[index]).some((event) => event.type === "turn/end")) {
			lastTurnEndRow = index;
			break;
		}
	} catch {}
	const preserved = [];
	let expected = base;
	for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
		const physical = rows[rowIndex];
		let logicalEvents;
		try {
			logicalEvents = decodeRow(physical);
		} catch {}
		if (logicalEvents === void 0) {
			if (rowIndex <= lastTurnEndRow) throw new Error(`corrupt session log: invalid committed physical row at seq ${physical.seq}`);
			return {
				preserved,
				tornFrom: physical.seq
			};
		}
		let contiguous = true;
		for (const event of logicalEvents) {
			if (event.seq !== expected) {
				contiguous = false;
				break;
			}
			expected += 1;
		}
		if (!contiguous) {
			if (rowIndex <= lastTurnEndRow) throw new Error(`corrupt session log: invalid committed physical row at seq ${physical.seq}`);
			return {
				preserved,
				tornFrom: physical.seq
			};
		}
		preserved.push(...logicalEvents);
	}
	return { preserved };
}
//#endregion
//#region lib/types/sql.js
/**
* Closed, package-owned SQL resource loading for SQLite.
* @module @deepseek-ai/dsh-session-persistence-sqlite/sql
*/
const cache = /* @__PURE__ */ new Map();
/**
* Load an immutable SQL statement by closed resource name.
* @param name - package-owned resource basename.
* @returns the resource text.
*/
function sql(name) {
	const cached = cache.get(name);
	if (cached !== void 0) return cached;
	const statement = readFileSync(fileURLToPath(new URL(`../resources/sql/${name}.sql`, import.meta.url)), "utf8");
	cache.set(name, statement);
	return statement;
}
//#endregion
//#region lib/types/schema.js
/**
* SQLite schema ownership and durable-row validation.
* @module @deepseek-ai/dsh-session-persistence-sqlite/schema
*/
/** Current physical-record schema with packed and compressed event rows. */
const SCHEMA_VERSION = 19;
/** Application id reserved for DeepSeek Harness SQLite session databases. */
const SESSION_PERSISTENCE_SQLITE_APPLICATION_ID = 1146308688;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const JOURNAL_BUSY_RETRY_INTERVAL_MS = 10;
/**
* Open and validate a SQLite session database.
* @param Database - lazily imported Node SQLite constructor.
* @param path - SQLite path, including `:memory:`.
* @param journalMode - validated journal pragma.
* @param busyTimeoutMs - validated maximum wait for a competing SQLite lock.
* @returns the configured database handle.
* @throws when connection settings, schema ownership, or SQLite setup cannot be validated.
*/
async function openDatabase(Database, path, journalMode, busyTimeoutMs) {
	const deadline = performance.now() + busyTimeoutMs;
	const db = new Database(path, { timeout: busyTimeoutMs });
	try {
		configureConnectionSecurity(db, path);
		configureDatabase(Database, db, path);
		await selectJournalMode(db, path, journalMode, deadline);
		configureDurability(db, path);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}
function configureConnectionSecurity(db, path) {
	db.exec(sql("trusted-schema-off"));
	const trustedSchema = integerField(db.prepare(sql("select-trusted-schema")).get(), "trusted_schema");
	/* v8 ignore next 3 -- supported SQLite versions return the fixed setting. */
	if (trustedSchema !== 0) throw new Error(`session database at "${path}" retained trusted_schema=${trustedSchema}, expected 0`);
	db.exec(sql("mmap-off"));
	if (path === ":memory:") return;
	const mmapSize = integerField(db.prepare(sql("select-mmap-size")).get(), "mmap_size");
	/* v8 ignore next 3 -- supported file-backed SQLite connections return the fixed setting. */
	if (mmapSize !== 0) throw new Error(`session database at "${path}" retained mmap_size=${mmapSize}, expected 0`);
}
function configureDatabase(Database, db, path) {
	db.exec(sql("page-size"));
	db.exec(sql("foreign-keys-on"));
	let began = false;
	try {
		db.exec(sql("begin-immediate"));
		began = true;
		const onDisk = integerField(db.prepare(sql("select-user-version")).get(), "user_version");
		const applicationId = integerField(db.prepare(sql("select-application-id")).get(), "application_id");
		const userObjectCount = integerField(db.prepare(sql("select-user-object-count")).get(), "count");
		if (onDisk === 0 && (applicationId !== 0 || userObjectCount > 0)) throw new Error(`session database at "${path}" has an unversioned schema or application identity`);
		if (onDisk !== 0 && onDisk !== 19) throw new Error(`session database at "${path}" has schema version ${onDisk}, incompatible with this build (19)`);
		if (onDisk !== 0 && applicationId !== 1146308688) throw new Error(`session database at "${path}" has application id ${applicationId}, expected ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`);
		if (onDisk === 0) initializeDatabase(db);
		validateRequiredSchema(Database, db, path);
		db.exec(sql("commit"));
		began = false;
	} catch (error) {
		/* v8 ignore else -- a failed begin leaves no transaction to roll back. */
		if (began)
 /* v8 ignore next 5 -- retain the original ownership failure if rollback fails too. */
		try {
			db.exec(sql("rollback"));
		} catch {}
		throw error;
	}
}
async function selectJournalMode(db, path, journalMode, deadline) {
	let result;
	while (true) try {
		result = db.prepare(sql(journalResource(journalMode))).get();
		break;
	} catch (error) {
		const remainingMs = Math.max(0, Math.ceil(deadline - performance.now()));
		if (!isSqliteBusy(error) || remainingMs === 0) throw error;
		await setTimeout(Math.min(JOURNAL_BUSY_RETRY_INTERVAL_MS, remainingMs));
		if (performance.now() >= deadline) throw error;
	}
	const selected = stringField(result, "journal_mode").toLowerCase();
	const expected = path === ":memory:" ? "memory" : journalMode;
	/* v8 ignore next 3 -- SQLite returns the selected mode from these fixed, valid pragmas. */
	if (selected !== expected) throw new Error(`session database at "${path}" selected journal mode ${selected}, expected ${expected}`);
}
function configureDurability(db, path) {
	db.exec(sql("synchronous-full"));
	const synchronous = integerField(db.prepare(sql("select-synchronous")).get(), "synchronous");
	/* v8 ignore next 3 -- supported SQLite versions return the fixed setting. */
	if (synchronous !== 2) throw new Error(`session database at "${path}" retained synchronous=${synchronous}, expected FULL (2)`);
}
function isSqliteBusy(error) {
	return typeof error === "object" && error !== null && Reflect.get(error, "errcode") === 5;
}
function journalResource(mode) {
	switch (mode) {
		case "wal": return "journal-mode-wal";
		case "delete": return "journal-mode-delete";
		case "truncate": return "journal-mode-truncate";
		case "persist": return "journal-mode-persist";
	}
}
function initializeDatabase(db) {
	db.exec(sql("schema"));
	db.prepare(sql("insert-persistence-state")).run(randomUUID());
	db.exec(sql("set-application-id"));
	db.exec(sql("set-user-version-19"));
}
let canonicalSchema;
function expectedSchema(Database) {
	if (canonicalSchema !== void 0) return canonicalSchema;
	const reference = new Database(":memory:");
	try {
		reference.exec(sql("foreign-keys-on"));
		reference.exec(sql("schema"));
		canonicalSchema = schemaObjects(reference);
		return canonicalSchema;
	} finally {
		reference.close();
	}
}
function schemaObjects(db) {
	return db.prepare(sql("select-schema-objects")).all().map((value) => {
		const row = record(value, "schema object");
		return {
			type: stringField(row, "type"),
			name: stringField(row, "name"),
			tbl_name: stringField(row, "tbl_name"),
			sql: normalizeSql(stringField(row, "sql"))
		};
	});
}
function normalizeSql(value) {
	return value.replaceAll(/\s+/gu, " ").trim();
}
function validateRequiredSchema(Database, db, path) {
	if (JSON.stringify(schemaObjects(db)) !== JSON.stringify(expectedSchema(Database))) throw new Error(`session database at "${path}" does not contain the required schema objects`);
}
/**
* Recheck schema ownership inside the caller's mutation transaction.
* @param Database - constructor used to validate the canonical schema.
* @param db - open owned database with an active immediate transaction.
* @param path - database location used in ownership diagnostics.
* @throws when another writer changed the application identity, schema, or version.
*/
function validateSchemaForMutation(Database, db, path) {
	const version = integerField(db.prepare(sql("select-user-version")).get(), "user_version");
	const applicationId = integerField(db.prepare(sql("select-application-id")).get(), "application_id");
	if (applicationId !== 1146308688) throw new Error(`session database application id changed before mutation (expected ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}, got ${applicationId})`);
	validateRequiredSchema(Database, db, path);
	if (version !== 19) throw new Error(`session database schema changed before mutation (expected 19, got ${version})`);
}
/**
* Decode and validate one durable session row.
* @param value - value returned by SQLite.
* @returns a validated session row.
*/
function decodeSessionRow(value) {
	const row = record(value, "stored session metadata");
	const id = nonemptyStringField(row, "id");
	const version = safeIntegerField(row, "version");
	const cwd = nullableStringField(row, "cwd");
	if (cwd !== null && !isAbsolute(cwd)) throw new Error("stored session cwd must be absolute");
	const parent = nullableStringField(row, "parent_session");
	const origin = nullableStringField(row, "origin");
	if (origin !== null && origin !== "subagent") throw new Error("stored session origin must be subagent or null");
	const incarnation = nonemptyStringField(row, "incarnation");
	if (!UUID.test(incarnation)) throw new Error("stored session incarnation must be a UUID");
	return {
		id,
		version,
		created_at: nonnegativeSafeIntegerField(row, "created_at"),
		cwd,
		parent_session: parent,
		seed_length: nullableNonnegativeSafeIntegerField(row, "seed_length"),
		origin,
		delegation_depth: nullableNonnegativeSafeIntegerField(row, "delegation_depth"),
		agent_preset: nullableStringField(row, "agent_preset"),
		incarnation,
		revision: nonnegativeSafeIntegerField(row, "revision")
	};
}
/**
* Decode and validate one durable event row before JSON interpretation.
* @param value - value returned by SQLite.
* @returns a validated physical event row.
*/
function decodeEventRow(value) {
	const row = record(value, "stored event");
	const isPacked = safeIntegerField(row, "is_packed");
	if (isPacked !== 0 && isPacked !== 1) throw new Error("stored event is_packed must be 0 or 1");
	return {
		seq: nonnegativeSafeIntegerField(row, "seq"),
		type: nonemptyStringField(row, "type"),
		time: safeIntegerField(row, "time"),
		data: stringOrBlobField(row, "data"),
		source_event_seqs: nullableBlobField(row, "source_event_seqs"),
		surface_op: nullableStringField(row, "surface_op"),
		is_packed: isPacked
	};
}
/**
* Validate the singleton identity read from durable storage.
* @param value - value returned by SQLite.
* @returns the UUID store identity.
*/
function decodeStoreIdentity(value) {
	const identity = nonemptyStringField(value, "store_id");
	if (!UUID.test(identity)) throw new Error("stored store_id must be a UUID");
	return identity;
}
/**
* Reconstruct an immutable session header from a validated metadata row.
* @param row - validated stored metadata row.
* @returns the session header.
*/
function rowToMeta(row) {
	return {
		version: row.version,
		id: SessionId(row.id),
		createdAt: row.created_at,
		...row.cwd === null ? {} : { cwd: row.cwd },
		...row.parent_session === null ? {} : { parentSession: SessionId(row.parent_session) },
		...row.seed_length === null ? {} : { seedLength: row.seed_length },
		...row.origin === null ? {} : { origin: row.origin },
		...row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth },
		...row.agent_preset === null ? {} : { agentPreset: row.agent_preset }
	};
}
function record(value, label) {
	if (typeof value !== "object" || value === null) throw new Error(`${label} must be an object`);
	return value;
}
function stringField(value, key) {
	const field = record(value, "SQLite row")[key];
	if (typeof field !== "string") throw new Error(`stored ${key} must be a string`);
	return field;
}
function nonemptyStringField(value, key) {
	const field = stringField(value, key);
	if (field.length === 0) throw new Error(`stored ${key} must not be empty`);
	return field;
}
function nullableStringField(value, key) {
	const field = record(value, "SQLite row")[key];
	if (field === null) return null;
	if (typeof field !== "string") throw new Error(`stored ${key} must be a string or null`);
	return field;
}
function stringOrBlobField(value, key) {
	const field = record(value, "SQLite row")[key];
	if (typeof field === "string" || field instanceof Uint8Array) return field;
	throw new Error(`stored ${key} must be a string or blob`);
}
function nullableBlobField(value, key) {
	const field = record(value, "SQLite row")[key];
	if (field === null || field instanceof Uint8Array) return field;
	throw new Error(`stored ${key} must be a blob or null`);
}
function integerField(value, key) {
	const field = record(value, "SQLite row")[key];
	if (!Number.isSafeInteger(field)) throw new Error(`stored ${key} must be a safe integer`);
	return field;
}
function safeIntegerField(value, key) {
	return integerField(value, key);
}
function nonnegativeSafeIntegerField(value, key) {
	const field = integerField(value, key);
	if (field < 0) throw new Error(`stored ${key} must be non-negative`);
	return field;
}
function nullableSafeIntegerField(value, key) {
	const field = record(value, "SQLite row")[key];
	if (field === null) return null;
	if (!Number.isSafeInteger(field)) throw new Error(`stored ${key} must be a safe integer or null`);
	return field;
}
function nullableNonnegativeSafeIntegerField(value, key) {
	const field = nullableSafeIntegerField(value, key);
	if (field !== null && field < 0) throw new Error(`stored ${key} must be non-negative or null`);
	return field;
}
//#endregion
//#region lib/types/store.js
/**
* SQLite storage primitives: transactional append-batch packing, physical
* reads, schema validation, revisions, repair, and lifecycle closure.
* @module @deepseek-ai/dsh-session-persistence-sqlite/store
*/
/** SQLite implementation of the coordinator's physical backend hooks. */
var SqliteStore = class {
	options;
	name = "session-persistence-sqlite";
	db;
	databaseConstructor;
	storeIdentity;
	databasePath;
	opened = false;
	pathReady;
	ready;
	constructor(options) {
		this.options = options;
	}
	/**
	* Validate filesystem ownership without importing or opening Node SQLite.
	* @returns settlement of the store's one path-validation operation.
	*/
	validatePath() {
		this.pathReady ??= this.preparePath(this.options.path);
		return this.pathReady;
	}
	/**
	* Lazily open and validate the database on first persistence use.
	* @returns settlement of the store's one database-open operation.
	*/
	open() {
		this.ready ??= this.openDb();
		return this.ready;
	}
	async preparePath(path) {
		const actual = path === ":memory:" ? path : resolve(path);
		if (actual !== ":memory:") {
			await mkdir(dirname(actual), {
				recursive: true,
				mode: 448
			});
			await validateParentDirectory(dirname(actual));
			await validateDatabaseFileIfPresent(actual);
		}
		this.databasePath = actual;
	}
	async openDb() {
		await this.validatePath();
		if (this.databasePath !== ":memory:") {
			await createDatabaseFile(this.databasePath);
			await validateDatabaseFile(this.databasePath);
		}
		const { DatabaseSync } = await loadNodeSqlite();
		this.databaseConstructor = DatabaseSync;
		this.db = await openDatabase(DatabaseSync, this.databasePath, this.options.journalMode, this.options.busyTimeoutMs);
		try {
			const row = this.db.prepare(sql("select-store-id")).get();
			if (row === void 0) throw new Error(`session database at "${this.databasePath}" has no valid store identity`);
			let storeId;
			try {
				storeId = decodeStoreIdentity(row);
			} catch (error) {
				throw new Error(`session database at "${this.databasePath}" has no valid store identity`, { cause: error });
			}
			if (this.databasePath === ":memory:") this.storeIdentity = `memory:store:${storeId}`;
			else {
				const identity = statSync(this.databasePath, { bigint: true });
				this.storeIdentity = `file:${identity.dev}:${identity.ino}:${identity.birthtimeNs}:store:${storeId}`;
			}
			this.opened = true;
		} catch (error) {
			this.db.close();
			throw error;
		}
	}
	async loadStored(id, signal) {
		await this.observe(signal);
		const snapshot = this.readTransaction(() => {
			const row = this.rowFor(id);
			if (row === void 0) return void 0;
			return {
				row,
				eventRows: this.db.prepare(sql("select-events")).all(this.sessionKey(id)).map(decodeEventRow)
			};
		});
		signal?.throwIfAborted();
		if (snapshot === void 0) return void 0;
		const scanned = scanRows(snapshot.eventRows);
		return {
			meta: rowToMeta(snapshot.row),
			events: scanned.preserved,
			revision: sqliteRevision(this.storeIdentity, snapshot.row),
			...scanned.tornFrom === void 0 ? {} : { tornMarker: scanned.tornFrom }
		};
	}
	async readStoredRevision(id, signal) {
		await this.observe(signal);
		const row = this.rowFor(id);
		signal?.throwIfAborted();
		return row === void 0 ? void 0 : sqliteRevision(this.storeIdentity, row);
	}
	async loadStoredFrom(id, fromSeq, signal) {
		await this.observe(signal);
		const snapshot = this.readTransaction(() => {
			const row = this.rowFor(id);
			if (row === void 0) return void 0;
			return {
				row,
				...this.physicalSpanFrom(this.sessionKey(id), fromSeq)
			};
		});
		signal?.throwIfAborted();
		if (snapshot === void 0) return void 0;
		const { preserved } = scanRows(snapshot.eventRows, snapshot.base);
		return {
			meta: rowToMeta(snapshot.row),
			events: preserved.filter((event) => event.seq >= fromSeq)
		};
	}
	async appendBatch(meta, events, isMaterialized) {
		await this.open();
		if (events.length === 0) return;
		this.db.exec(sql("begin-immediate"));
		try {
			validateSchemaForMutation(this.databaseConstructor, this.db, this.databasePath);
			const sessionKey = isMaterialized ? this.sessionKey(meta.id) : this.writeRow(meta);
			const tailRows = this.tailRows(sessionKey);
			const currentLast = this.logicalLastEvent(meta.id, tailRows);
			const expected = currentLast === void 0 ? 0 : currentLast.seq + 1;
			const first = events[0];
			if (first.seq !== expected) throw new Error(`session ${meta.id} append starts at seq ${first.seq}, stored next seq is ${expected}`);
			const insert = this.insertStatement();
			for (const record of packChunkRuns(events)) this.insertRecord(insert, sessionKey, bindRecord(record));
			this.incrementRevision(meta.id);
			this.db.exec(sql("commit"));
		} catch (error) {
			this.rollback(error, "append");
		}
	}
	async materializeHeader(meta) {
		await this.open();
		this.db.exec(sql("begin-immediate"));
		try {
			validateSchemaForMutation(this.databaseConstructor, this.db, this.databasePath);
			this.writeRow(meta);
			this.db.exec(sql("commit"));
		} catch (error) {
			/* v8 ignore next -- validate/write failure uses the same transaction rollback path covered by append and repair. */
			this.rollback(error, "materialize empty session");
		}
	}
	async commitRepair(meta, tornMarker, closers) {
		await this.open();
		if (tornMarker === void 0 && closers.length === 0) return;
		this.db.exec(sql("begin-immediate"));
		try {
			validateSchemaForMutation(this.databaseConstructor, this.db, this.databasePath);
			if (this.rowFor(meta.id) === void 0) throw new Error(`session ${meta.id} metadata row is missing`);
			const sessionKey = this.sessionKey(meta.id);
			const current = scanRows(this.db.prepare(sql("select-events")).all(sessionKey).map(decodeEventRow));
			if (tornMarker !== void 0) {
				if (current.tornFrom !== tornMarker) throw new Error(`session ${meta.id} repair is stale: physical tail no longer starts at seq ${tornMarker}`);
				this.db.prepare(sql("delete-events-from")).run(sessionKey, tornMarker);
			} else if (current.tornFrom !== void 0) throw new Error(`session ${meta.id} repair omitted current torn tail at seq ${current.tornFrom}`);
			if (closers.length > 0) {
				const expected = current.preserved.at(-1)?.seq === void 0 ? 0 : current.preserved.at(-1).seq + 1;
				if (closers[0]?.seq !== expected) throw new Error(`session ${meta.id} repair is stale: closer starts at seq ${closers[0]?.seq}, stored next seq is ${expected}`);
				const insert = this.insertStatement();
				for (const closer of closers) this.insertRecord(insert, sessionKey, bindRecord(closer));
			}
			this.incrementRevision(meta.id);
			this.db.exec(sql("commit"));
		} catch (error) {
			this.rollback(error, "repair");
		}
	}
	async list(signal) {
		await this.observe(signal);
		const rows = this.sessionRows();
		signal?.throwIfAborted();
		return rows.map(rowToMeta);
	}
	/**
	* Return every materialized header with its source-qualified revision.
	* @param signal - optional cancellation before or after the metadata query.
	* @returns stored headers and revisions without loading event rows.
	*/
	async listSnapshots(signal) {
		await this.observe(signal);
		const rows = this.sessionRows();
		signal?.throwIfAborted();
		return rows.map((row) => ({
			header: rowToMeta(row),
			revision: sqliteRevision(this.storeIdentity, row)
		}));
	}
	async close() {
		if (this.ready === void 0) {
			if (this.pathReady !== void 0) await Promise.allSettled([this.pathReady]);
			return;
		}
		await Promise.allSettled([this.ready]);
		if (!this.opened) return;
		this.opened = false;
		this.db.close();
	}
	rowFor(id) {
		const value = this.db.prepare(sql("select-session")).get(id);
		return value === void 0 ? void 0 : decodeSessionRow(value);
	}
	sessionKey(id) {
		const row = this.db.prepare(sql("select-session-key")).get(id);
		if (row === void 0) throw new Error(`session ${id} metadata row is missing`);
		return row.id;
	}
	async observe(signal) {
		signal?.throwIfAborted();
		await this.open();
		signal?.throwIfAborted();
	}
	readTransaction(read) {
		this.db.exec(sql("begin"));
		try {
			const value = read();
			this.db.exec(sql("commit"));
			return value;
		} catch (error) {
			this.rollback(error, "read");
		}
	}
	sessionRows() {
		return this.db.prepare(sql("select-sessions")).all().map(decodeSessionRow);
	}
	rollback(error, operation) {
		try {
			this.db.exec(sql("rollback"));
		} catch (rollbackError) {
			/* v8 ignore next -- requires SQLite to fail both an operation and its immediate rollback. */
			throw new AggregateError([error, rollbackError], `${this.name} ${operation} failed and rollback also failed`);
		}
		throw error;
	}
	incrementRevision(id) {
		const updated = this.db.prepare(sql("update-session-revision")).run(id);
		/* v8 ignore next -- materialized writes follow coordinator create(); other writes upsert in this transaction. */
		if (Number(updated.changes) !== 1) throw new Error(`session ${id} metadata row is missing`);
	}
	tailRows(sessionKey) {
		const tail = this.db.prepare(sql("select-tail-events")).all(sessionKey, 2).map(decodeEventRow).reverse();
		if (tail.length === 0) return [];
		return this.physicalSpanFrom(sessionKey, tail[0].seq).eventRows;
	}
	/** Select the bounded physical span that may represent `fromSeq`. */
	physicalSpanFrom(sessionKey, fromSeq) {
		const packedFloor = Math.max(0, fromSeq - MAX_PACKED_ROW_MEMBERS + 1);
		const packedPredecessors = this.db.prepare(sql("select-packed-predecessors")).all(sessionKey, packedFloor, fromSeq).map(decodeEventRow);
		let base = fromSeq;
		for (const predecessor of packedPredecessors) try {
			const last = decodeRow(predecessor).at(-1);
			if (last !== void 0 && last.seq >= fromSeq) base = Math.min(base, predecessor.seq);
		} catch {
			base = Math.min(base, predecessor.seq);
		}
		const eventRows = this.db.prepare(sql("select-events-from")).all(sessionKey, base).map(decodeEventRow);
		return {
			base,
			eventRows
		};
	}
	logicalLastEvent(id, tailRows) {
		if (tailRows.length === 0) return void 0;
		const { preserved, tornFrom } = scanRows(tailRows, tailRows[0].seq);
		if (tornFrom !== void 0) throw new Error(`session ${id} has an invalid physical tail at seq ${tornFrom}`);
		return preserved.at(-1);
	}
	insertStatement() {
		return this.db.prepare(sql("insert-event"));
	}
	insertRecord(insert, sessionKey, record) {
		insert.run(sessionKey, record.seq, record.type, record.time, record.data, record.sourceEventSeqs, record.surfaceOp, record.isPacked);
	}
	writeRow(meta) {
		return this.db.prepare(sql("upsert-session")).get(meta.id, meta.version, meta.createdAt, meta.cwd ?? null, meta.parentSession ?? null, meta.seedLength ?? null, meta.origin ?? null, meta.delegationDepth ?? null, meta.agentPreset ?? null, randomUUID()).id;
	}
};
function sqliteRevision(storeIdentity, row) {
	return SessionPersistenceRevision(`${storeIdentity}:incarnation:${row.incarnation}:revision:${row.revision}`);
}
async function createDatabaseFile(path) {
	try {
		await (await open(path, "wx", 384)).close();
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
}
async function validateParentDirectory(path) {
	const parent = await lstat(path);
	if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error(`session database parent "${path}" must be a real directory`);
	const uid = process.getuid?.();
	/* v8 ignore start -- Windows exposes neither process.getuid nor meaningful
	* uid/mode bits; POSIX tests cover owner and mode rejection. */
	if (uid !== void 0 && (parent.uid !== uid || (parent.mode & 18) !== 0)) throw new Error(`session database parent "${path}" must be owned by the current user and not group/world-writable`);
	/* v8 ignore stop */
}
async function validateDatabaseFile(path) {
	const file = await lstat(path);
	if (file.isSymbolicLink() || !file.isFile()) throw new Error(`session database "${path}" must be a regular file, not a symbolic link`);
	const uid = process.getuid?.();
	/* v8 ignore start -- Windows exposes neither process.getuid nor meaningful
	* uid/mode bits; POSIX tests cover owner and mode rejection. */
	if (uid !== void 0 && (file.uid !== uid || (file.mode & 63) !== 0)) throw new Error(`session database "${path}" must be owned by the current user and accessible only by that user`);
	/* v8 ignore stop */
}
async function validateDatabaseFileIfPresent(path) {
	try {
		await validateDatabaseFile(path);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}
let nodeSqlite;
/** Load Node SQLite once so concurrent stores share one warning-filter lifetime. */
function loadNodeSqlite() {
	nodeSqlite ??= importNodeSqlite();
	return nodeSqlite;
}
/** Import Node 22's SQLite dependency without its process-wide experimental warning. */
async function importNodeSqlite() {
	const emitWarning = Reflect.get(process, "emitWarning");
	/* v8 ignore start -- Node 22 alone emits this warning; primary coverage runs on Node 24. */
	const filteredEmitWarning = (warning, ...args) => {
		const message = warning instanceof Error ? warning.message : warning;
		const first = args[0];
		const type = warning instanceof Error ? warning.name : typeof first === "string" ? first : typeof first === "object" && first !== null && "type" in first ? first.type : void 0;
		if (message === "SQLite is an experimental feature and might change at any time" && type === "ExperimentalWarning") return;
		Reflect.apply(emitWarning, process, [warning, ...args]);
	};
	Reflect.set(process, "emitWarning", filteredEmitWarning);
	try {
		return await import("node:sqlite");
	} finally {
		Reflect.set(process, "emitWarning", emitWarning);
	}
	/* v8 ignore stop */
}
//#endregion
//#region lib/types/index.js
/**
* Opt-in SQLite persistence provider. Logical sessions remain unchanged;
* the physical backend packs eligible chunk runs into schema-19 rows.
* @module @deepseek-ai/dsh-session-persistence-sqlite
*/
/** Default wait for another SQLite connection's write reservation. */
const DEFAULT_BUSY_TIMEOUT_MS = 5e3;
/** Largest busy timeout accepted by SQLite's signed millisecond interface. */
const MAX_BUSY_TIMEOUT_MS = 2147483647;
/**
* SQLite `SessionPersistence` provider with a schema-owned physical codec.
*/
var SqliteSessionPersistence = class extends SessionPersistence {
	config;
	supportsRawArtifacts = false;
	name = "session-persistence-sqlite";
	static inject = ["sessions"];
	static Config = z.object({
		path: z.string().required(),
		journalMode: z.union([
			"wal",
			"delete",
			"truncate",
			"persist"
		]).default("wal"),
		busyTimeoutMs: z.number().step(1).min(0).max(MAX_BUSY_TIMEOUT_MS).default(DEFAULT_BUSY_TIMEOUT_MS),
		preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
		writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS).default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS)
	});
	store;
	coordinator;
	constructor(ctx, config) {
		super(ctx);
		this.config = config;
		const preparedSessionCacheSize = config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE;
		const writeBatchMaxDelayMs = config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS;
		this.store = new SqliteStore({
			path: config.path,
			journalMode: config.journalMode ?? "wal",
			busyTimeoutMs: config.busyTimeoutMs ?? 5e3
		});
		this.coordinator = new PersistenceCoordinator(this.ctx, this.store, {
			preparedSessionCacheSize,
			writeBatchMaxDelayMs
		});
	}
	/** Reject self-contained path and ownership failures without loading Node SQLite. */
	async [Service.init]() {
		await this.store.validatePath();
	}
	/** SQLite has one database, not an independent per-session artifact. */
	locate(_meta) {}
	create(meta) {
		return this.coordinator.create(meta);
	}
	ensureMaterialized(session) {
		return this.coordinator.ensureMaterialized(session);
	}
	append(id, events) {
		return this.coordinator.append(id, events);
	}
	prepare(id, signal) {
		return this.coordinator.prepare(id, signal);
	}
	load(id) {
		return this.coordinator.load(id);
	}
	inspect(id, signal) {
		return this.coordinator.inspect(id, signal);
	}
	borrowSession(id, signal) {
		return this.coordinator.borrowSession(id, signal);
	}
	readFrom(id, fromSeq, signal) {
		return this.coordinator.readFrom(id, fromSeq, signal);
	}
	list(signal) {
		return this.store.list(signal);
	}
	listSnapshots(signal) {
		return this.store.listSnapshots(signal);
	}
};
//#endregion
export { DEFAULT_BUSY_TIMEOUT_MS, MAX_BUSY_TIMEOUT_MS, SCHEMA_VERSION, SqliteSessionPersistence, SqliteSessionPersistence as default };
