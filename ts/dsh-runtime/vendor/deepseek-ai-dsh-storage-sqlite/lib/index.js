import z from "@deepseek-ai/schemastery";
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from "@deepseek-ai/dsh-storage";
import { DatabaseSync } from "node:sqlite";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
//#region lib/types/schema.js
/**
* Schema + open-time helpers for the SQLite storage backend: the physical
* layout version, the database open/configure sequence (permissions, pragmas,
* version stamp/reject), and the unit metadata tables. Unit record tables are
* created per descriptor in `unit.ts`.
* @module @deepseek-ai/dsh-storage-sqlite/schema
*/
/**
* The on-disk physical layout version, stored in `PRAGMA user_version`.
* Orthogonal to each unit's own `version` (stamped per unit in the `units`
* row). Bumped only on a breaking change to the table layout; any other
* stamped version rejects — this unreleased format has no migrations.
*/
const STORAGE_SQLITE_SCHEMA_VERSION = 1;
/**
* Exclusively create a missing database file with owner-only permissions.
* Existing files retain their modes, and errors other than `EEXIST` propagate.
* `DatabaseSync` reopens by path, so this does not protect confidentiality or
* integrity when another principal can replace the database entry in its
* parent directory.
*/
async function createDatabaseFile(path) {
	try {
		await (await open(path, "wx", 384)).close();
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
}
/**
* Open the database and apply its schema and pragmas. Missing directories and
* database files are created owner-only (`:memory:` skips filesystem setup).
* A zero `user_version` is stamped with {@link STORAGE_SQLITE_SCHEMA_VERSION};
* every other non-current version rejects rather than being migrated in place.
* @param path - the SQLite database file to open, or `:memory:`.
* @param journalMode - validated journal pragma.
* @returns the open handle with pragmas applied and the unit metadata tables ensured.
*/
async function openDatabase(path, journalMode) {
	const actual = path === ":memory:" ? path : resolve(path);
	if (actual !== ":memory:") {
		await mkdir(dirname(actual), {
			recursive: true,
			mode: 448
		});
		await createDatabaseFile(actual);
	}
	const db = new DatabaseSync(actual);
	try {
		configureDatabase(db, actual, journalMode);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}
function configureDatabase(db, path, journalMode) {
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`);
	const { user_version: onDisk } = db.prepare("PRAGMA user_version").get();
	if (onDisk !== 0 && onDisk !== 1) throw new StorageError("version-mismatch", `storage database at "${path}" has schema version ${onDisk}, incompatible with this build (1)`);
	db.exec(`
    CREATE TABLE IF NOT EXISTS units (
      name    TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    ) STRICT
  `);
	db.exec(`
    CREATE TABLE IF NOT EXISTS unit_globals (
      unit  TEXT PRIMARY KEY REFERENCES units(name),
      value TEXT NOT NULL
    ) STRICT
  `);
	if (onDisk === 0) db.exec(`PRAGMA user_version = 1`);
}
/**
* Physical table name for one unit table. Both segments are validated against
* `UNIT_NAME_RE` before reaching this, so the result is safe to interpolate
* into DDL and prepared-statement text.
* @param unit - Validated unit name.
* @param table - Validated table name.
* @returns the `u_<unit>_<table>` identifier.
*/
function recordTableName(unit, table) {
	return `u_${unit}_${table}`;
}
//#endregion
//#region lib/types/unit.js
/**
* One opened SQLite KV unit: prepared per-table statements over the
* `u_<unit>_<table>` record tables plus this unit's row in the shared
* `unit_globals` table. Each primitive is a single statement, so atomicity
* comes from SQLite itself — no explicit transactions, and no write queue
* (write ordering is the caller's responsibility per the KV contract).
* @module @deepseek-ai/dsh-storage-sqlite/unit
*/
/**
* The SQLite {@link KvUnit}. Constructed by the backend AFTER the unit's
* record tables exist; statements are prepared once here and reused for every
* primitive. Values are stored as JSON text in the `value` column.
*/
var SqliteKvUnit = class {
	descriptor;
	onClose;
	tables = /* @__PURE__ */ new Map();
	globalUpsert;
	globalSelect;
	closed = false;
	/**
	* @param db - Open database handle owned by the backend (never closed here).
	* @param descriptor - Validated descriptor whose record tables already exist.
	* @param onClose - Backend callback releasing this unit's open-name slot.
	*/
	constructor(db, descriptor, onClose) {
		this.descriptor = descriptor;
		this.onClose = onClose;
		for (const table of descriptor.tables) {
			const physical = recordTableName(descriptor.name, table);
			this.tables.set(table, {
				upsert: db.prepare(`INSERT INTO "${physical}" (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
				remove: db.prepare(`DELETE FROM "${physical}" WHERE key = ?`),
				selectAll: db.prepare(`SELECT key, value FROM "${physical}"`)
			});
		}
		this.globalUpsert = descriptor.hasGlobal ? db.prepare("INSERT INTO unit_globals (unit, value) VALUES (?, ?) ON CONFLICT(unit) DO UPDATE SET value = excluded.value") : void 0;
		this.globalSelect = descriptor.hasGlobal ? db.prepare("SELECT value FROM unit_globals WHERE unit = ?") : void 0;
	}
	loadAll() {
		return this.settle(() => {
			const tables = {};
			for (const [name, statements] of this.tables) {
				const records = Object.create(null);
				for (const row of statements.selectAll.all()) records[row.key] = this.parseValue(row.value, `table '${name}' key '${row.key}'`);
				tables[name] = records;
			}
			let global = null;
			if (this.globalSelect !== void 0) {
				const row = this.globalSelect.get(this.descriptor.name);
				if (row !== void 0) global = this.parseValue(row.value, "global slot");
			}
			return {
				tables,
				global
			};
		});
	}
	/** Parse one stored value column, mapping bad JSON to `malformed-medium`. */
	parseValue(text, slot) {
		try {
			return JSON.parse(text);
		} catch (error) {
			throw new StorageError("malformed-medium", `kv unit '${this.descriptor.name}' holds unparsable JSON at ${slot}`, { cause: error });
		}
	}
	putRecord(table, key, value) {
		return this.settle(() => {
			this.statementsFor(table).upsert.run(key, JSON.stringify(value));
		});
	}
	deleteRecord(table, key) {
		return this.settle(() => {
			this.statementsFor(table).remove.run(key);
		});
	}
	setGlobal(value) {
		return this.settle(() => {
			if (this.globalUpsert === void 0) throw new Error(`kv unit '${this.descriptor.name}' declared no global slot`);
			this.globalUpsert.run(this.descriptor.name, JSON.stringify(value));
		});
	}
	close() {
		if (!this.closed) {
			this.closed = true;
			this.onClose();
		}
		return Promise.resolve();
	}
	/**
	* Run one synchronous primitive behind the closed guard, mapping a throw to
	* a rejection so the Promise-returning contract never throws synchronously.
	*/
	settle(operation) {
		try {
			this.ensureOpen();
			return Promise.resolve(operation());
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}
	ensureOpen() {
		if (this.closed) throw new StorageError("closed", `kv unit '${this.descriptor.name}' is closed`);
	}
	statementsFor(table) {
		const statements = this.tables.get(table);
		if (statements === void 0) throw new Error(`kv unit '${this.descriptor.name}' declared no table '${table}'`);
		return statements;
	}
};
//#endregion
//#region lib/types/index.js
/**
* SQLite storage backend for the storage hub: one database file hosts every
* routed unit, document-per-row (`key TEXT` / `value TEXT` JSON). Registers
* as backend `sqlite`; the disposer unregisters first, then closes the medium.
* @module @deepseek-ai/dsh-storage-sqlite
*/
/** Cordis plugin name. */
const name = "storage-sqlite";
/** The backend registers on the storage hub. */
const inject = ["storage"];
/** Schemastery validator for {@link Config}. */
const Config = z.object({
	path: z.string().required(),
	journalMode: z.union([
		"wal",
		"delete",
		"truncate",
		"persist"
	]).default("wal")
});
/**
* The SQLite {@link StorageBackend}. Owns one `DatabaseSync` connection and
* the open-unit table; `kv.open` validates names, enforces the per-unit
* version stamp in `units`, and ensures the unit's record tables.
*/
var SqliteStorageBackend = class {
	/** The key-value facet; the only shape this backend serves. */
	kv = { open: (descriptor) => this.openUnit(descriptor) };
	ready;
	/** Open (or still-opening) units by name; presence is the double-open guard. */
	units = /* @__PURE__ */ new Map();
	closing;
	/**
	* @param config - Validated plugin configuration.
	*/
	constructor(config) {
		this.ready = openDatabase(config.path, config.journalMode);
		this.ready.catch(() => {});
	}
	openUnit(descriptor) {
		if (this.closing !== void 0) return Promise.reject(new StorageError("closed", "sqlite storage backend is closed"));
		if (!UNIT_NAME_RE.test(descriptor.name)) return Promise.reject(/* @__PURE__ */ new Error(`kv unit name '${descriptor.name}' violates ${UNIT_NAME_RE}`));
		for (const table of descriptor.tables) if (!UNIT_NAME_RE.test(table)) return Promise.reject(/* @__PURE__ */ new Error(`kv table name '${table}' in unit '${descriptor.name}' violates ${UNIT_NAME_RE}`));
		if (this.units.has(descriptor.name)) return Promise.reject(/* @__PURE__ */ new Error(`kv unit '${descriptor.name}' is already open (double-open is a caller bug)`));
		const pending = this.materializeUnit(descriptor);
		this.units.set(descriptor.name, pending);
		pending.catch(() => this.units.delete(descriptor.name));
		return pending;
	}
	async materializeUnit(descriptor) {
		const db = await this.ready;
		const row = db.prepare("SELECT version FROM units WHERE name = ?").get(descriptor.name);
		if (row === void 0) db.prepare("INSERT INTO units (name, version) VALUES (?, ?)").run(descriptor.name, descriptor.version);
		else if (row.version !== descriptor.version) throw new StorageError("version-mismatch", `kv unit '${descriptor.name}' is stamped version ${row.version} on the medium, incompatible with descriptor version ${descriptor.version}`);
		for (const table of descriptor.tables) db.exec(`
        CREATE TABLE IF NOT EXISTS "${recordTableName(descriptor.name, table)}" (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT
      `);
		return new SqliteKvUnit(db, descriptor, () => {
			this.units.delete(descriptor.name);
		});
	}
	/**
	* Close every open unit and release the database. Idempotent; concurrent
	* and repeated calls resolve once teardown finishes.
	* @returns resolution after the medium is released.
	*/
	close() {
		this.closing ??= this.doClose();
		return this.closing;
	}
	async doClose() {
		let db;
		try {
			db = await this.ready;
		} catch {
			return;
		}
		for (const pending of [...this.units.values()]) await (await pending.catch(() => void 0))?.close();
		db.close();
	}
};
/**
* Register the SQLite backend as `sqlite` on the storage hub. The disposer
* unregisters the name first, then closes the backend.
* @param ctx - Plugin context (must inject `storage`).
* @param config - Validated plugin configuration.
*/
function apply(ctx, config) {
	const backend = new SqliteStorageBackend(config);
	ctx.effect(() => {
		const dispose = ctx.storage.backend.register("sqlite", backend);
		return async () => {
			dispose();
			await backend.close();
		};
	}, "storage-sqlite.registerBackend");
	ctx.provide(storageBackendServiceKey("sqlite"), backend);
}
//#endregion
export { Config, STORAGE_SQLITE_SCHEMA_VERSION, SqliteStorageBackend, apply, inject, name };
