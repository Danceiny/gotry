import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { Buffer } from "node:buffer";
import { GenMapping, addMapping, toEncodedMap } from "@jridgewell/gen-mapping";
//#region lib/types/analyzer.js
/**
* TypeScript project analyzer for the compiler-independent Typert model.
* Programs, symbols, and syntax nodes remain extraction-only implementation
* details; callers receive only the model declared in {@link ./model.ts}.
* @module @deepseek-ai/dsh-typert-generator/analyzer
*/
/** Analysis failure with a source-oriented diagnostic. */
var TypertAnalysisError = class extends Error {
	name = "TypertAnalysisError";
};
var SourceEditQueued = class extends Error {};
const EMPTY_DOCUMENTATION = { tags: [] };
/**
* Process-wide parse cache for the bundled TypeScript default libraries.
* `typescript/lib/lib.*.d.ts` content is immutable for the process lifetime,
* so parses are shared across every {@link WorkspaceCaches} instance; the key
* carries the parse-affecting settings, keeping reuse exact.
*/
const defaultLibraryParses = /* @__PURE__ */ new Map();
function defaultLibraryKey(fileName, languageVersionOrOptions) {
	const options = typeof languageVersionOrOptions === "object" ? languageVersionOrOptions : { languageVersion: languageVersionOrOptions };
	return [
		fileName,
		String(options.languageVersion),
		String(options.impliedNodeFormat ?? ""),
		String(options.jsDocParsingMode ?? "")
	].join("\0");
}
/**
* Shared memo over one immutable workspace snapshot. Passing one instance to
* several analyzers (the batched and write-mode children reuse their parent's
* automatically) reuses parsed tsconfigs, the registration inventory, and
* per-face compiler hosts whose parsed and bound source files and module
* resolutions carry across programs. Callers that mutate workspace files
* between analyses must start from a fresh instance; write-mode source edits
* invalidate themselves through {@link invalidate}.
*/
var WorkspaceCaches = class {
	/** Parsed tsconfig files by absolute config path. */
	configs = /* @__PURE__ */ new Map();
	/** Registration inventories keyed by root and aggregate config paths. */
	registrations = /* @__PURE__ */ new Map();
	hosts = /* @__PURE__ */ new Map();
	/**
	* Parse one tsconfig once per workspace snapshot.
	* @param path - absolute config path.
	* @returns the memoized parse result.
	*/
	config(path) {
		let parsed = this.configs.get(path);
		if (parsed === void 0) {
			parsed = parseConfig(path);
			this.configs.set(path, parsed);
		}
		return parsed;
	}
	/**
	* Return the shared compiler host for one face. Every program of one face
	* is built from the same aggregate compiler options (the first call wins),
	* so parsed source files, binder state, and module resolutions are safe to
	* reuse across the face's batched programs.
	* @param face - the face whose programs share this host.
	* @param options - the face's effective compiler options.
	* @returns a compiler host with source-file and module-resolution caches.
	*/
	programHost(face, options) {
		let entry = this.hosts.get(face);
		if (entry === void 0) {
			const host = ts.createCompilerHost(options);
			const files = /* @__PURE__ */ new Map();
			const resolutionCache = ts.createModuleResolutionCache(host.getCurrentDirectory(), (fileName) => host.getCanonicalFileName(fileName), options);
			const base = host.getSourceFile.bind(host);
			host.getSourceFile = (fileName, languageVersionOrOptions, onError) => {
				if (isStandardLibraryFile(fileName)) {
					const key = defaultLibraryKey(fileName, languageVersionOrOptions);
					if (!defaultLibraryParses.has(key)) defaultLibraryParses.set(key, base(fileName, languageVersionOrOptions, onError));
					return defaultLibraryParses.get(key);
				}
				if (!files.has(fileName)) files.set(fileName, base(fileName, languageVersionOrOptions, onError));
				return files.get(fileName);
			};
			host.getModuleResolutionCache = () => resolutionCache;
			entry = {
				host,
				files
			};
			this.hosts.set(face, entry);
		}
		return entry.host;
	}
	/**
	* Drop cached parses of one edited source file so the next analysis reads
	* the written content.
	* @param file - path of the edited file.
	*/
	invalidate(file) {
		const target = realPath(file);
		for (const { files } of this.hosts.values()) for (const key of [...files.keys()]) if (realPath(key) === target) files.delete(key);
	}
};
/** Analyze host and client as independent TypeScript programs. */
var WorkspaceAnalyzer = class WorkspaceAnalyzer {
	options;
	queuedEdit;
	crossFaceLinks = /* @__PURE__ */ new Map();
	checkedProjects = /* @__PURE__ */ new Set();
	registrations = [];
	caches;
	constructor(options) {
		this.options = {
			root: realPath(options.root),
			hostConfig: options.hostConfig ?? "tsconfig.host.json",
			clientConfig: options.clientConfig ?? "tsconfig.client.json",
			faces: options.faces ?? ["host", "client"],
			checkDiagnostics: options.checkDiagnostics ?? true,
			mode: options.mode ?? "check",
			...options.packages === void 0 ? {} : { packages: options.packages }
		};
		this.caches = options.caches ?? new WorkspaceCaches();
	}
	/**
	* Build the workspace model. Write mode applies inferred annotations and then
	* returns a fresh check-mode analysis of the edited projects.
	* @returns the independent face models and their explicit cross-face links.
	*/
	analyze() {
		this.registrations = this.loadRegistrations();
		const selected = this.options.packages === void 0 ? void 0 : new Set(this.options.packages);
		const faces = [];
		try {
			for (const face of this.options.faces) {
				const registrations = this.registrations.filter((registration) => registration.face === face && (selected === void 0 || selected.has(registration.name)));
				if (registrations.length === 0) continue;
				if (this.options.checkDiagnostics) for (const registration of registrations) this.checkProject(registration);
				const aggregatePath = resolve(this.options.root, face === "host" ? this.options.hostConfig : this.options.clientConfig);
				const aggregate = this.caches.config(aggregatePath);
				const rootNames = [...new Set(registrations.flatMap((registration) => registration.config.parsed.fileNames))];
				const options = {
					...aggregate.parsed.options,
					composite: false,
					incremental: false,
					noEmit: true
				};
				const program = ts.createProgram({
					rootNames,
					options,
					host: this.caches.programHost(face, options)
				});
				faces.push(new FaceAnalyzer({
					root: this.options.root,
					face,
					program,
					registrations,
					allRegistrations: this.registrations,
					mode: this.options.mode,
					queueEdit: (edit) => {
						this.queueEdit(edit);
					},
					crossFaceLinks: this.crossFaceLinks
				}).analyze());
			}
		} catch (error) {
			if (!(error instanceof SourceEditQueued) || this.options.mode !== "write" || this.queuedEdit === void 0) throw error;
		}
		if (this.queuedEdit !== void 0) {
			this.applyEdit(this.queuedEdit);
			return new WorkspaceAnalyzer({
				...this.options,
				caches: this.caches,
				mode: "write"
			}).analyze();
		}
		if (this.options.mode === "write") return new WorkspaceAnalyzer({
			...this.options,
			caches: this.caches,
			mode: "check"
		}).analyze();
		return {
			faces,
			crossFaceLinks: [...this.crossFaceLinks.values()].sort(compareCrossFaceLinks)
		};
	}
	/**
	* Analyze an explicit package selection through bounded compiler programs.
	* The resulting model is identical in shape to {@link analyze}; stable graph
	* ids let repeated dependency declarations merge without flattening types.
	* @param batchSize - maximum selected packages in one face program.
	* @returns one merged workspace model.
	*/
	analyzeInBatches(batchSize = 8) {
		if (this.options.packages === void 0) throw new TypertAnalysisError("typert: batched analysis requires an explicit package selection");
		if (!Number.isInteger(batchSize) || batchSize < 1) throw new TypertAnalysisError(`typert: batch size must be a positive integer, received ${String(batchSize)}`);
		const batches = [];
		for (let index = 0; index < this.options.packages.length; index += batchSize) batches.push(new WorkspaceAnalyzer({
			...this.options,
			caches: this.caches,
			packages: this.options.packages.slice(index, index + batchSize)
		}).analyze());
		return mergeWorkspaceModels(batches);
	}
	/**
	* Discover package faces from public-export-reachable Cordis augmentations
	* and explicit `@typert` roots without constructing a type-checker program.
	* @returns contributors grouped by package with deterministic face order.
	*/
	discoverPackages() {
		const registrations = this.loadRegistrations().filter((registration) => this.options.faces.includes(registration.face)).filter((registration) => this.registrationHasSurface(registration));
		const packages = /* @__PURE__ */ new Map();
		for (const registration of registrations) {
			const current = packages.get(registration.name) ?? {
				root: slash(relative(this.options.root, registration.root)),
				faces: /* @__PURE__ */ new Set()
			};
			current.faces.add(registration.face);
			packages.set(registration.name, current);
		}
		return [...packages].map(([packageName, value]) => ({
			package: packageName,
			root: value.root,
			faces: [...value.faces].sort()
		})).sort((left, right) => left.package.localeCompare(right.package));
	}
	/**
	* Index top-level exported type declarations without promoting them to graph
	* roots. Consumers use this lexical index for ambiguity checks while all
	* semantic traversal continues through {@link TypeGraph}.
	* @returns declarations from the selected faces and package projects.
	*/
	indexSourceDeclarations() {
		const selected = this.options.packages === void 0 ? void 0 : new Set(this.options.packages);
		const declarations = [];
		for (const registration of this.loadRegistrations()) {
			if (!this.options.faces.includes(registration.face) || selected !== void 0 && !selected.has(registration.name)) continue;
			for (const file of registration.config.parsed.fileNames) {
				const relativeFile = slash(relative(this.options.root, file));
				if (!existsSync(file) || !isWithin(realPath(file), join(registration.root, "src")) || !/\.(?:cts|mts|ts)$/.test(file)) continue;
				const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
				for (const statement of sourceFile.statements) {
					if (!isTypeDeclaration(statement) || statement.name === void 0 || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
					const position = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
					declarations.push({
						face: registration.face,
						package: registration.name,
						name: statement.name.text,
						kind: ts.isClassDeclaration(statement) ? "class" : ts.isInterfaceDeclaration(statement) ? "interface" : ts.isTypeAliasDeclaration(statement) ? "alias" : "enum",
						location: {
							file: relativeFile,
							line: position.line + 1,
							column: position.character + 1
						},
						text: declarationText(statement)
					});
				}
			}
		}
		return uniqueBy(declarations, (declaration) => `${declaration.face}\0${declaration.location.file}\0${String(declaration.location.line)}\0${declaration.name}`).sort((left, right) => left.face.localeCompare(right.face) || left.location.file.localeCompare(right.location.file) || left.location.line - right.location.line);
	}
	loadRegistrations() {
		const inventoryKey = `${this.options.root}\0${this.options.hostConfig}\0${this.options.clientConfig}`;
		const cached = this.caches.registrations.get(inventoryKey);
		if (cached !== void 0) return cached;
		const registrations = [];
		for (const face of ["host", "client"]) {
			const aggregatePath = resolve(this.options.root, face === "host" ? this.options.hostConfig : this.options.clientConfig);
			if (!existsSync(aggregatePath)) continue;
			const aggregate = this.caches.config(aggregatePath);
			for (const reference of aggregate.parsed.projectReferences ?? []) {
				const configPath = projectConfigPath(reference.path);
				const packageRoot = dirname(configPath);
				if (!isWithin(realPath(packageRoot), join(this.options.root, "packages"))) continue;
				const manifestPath = join(packageRoot, "package.json");
				if (!existsSync(manifestPath)) continue;
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
				if (typeof manifest.name !== "string") continue;
				const registration = {
					face,
					name: manifest.name,
					root: realPath(packageRoot),
					config: this.caches.config(configPath),
					manifest
				};
				if (!isDualFacePackage(manifest)) registrations.push(registration);
				else if (configPath === join(packageRoot, "tsconfig.json")) registrations.push({
					...registration,
					face: "host",
					exportSubpaths: hostExportSubpaths(manifest)
				}, {
					...registration,
					face: "client",
					exportSubpaths: clientExportSubpaths(manifest)
				});
				else registrations.push({
					...registration,
					exportSubpaths: face === "host" ? hostExportSubpaths(manifest) : clientExportSubpaths(manifest)
				});
			}
		}
		const inventory = uniqueBy(registrations, (registration) => `${registration.face}\0${registration.name}`).sort((left, right) => left.face.localeCompare(right.face) || left.name.localeCompare(right.name));
		this.caches.registrations.set(inventoryKey, inventory);
		return inventory;
	}
	entrySourcePaths(registration) {
		return packageExportTargets(registration.manifest).filter(([subpath, target]) => (registration.exportSubpaths === void 0 || registration.exportSubpaths.includes(subpath)) && !target.includes("*") && subpath !== "./package.json" && subpath !== "./typert" && subpath !== "./client/typert" && subpath !== "./remote" && !target.endsWith(".json")).map(([, target]) => sourcePathForExport(registration.root, target)).filter(existsSync);
	}
	registrationHasSurface(registration) {
		const seen = /* @__PURE__ */ new Set();
		const queue = this.entrySourcePaths(registration);
		while (queue.length > 0) {
			const file = realPath(queue.shift());
			if (seen.has(file) || !isWithin(file, registration.root)) continue;
			seen.add(file);
			const source = readFileSync(file, "utf8");
			if (sourceFileHasSurface(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true))) return true;
			for (const imported of ts.preProcessFile(source).importedFiles) {
				const resolved = ts.resolveModuleName(imported.fileName, file, registration.config.parsed.options, ts.sys).resolvedModule;
				if (resolved !== void 0 && isWithin(resolved.resolvedFileName, registration.root)) queue.push(resolved.resolvedFileName);
			}
		}
		return false;
	}
	checkProject(registration) {
		if (this.checkedProjects.has(registration.config.path)) return;
		this.checkedProjects.add(registration.config.path);
		const program = ts.createProgram({
			rootNames: registration.config.parsed.fileNames,
			options: {
				...registration.config.parsed.options,
				composite: false,
				incremental: false,
				noEmit: true,
				rootDir: this.options.root
			}
		});
		const diagnostics = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].filter((diagnostic) => diagnostic.file !== void 0 && diagnostic.start !== void 0 && isWithin(diagnostic.file.fileName, registration.root));
		if (diagnostics.length === 0) return;
		throw new TypertAnalysisError(diagnostics.map((diagnostic) => formatProgramDiagnostic(this.options.root, registration.face, diagnostic)).join("\n"));
	}
	queueEdit(edit) {
		this.queuedEdit = edit;
	}
	applyEdit(edit) {
		const source = readFileSync(edit.file, "utf8");
		writeFileSync(edit.file, source.slice(0, edit.position) + edit.text + source.slice(edit.position));
		this.caches.invalidate(edit.file);
	}
};
var FaceAnalyzer = class {
	root;
	face;
	program;
	checker;
	registrations;
	allRegistrations;
	mode;
	queueEdit;
	crossFaceLinks;
	sourceFiles = /* @__PURE__ */ new Map();
	declarations = /* @__PURE__ */ new Map();
	declarationStates = /* @__PURE__ */ new Set();
	nodes = /* @__PURE__ */ new Map();
	exportsByPackage = /* @__PURE__ */ new Map();
	nodeOrdinals = /* @__PURE__ */ new Map();
	staticLookups;
	staticContexts;
	constructor(options) {
		this.root = options.root;
		this.face = options.face;
		this.program = options.program;
		this.checker = options.program.getTypeChecker();
		this.registrations = options.registrations;
		this.allRegistrations = options.allRegistrations;
		this.mode = options.mode;
		this.queueEdit = options.queueEdit;
		this.crossFaceLinks = options.crossFaceLinks;
		for (const sourceFile of this.program.getSourceFiles()) this.sourceFiles.set(realPath(sourceFile.fileName), sourceFile);
	}
	analyze() {
		for (const registration of this.registrations) this.exportsByPackage.set(registration.name, this.collectExports(registration));
		const packages = this.registrations.map((registration) => this.analyzePackage(registration)).filter(hasPackageSurface);
		this.validateInvocationIdentity(packages);
		return {
			face: this.face,
			packages,
			graph: {
				declarations: [...this.declarations.values()].sort((left, right) => left.id.localeCompare(right.id)),
				nodes: [...this.nodes.values()].sort((left, right) => left.id.localeCompare(right.id))
			}
		};
	}
	analyzePackage(registration) {
		const records = this.exportsByPackage.get(registration.name);
		const reachable = this.reachableFiles(registration, records.map((record) => record.sourceFile));
		const services = [];
		const events = [];
		for (const sourceFile of reachable) for (const statement of sourceFile.statements) {
			if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name) || statement.name.text !== "@deepseek-ai/cordis" || statement.body === void 0 || !ts.isModuleBlock(statement.body)) continue;
			for (const member of statement.body.statements) {
				if (!ts.isInterfaceDeclaration(member)) continue;
				if (member.name.text === "Context") services.push(...this.collectServices(member, records));
				else if (member.name.text === "Events") events.push(...this.collectEvents(member));
			}
		}
		const explicitServices = this.collectExplicitServices(records);
		const objects = [];
		const schemas = [];
		const seenBusinessSymbols = /* @__PURE__ */ new Set();
		for (const record of records) {
			const declaration = record.declaration;
			if (!isTypeDeclaration(declaration)) continue;
			if (this.registrationForFile(declaration.getSourceFile().fileName) === void 0) continue;
			const symbol = this.resolveSymbol(record.symbol);
			const symbolId = this.symbolId(symbol);
			if (seenBusinessSymbols.has(symbolId)) continue;
			const mode = typertMode(declaration);
			if (mode !== "object" && mode !== "schema") continue;
			seenBusinessSymbols.add(symbolId);
			this.ensureDeclaration(symbol, declaration);
			const documentation = documentationOf(declaration);
			if (mode === "object") objects.push({
				...documentation,
				export: record.model,
				symbol: symbolId,
				passing: "reference"
			});
			else schemas.push({
				...documentation,
				export: record.model,
				symbol: symbolId,
				type: this.referenceNode(symbol, declaration)
			});
		}
		return {
			name: registration.name,
			root: slash(relative(this.root, registration.root)),
			exports: records.map((record) => record.model).sort((left, right) => left.subpath.localeCompare(right.subpath) || left.name.localeCompare(right.name)),
			services: uniqueBy([...explicitServices, ...services], (service) => service.key).sort((left, right) => left.key.localeCompare(right.key)),
			events: uniqueBy(events, (event) => event.name).sort((left, right) => left.name.localeCompare(right.name)),
			objects: objects.sort((left, right) => left.export.name.localeCompare(right.export.name)),
			schemas: schemas.sort((left, right) => left.export.name.localeCompare(right.export.name)),
			invocations: this.face === "host" ? this.collectInvocations(registration, reachable).sort((left, right) => left.id.localeCompare(right.id)) : []
		};
	}
	collectExports(registration) {
		const targets = packageExportTargets(registration.manifest).filter(([subpath]) => registration.exportSubpaths === void 0 || registration.exportSubpaths.includes(subpath));
		const records = [];
		for (const [subpath, target] of targets) {
			if (target.includes("*") || subpath === "./package.json" || subpath === "./typert" || subpath === "./client/typert" || subpath === "./remote" || target.endsWith(".json") || target.endsWith(".yml") || target.endsWith(".yaml")) continue;
			const sourcePath = sourcePathForExport(registration.root, target);
			const sourceFile = this.sourceFiles.get(realPath(sourcePath));
			if (sourceFile === void 0) throw new TypertAnalysisError(`typert(${this.face}): ${registration.name} export ${subpath} resolves to missing source ${sourcePath}`);
			const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile);
			if (moduleSymbol === void 0) continue;
			for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
				const symbol = this.resolveSymbol(exported);
				const declaration = preferredDeclaration(symbol);
				const aliases = exported === symbol || exported.name === symbol.name ? [exported.name] : [exported.name, symbol.name];
				records.push({
					model: {
						subpath,
						name: exported.name,
						symbol: this.symbolId(symbol),
						aliases
					},
					symbol,
					declaration,
					sourceFile
				});
			}
		}
		const unique = uniqueBy(records, (record) => `${record.model.subpath}\0${record.model.name}`);
		this.collectCrossFaceReExports(registration, unique);
		return unique;
	}
	collectCrossFaceReExports(registration, records) {
		const publicSymbols = new Set(records.map((record) => record.symbol));
		const entryFiles = uniqueBy(records, (record) => record.sourceFile.fileName).map((record) => record.sourceFile);
		for (const sourceFile of this.reachableFiles(registration, entryFiles)) for (const statement of sourceFile.statements) {
			if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === void 0 || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
			const module = moduleIdentity(statement.moduleSpecifier.text);
			if (module === void 0) continue;
			const toFace = this.allRegistrations.find((candidate) => candidate.name === module.package && candidate.face !== this.face)?.face;
			if (toFace === void 0) continue;
			if (statement.exportClause !== void 0 && ts.isNamespaceExport(statement.exportClause)) {
				const namespace = this.resolveSymbol(this.checker.getSymbolAtLocation(statement.exportClause.name));
				if (publicSymbols.has(namespace)) this.fail(statement.exportClause, "cross-face namespace re-exports are not supported");
				continue;
			}
			const exports = statement.exportClause === void 0 ? this.moduleExports(statement.moduleSpecifier).map((symbol) => ({
				symbol: this.resolveSymbol(symbol),
				requestedName: symbol.name,
				site: statement
			})) : statement.exportClause.elements.map((element) => ({
				symbol: this.resolveSymbol(this.checker.getSymbolAtLocation(element.name)),
				requestedName: element.propertyName?.text ?? element.name.text,
				site: element
			}));
			for (const exported of exports) {
				if (!publicSymbols.has(exported.symbol)) continue;
				const name = this.packageExportName(module, exported.symbol, toFace, exported.requestedName);
				if (name === void 0) this.fail(exported.site, `cross-face re-export ${exported.requestedName} is not exported by ${module.package} at ${module.subpath}`);
				this.recordCrossFaceLink(registration.name, toFace, module, name);
			}
		}
	}
	moduleExports(moduleSpecifier) {
		/* v8 ignore next -- a semantically valid export declaration from a resolved module always has a module symbol. */
		const moduleSymbol = this.checker.getSymbolAtLocation(moduleSpecifier);
		return this.checker.getExportsOfModule(moduleSymbol);
	}
	reachableFiles(registration, entryFiles) {
		const reachable = /* @__PURE__ */ new Map();
		const queue = [...entryFiles];
		while (queue.length > 0) {
			const sourceFile = queue.shift();
			const fileName = realPath(sourceFile.fileName);
			if (reachable.has(fileName) || !isWithin(fileName, registration.root)) continue;
			reachable.set(fileName, sourceFile);
			for (const statement of sourceFile.statements) {
				if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement) || statement.moduleSpecifier === void 0 || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
				const resolved = ts.resolveModuleName(statement.moduleSpecifier.text, sourceFile.fileName, this.program.getCompilerOptions(), ts.sys).resolvedModule;
				if (resolved === void 0) continue;
				const resolvedPath = realPath(resolved.resolvedFileName);
				if (!isWithin(resolvedPath, registration.root)) continue;
				queue.push(this.sourceFiles.get(resolvedPath));
			}
		}
		return [...reachable.values()].sort((left, right) => left.fileName.localeCompare(right.fileName));
	}
	collectServices(context, records) {
		const bySymbol = /* @__PURE__ */ new Map();
		for (const record of records) {
			const id = this.symbolId(record.symbol);
			const matches = bySymbol.get(id) ?? [];
			matches.push(record);
			bySymbol.set(id, matches);
		}
		const result = [];
		for (const member of context.members) {
			if (!ts.isPropertySignature(member) || member.type === void 0) continue;
			if (member.questionToken !== void 0 || ts.isUnionTypeNode(member.type) && member.type.types.some((node) => node.kind === ts.SyntaxKind.UndefinedKeyword)) continue;
			const authoredSymbol = this.symbolAtType(member.type);
			if (authoredSymbol === void 0) continue;
			const authoredSymbolId = this.symbolId(authoredSymbol);
			const exported = bySymbol.get(authoredSymbolId)?.find((record) => record.model.name === authoredSymbol.name) ?? bySymbol.get(authoredSymbolId)?.find((record) => record.model.name !== "default") ?? bySymbol.get(authoredSymbolId)?.[0];
			if (exported === void 0) continue;
			let symbol = authoredSymbol;
			let declaration = preferredDeclaration(symbol);
			const aliases = /* @__PURE__ */ new Set();
			while (declaration !== void 0 && ts.isTypeAliasDeclaration(declaration)) {
				if (aliases.has(symbol)) break;
				aliases.add(symbol);
				const target = this.symbolAtType(declaration.type);
				if (target === void 0) break;
				symbol = target;
				declaration = preferredDeclaration(symbol);
			}
			if (declaration === void 0 || !ts.isClassDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration)) this.fail(member, `service ${memberName(member.name)} does not resolve to an exported class or interface`);
			const memberOwner = this.registrationForFile(member.getSourceFile().fileName);
			const declarationOwner = this.registrationForFile(declaration.getSourceFile().fileName);
			if (memberOwner?.name !== declarationOwner?.name) continue;
			const symbolId = this.symbolId(symbol);
			const exposed = this.ensureDeclaration(symbol, declaration).members.filter(exposableMember).map((publicMember) => publicMember.id);
			result.push({
				...documentationOf(declaration),
				key: memberName(member.name),
				symbol: symbolId,
				export: exported.model,
				members: exposed,
				location: this.location(member)
			});
		}
		return result;
	}
	collectExplicitServices(records) {
		const result = [];
		const seen = /* @__PURE__ */ new Set();
		for (const record of records) {
			const tag = typertServiceTag(record.declaration);
			if (tag === void 0) continue;
			const words = (ts.getTextOfJSDocComment(tag.comment) ?? "").trim().split(/\s+/);
			if (words.length !== 2 || !isRemoteSegment(words[1] ?? "")) this.fail(tag, "@typert service requires exactly one nonempty Cordis service key without \"/\"");
			if (!ts.isClassDeclaration(record.declaration)) this.fail(record.declaration, "@typert service requires an exported class");
			const symbol = this.resolveSymbol(record.symbol);
			const symbolId = this.symbolId(symbol);
			if (seen.has(symbolId)) continue;
			seen.add(symbolId);
			const model = this.ensureDeclaration(symbol, record.declaration);
			result.push({
				...documentationOf(record.declaration),
				key: words[1],
				symbol: symbolId,
				export: record.model,
				members: model.members.filter(exposableMember).map((member) => member.id),
				location: this.location(record.declaration)
			});
		}
		return result;
	}
	collectInvocations(registration, reachable) {
		const result = [];
		for (const sourceFile of reachable) for (const statement of sourceFile.statements) {
			if (!ts.isClassDeclaration(statement)) continue;
			const marked = statement.members.flatMap((member) => {
				const invocation = this.remoteMarker(member);
				if (invocation === void 0) return [];
				if (!ts.isMethodDeclaration(member)) this.fail(member, "Remote decorators require a public instance method");
				return [{
					method: member,
					invocation
				}];
			});
			const first = marked[0];
			if (first === void 0) continue;
			const binding = this.gatewayBinding(statement);
			if (binding === void 0) this.fail(first.method, "Remote methods require TypertRemoteService or readonly typertGateway = bindTypertRemote(this, serviceKey)");
			for (const { method, invocation } of marked) result.push(this.invocationModel(registration, binding, method, invocation));
		}
		return result;
	}
	invocationModel(registration, binding, method, invocation) {
		if (visibilityOf(method) !== "public" || hasModifier(method, ts.SyntaxKind.StaticKeyword)) this.fail(method, "Remote decorators require a public instance method");
		if (hasModifier(method, ts.SyntaxKind.AbstractKeyword) || method.body === void 0) this.fail(method, "Remote methods must have a concrete implementation");
		if (!ts.isIdentifier(method.name)) this.fail(method, "Remote method names must be identifiers");
		if ((method.typeParameters?.length ?? 0) > 0) this.fail(method, "generic Remote methods are not supported");
		const methodName = method.name.text;
		const exportedMethod = invocation.exportName ?? methodName;
		const lookups = this.lookupDeclarations();
		const lookupByHost = new Map(lookups.map((lookup) => [lookup.hostSymbol, lookup]));
		const parameters = [];
		let cancellation;
		const wires = /* @__PURE__ */ new Set();
		for (const [parameterIndex, parameter] of method.parameters.entries()) {
			if (!ts.isIdentifier(parameter.name)) this.fail(parameter, "Remote parameters must use identifier bindings");
			if (parameter.dotDotDotToken !== void 0) this.fail(parameter, "Remote parameters cannot be rest parameters");
			if (parameter.initializer !== void 0) this.fail(parameter, "Remote parameters cannot have default values");
			if (parameter.name.text === "this") this.fail(parameter, "Remote methods cannot declare an explicit this parameter");
			const optional = parameter.questionToken !== void 0;
			const authoredType = this.requiredType(parameter, parameter.type, "parameter");
			const cancellationName = parameter.name.text === "signal";
			const cancellationType = this.isGlobalAbortSignal(authoredType);
			if (cancellationName || cancellationType) {
				if (!cancellationName || !cancellationType) this.fail(parameter, "Remote cancellation must use a parameter named signal with the global AbortSignal type");
				if (parameterIndex !== method.parameters.length - 1) this.fail(parameter, "Remote cancellation signal must be the final parameter");
				cancellation = { parameter: "signal" };
				continue;
			}
			const hostSymbol = this.symbolAtType(authoredType);
			const lookup = hostSymbol === void 0 ? void 0 : lookupByHost.get(this.symbolId(hostSymbol));
			let modeled;
			if (lookup !== void 0) {
				if (optional) this.fail(parameter, `lookup parameter for ${lookup.key} cannot be optional`);
				if (parameter.name.text !== lookup.key) this.fail(parameter, `lookup parameter for ${lookup.key} must also be named ${lookup.key}`);
				const boundary = this.remoteBoundary(lookup.wireType, `${registration.name}#${binding.namespace}/${exportedMethod}:${lookup.key}Id`, true);
				modeled = {
					name: parameter.name.text,
					wire: `${lookup.key}Id`,
					source: "lookup",
					lookup: lookup.key,
					boundary
				};
			} else {
				if (hostSymbol !== void 0 && this.isWorkspaceClass(hostSymbol)) this.fail(parameter, `non-JSON class parameter ${hostSymbol.name} requires a TypertLookupMap entry`);
				modeled = {
					name: parameter.name.text,
					wire: parameter.name.text,
					source: "json",
					...optional ? { optional: true } : {},
					boundary: this.remoteBoundary(authoredType, `${registration.name}#${binding.namespace}/${exportedMethod}:${parameter.name.text}`, false, "undefined", optional)
				};
			}
			if (wires.has(modeled.wire)) this.fail(parameter, `duplicate Remote wire field ${modeled.wire}`);
			wires.add(modeled.wire);
			parameters.push(modeled);
		}
		let receiver = { kind: "direct" };
		if (invocation.kind === "context") {
			const context = this.contextDeclarations().get(invocation.context);
			if (context === void 0) this.fail(method, `Remote Scope ${invocation.context} has no TypertContextMap entry`);
			const wire = `${invocation.context}Id`;
			if (wires.has(wire)) this.fail(method, `Remote Scope wire field ${wire} conflicts with a method parameter`);
			receiver = {
				kind: "context",
				context: invocation.context,
				wire,
				boundary: this.remoteBoundary(context.wireType, `${registration.name}#${binding.namespace}/${exportedMethod}:${wire}`, true)
			};
		}
		let scope;
		if (invocation.kind === "direct") {
			const lookupParameters = parameters.filter((parameter) => parameter.source === "lookup");
			const parameter = lookupParameters.length === 1 ? lookupParameters[0] : void 0;
			const context = parameter?.lookup === void 0 ? void 0 : this.contextDeclarations().get(parameter.lookup);
			if (parameter !== void 0 && context !== void 0) {
				const contextBoundary = this.remoteBoundary(context.wireType, `${registration.name}#${binding.namespace}/${exportedMethod}:scope:${context.key}`, true);
				if (contextBoundary.typeSymbol !== parameter.boundary.typeSymbol) this.fail(method, `Remote scope ${context.key} wire type ${contextBoundary.typeSymbol} does not match lookup wire type ${parameter.boundary.typeSymbol}`);
				scope = {
					context: context.key,
					wire: parameter.wire
				};
			}
		}
		const mode = invocation.kind === "direct" ? invocation.mode : void 0;
		const resultType = this.remoteResultType(method, mode);
		return {
			id: `${registration.name}#${binding.namespace}/${exportedMethod}`,
			service: binding.service,
			namespace: binding.namespace,
			method: exportedMethod,
			...exportedMethod === methodName ? {} : { implementation: methodName },
			...mode === void 0 ? {} : { mode },
			invocation: receiver,
			...scope === void 0 ? {} : { scope },
			parameters,
			...cancellation === void 0 ? {} : { cancellation },
			result: this.remoteBoundary(resultType, `${registration.name}#${binding.namespace}/${exportedMethod}:result`, false, "undefined-or-void"),
			location: this.location(method.name)
		};
	}
	gatewayBinding(declaration) {
		const field = this.gatewayFieldBinding(declaration);
		const base = this.gatewayServiceBinding(declaration);
		if (field !== void 0 && base !== void 0) this.fail(field.site, "TypertRemoteService subclasses must not declare a second typertRemote binding");
		return field ?? base;
	}
	gatewayFieldBinding(declaration) {
		const [property, duplicate] = declaration.members.filter((member) => ts.isPropertyDeclaration(member) && memberName(member.name) === "typertRemote");
		if (property === void 0) return void 0;
		if (duplicate !== void 0) this.fail(duplicate, "Service has more than one typertGateway field");
		if (visibilityOf(property) !== "public" || hasModifier(property, ts.SyntaxKind.StaticKeyword) || !hasModifier(property, ts.SyntaxKind.ReadonlyKeyword)) this.fail(property, "typertGateway must be a public readonly instance field");
		if (property.initializer === void 0 || !ts.isCallExpression(property.initializer) || !this.isTypeMetaSymbol(property.initializer.expression, "bindTypertRemote")) this.fail(property, "typertGateway must call bindTypertRemote()");
		const call = property.initializer;
		if (call.arguments.length < 2 || call.arguments.length > 3) this.fail(call, "bindTypertRemote() requires this, service key, and an optional options object");
		if (call.arguments[0]?.kind !== ts.SyntaxKind.ThisKeyword) this.fail(call.arguments[0] ?? call, "bindTypertRemote() first argument must be this");
		return this.gatewayBindingArguments(call, property);
	}
	gatewayServiceBinding(declaration) {
		const heritage = (declaration.heritageClauses ?? []).filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword).flatMap((clause) => [...clause.types]).find((type) => this.isTypeMetaSymbol(type.expression, "TypertRemoteService"));
		if (heritage === void 0) return void 0;
		const constructor = declaration.members.find(ts.isConstructorDeclaration);
		if (constructor?.body === void 0) this.fail(heritage, "TypertRemoteService subclasses must declare a constructor with super(ctx, serviceKey)");
		const call = constructor.body.statements.flatMap((statement) => {
			if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
			return statement.expression.expression.kind === ts.SyntaxKind.SuperKeyword ? [statement.expression] : [];
		})[0];
		if (call === void 0) this.fail(constructor, "TypertRemoteService constructor must call super(ctx, serviceKey) directly");
		if (call.arguments.length < 2 || call.arguments.length > 3) this.fail(call, "TypertRemoteService super() requires context, service key, and an optional options object");
		return this.gatewayBindingArguments(call, heritage);
	}
	gatewayBindingArguments(call, site) {
		const serviceArgument = call.arguments[1];
		if (serviceArgument === void 0) this.fail(call, "Gateway service key must be a string literal");
		const service = stringLiteralValue(serviceArgument);
		if (service === void 0) this.fail(serviceArgument, "Gateway service key must be a string literal");
		let namespace = service;
		const options = call.arguments[2];
		if (options !== void 0) {
			if (!ts.isObjectLiteralExpression(options)) this.fail(options, "bindTypertRemote() options must be an object literal");
			for (const propertyOption of options.properties) {
				if (!ts.isPropertyAssignment(propertyOption) || memberName(propertyOption.name) !== "namespace") this.fail(propertyOption, "bindTypertRemote() only supports a namespace option");
				const value = stringLiteralValue(propertyOption.initializer);
				if (value === void 0) this.fail(propertyOption.initializer, "Gateway namespace must be a string literal");
				namespace = value;
			}
		}
		if (!isRemoteSegment(service)) this.fail(serviceArgument, "Gateway service key must contain only RPC endpoint segment characters");
		if (!isRemoteSegment(namespace)) this.fail(options ?? call, "Gateway namespace must contain only RPC endpoint segment characters");
		return {
			service,
			namespace,
			site
		};
	}
	remoteMarker(member) {
		let found;
		for (const decorator of ts.canHaveDecorators(member) ? ts.getDecorators(member) ?? [] : []) {
			const expression = decorator.expression;
			let marker;
			if (this.isTypeMetaSymbol(expression, "Remote")) marker = { kind: "direct" };
			else if (ts.isCallExpression(expression) && this.isTypeMetaSymbol(expression.expression, "Remote")) {
				if (expression.arguments.length !== 1) this.fail(expression, "Remote() requires one name or options object");
				const argument = expression.arguments[0];
				if (argument === void 0) this.fail(expression, "Remote() requires one name or options object");
				const exportName = stringLiteralValue(argument);
				if (exportName !== void 0) {
					if (!isRemoteSegment(exportName)) this.fail(argument, "Remote() name must contain only RPC endpoint segment characters");
					marker = {
						kind: "direct",
						exportName
					};
				} else {
					if (!ts.isObjectLiteralExpression(argument) || argument.properties.length !== 1) this.fail(argument, "Remote() options must contain exactly mode: \"stream\"");
					const [property] = argument.properties;
					if (property === void 0) this.fail(argument, "Remote() options must contain exactly mode: \"stream\"");
					if (!ts.isPropertyAssignment(property) || memberName(property.name) !== "mode" || stringLiteralValue(property.initializer) !== "stream") this.fail(property, "Remote() options must contain exactly mode: \"stream\"");
					marker = {
						kind: "direct",
						mode: "stream"
					};
				}
			} else if (ts.isCallExpression(expression) && this.isTypeMetaSymbol(expression.expression, "RemoteScope")) {
				if (expression.arguments.length < 1 || expression.arguments.length > 2) this.fail(expression, "RemoteScope() requires a Context key and optional exported method name");
				const context = stringLiteralValue(expression.arguments[0]);
				if (context === void 0 || !isRemoteSegment(context)) this.fail(expression.arguments[0] ?? expression, "RemoteScope() key must be a string literal containing only RPC endpoint segment characters");
				const exportArgument = expression.arguments[1];
				const exportName = exportArgument === void 0 ? void 0 : stringLiteralValue(exportArgument);
				if (exportArgument !== void 0 && (exportName === void 0 || !isRemoteSegment(exportName))) this.fail(exportArgument, "RemoteScope() name must be a string literal containing only RPC endpoint segment characters");
				marker = {
					kind: "context",
					context,
					...exportName === void 0 ? {} : { exportName }
				};
			} else continue;
			if (found !== void 0) this.fail(decorator, "a method can have only one Remote invocation decorator");
			found = marker;
		}
		return found;
	}
	remoteResultType(method, mode) {
		const authored = this.requiredType(method, method.type, "return");
		if (ts.isTypeReferenceNode(authored)) {
			const symbol = this.checker.getSymbolAtLocation(authored.typeName);
			const resolved = symbol === void 0 ? void 0 : this.resolveSymbol(symbol);
			const resultType = authored.typeArguments?.[0];
			const wrappers = mode === "stream" ? ["Iterable", "AsyncIterable"] : ["Promise"];
			const declaration = resolved === void 0 ? void 0 : preferredDeclaration(resolved);
			if (resolved !== void 0 && wrappers.includes(resolved.name) && resultType !== void 0 && authored.typeArguments?.length === 1 && declaration !== void 0 && isStandardLibraryFile(declaration.getSourceFile().fileName)) return resultType;
		}
		if (mode === "stream") this.fail(method, "stream Remote methods must return Iterable<T> or AsyncIterable<T>");
		return authored;
	}
	isGlobalAbortSignal(type) {
		const symbol = this.symbolAtType(type);
		if (symbol?.name !== "AbortSignal") return false;
		return symbol.declarations?.some((declaration) => isStandardLibraryFile(declaration.getSourceFile().fileName)) === true;
	}
	lookupDeclarations() {
		if (this.staticLookups !== void 0) return this.staticLookups;
		const byKey = /* @__PURE__ */ new Map();
		const byHost = /* @__PURE__ */ new Map();
		for (const declaration of this.typeMetaMapMembers("TypertLookupMap")) {
			if (!ts.isPropertySignature(declaration) || declaration.type === void 0) this.fail(declaration, "TypertLookupMap entries must be required properties");
			const key = memberName(declaration.name);
			if (!isRemoteSegment(key)) this.fail(declaration.name, "TypertLookupMap key must contain only RPC endpoint segment characters");
			if (!ts.isTypeReferenceNode(declaration.type) || !this.isTypeMetaSymbol(declaration.type.typeName, "TypertLookup") || declaration.type.typeArguments?.length !== 2) this.fail(declaration.type, "TypertLookupMap values must be TypertLookup<Host, Wire>");
			const hostType = declaration.type.typeArguments[0];
			const wireType = declaration.type.typeArguments[1];
			if (hostType === void 0 || wireType === void 0) this.fail(declaration.type, "TypertLookupMap values must be TypertLookup<Host, Wire>");
			const host = this.symbolAtType(hostType);
			if (host === void 0) this.fail(hostType, "TypertLookup Host must be a named type");
			const entry = {
				key,
				hostSymbol: this.symbolId(host),
				wireType,
				site: declaration
			};
			if (byKey.has(key)) this.fail(declaration, `duplicate TypertLookupMap key ${key}`);
			if (byHost.has(entry.hostSymbol)) this.fail(declaration, `Host type ${host.name} has more than one Typert lookup`);
			byKey.set(key, entry);
			byHost.set(entry.hostSymbol, entry);
		}
		this.staticLookups = [...byKey.values()];
		return this.staticLookups;
	}
	contextDeclarations() {
		if (this.staticContexts !== void 0) return this.staticContexts;
		const result = /* @__PURE__ */ new Map();
		for (const declaration of this.typeMetaMapMembers("TypertContextMap")) {
			if (!ts.isPropertySignature(declaration) || declaration.type === void 0) this.fail(declaration, "TypertContextMap entries must be required properties");
			const key = memberName(declaration.name);
			if (!isRemoteSegment(key)) this.fail(declaration.name, "TypertContextMap key must contain only RPC endpoint segment characters");
			if (!ts.isTypeReferenceNode(declaration.type) || !this.isTypeMetaSymbol(declaration.type.typeName, "TypertContext") || declaration.type.typeArguments?.length !== 1) this.fail(declaration.type, "TypertContextMap values must be TypertContext<Wire>");
			if (result.has(key)) this.fail(declaration, `duplicate TypertContextMap key ${key}`);
			const wireType = declaration.type.typeArguments[0];
			if (wireType === void 0) this.fail(declaration.type, "TypertContextMap values must be TypertContext<Wire>");
			result.set(key, {
				key,
				wireType,
				site: declaration
			});
		}
		this.staticContexts = result;
		return result;
	}
	typeMetaMapMembers(name) {
		const result = [];
		for (const sourceFile of this.program.getSourceFiles()) for (const statement of sourceFile.statements) {
			if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name) || statement.name.text !== "@deepseek-ai/dsh-typert-protocol" || statement.body === void 0 || !ts.isModuleBlock(statement.body)) continue;
			for (const nested of statement.body.statements) if (ts.isInterfaceDeclaration(nested) && nested.name.text === name) result.push(...nested.members);
		}
		return result;
	}
	remoteBoundary(authoredType, fallbackTypeSymbol, requireNamed, topLevelAbsence = "reject", optional = false) {
		const type = this.convertType(authoredType);
		const declaredType = this.checker.getTypeFromTypeNode(authoredType);
		const resolvedType = optional ? this.checker.getNullableType(declaredType, ts.TypeFlags.Undefined) : declaredType;
		const codecType = this.resolvedRemoteCodecType(authoredType, resolvedType, topLevelAbsence);
		const acceptsUndefined = topLevelAbsence !== "reject" && this.includesRemoteAbsence(resolvedType);
		const rootSymbol = this.namedWorkspaceType(authoredType);
		const imports = /* @__PURE__ */ new Map();
		const visit = (node) => {
			if (ts.isTypeReferenceNode(node) || ts.isImportTypeNode(node)) {
				const symbol = ts.isTypeReferenceNode(node) ? this.checker.getSymbolAtLocation(node.typeName) : node.qualifier === void 0 ? void 0 : this.checker.getSymbolAtLocation(node.qualifier);
				if (symbol !== void 0) {
					const resolved = this.resolveSymbol(symbol);
					const declaration = preferredDeclaration(resolved);
					if (declaration !== void 0 && !isStandardLibraryFile(declaration.getSourceFile().fileName) && this.registrationForFile(declaration.getSourceFile().fileName) !== void 0) {
						const imported = this.publicRemoteType(resolved, node);
						imports.set(imported.symbol, imported);
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(authoredType);
		if (rootSymbol !== void 0) {
			const imported = this.publicRemoteType(rootSymbol, authoredType);
			return {
				type,
				codecType,
				acceptsUndefined,
				typeSymbol: `${imported.specifier}#${imported.name}`,
				imports: [...imports.values()].sort((left, right) => left.specifier.localeCompare(right.specifier) || left.name.localeCompare(right.name))
			};
		}
		if (requireNamed) this.fail(authoredType, "lookup and Context wire types must be named public types");
		return {
			type,
			codecType,
			acceptsUndefined,
			typeSymbol: fallbackTypeSymbol,
			imports: [...imports.values()].sort((left, right) => left.specifier.localeCompare(right.specifier) || left.name.localeCompare(right.name))
		};
	}
	/**
	* Project one authored Remote boundary through the complete face Program.
	* Consumer declarations retain the authored alias, while codecs use this
	* concrete graph so declaration-merged mapped and conditional types are
	* validated without teaching the compiler-independent emitter TypeScript's
	* type evaluator.
	*/
	resolvedRemoteCodecType(authoredType, resolvedType, topLevelAbsence) {
		this.assertRemoteJsonType(resolvedType, authoredType, /* @__PURE__ */ new Set(), topLevelAbsence !== "reject", topLevelAbsence === "undefined-or-void");
		const completed = /* @__PURE__ */ new Map();
		const active = /* @__PURE__ */ new Map();
		const recursiveDeclarations = /* @__PURE__ */ new Map();
		const convert = (type) => {
			const cached = completed.get(type);
			if (cached !== void 0) return cached;
			const activeId = active.get(type);
			if (activeId !== void 0) {
				if (this.checker.isArrayType(type) || this.checker.isArrayLikeType(type)) {
					const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
					const elementId = element === void 0 ? void 0 : active.get(element);
					if (element !== void 0 && elementId !== void 0) return this.addNode(authoredType, {
						kind: "array",
						element: this.resolvedCycleReference(element, authoredType, elementId, recursiveDeclarations)
					});
				}
				return this.resolvedCycleReference(type, authoredType, activeId, recursiveDeclarations);
			}
			const id = this.allocateNodeId(authoredType);
			active.set(type, id);
			try {
				const add = (model) => {
					this.nodes.set(id, {
						id,
						...model
					});
					completed.set(type, id);
					return id;
				};
				const flags = type.flags;
				if ((flags & ts.TypeFlags.Any) !== 0) return add({
					kind: "keyword",
					name: "any"
				});
				if ((flags & ts.TypeFlags.Unknown) !== 0) return add({
					kind: "keyword",
					name: "unknown"
				});
				if ((flags & ts.TypeFlags.Never) !== 0) return add({
					kind: "keyword",
					name: "never"
				});
				if ((flags & ts.TypeFlags.String) !== 0) return add({
					kind: "keyword",
					name: "string"
				});
				if ((flags & ts.TypeFlags.Number) !== 0) return add({
					kind: "keyword",
					name: "number"
				});
				if ((flags & ts.TypeFlags.BigInt) !== 0) return add({
					kind: "keyword",
					name: "bigint"
				});
				if ((flags & ts.TypeFlags.Boolean) !== 0) return add({
					kind: "keyword",
					name: "boolean"
				});
				if ((flags & ts.TypeFlags.ESSymbol) !== 0) return add({
					kind: "keyword",
					name: "symbol"
				});
				if ((flags & ts.TypeFlags.Undefined) !== 0) return add({
					kind: "keyword",
					name: "undefined"
				});
				if ((flags & ts.TypeFlags.Void) !== 0) return add({
					kind: "keyword",
					name: "void"
				});
				if ((flags & ts.TypeFlags.Null) !== 0) return add({
					kind: "literal",
					value: null,
					text: "null"
				});
				if ((flags & ts.TypeFlags.StringLiteral) !== 0) {
					const value = type.value;
					return add({
						kind: "literal",
						value,
						text: JSON.stringify(value)
					});
				}
				if ((flags & ts.TypeFlags.NumberLiteral) !== 0) {
					const value = type.value;
					return add({
						kind: "literal",
						value,
						text: String(value)
					});
				}
				if ((flags & ts.TypeFlags.BigIntLiteral) !== 0) {
					const value = type.value;
					const text = `${value.negative ? "-" : ""}${value.base10Value}n`;
					return add({
						kind: "literal",
						value: BigInt(`${value.negative ? "-" : ""}${value.base10Value}`),
						text
					});
				}
				if ((flags & ts.TypeFlags.BooleanLiteral) !== 0) {
					const value = type.intrinsicName === "true";
					return add({
						kind: "literal",
						value,
						text: String(value)
					});
				}
				if (type.isUnionOrIntersection()) return add({
					kind: (flags & ts.TypeFlags.Union) !== 0 ? "union" : "intersection",
					types: type.types.map(convert)
				});
				if ((flags & ts.TypeFlags.TypeParameter) !== 0) this.fail(authoredType, "Remote codec contains an unresolved type parameter");
				if ((flags & ts.TypeFlags.Object) === 0) this.fail(authoredType, `Remote codec type ${this.checker.typeToString(type, authoredType, ts.TypeFormatFlags.NoTruncation)} has no concrete Zod projection`);
				if (this.checker.isTupleType(type)) {
					const reference = type;
					const target = reference.target;
					return add({
						kind: "tuple",
						elements: this.checker.getTypeArguments(reference).map((argument, index) => {
							const elementFlags = target.elementFlags[index] ?? ts.ElementFlags.Required;
							return {
								type: convert(argument),
								optional: (elementFlags & ts.ElementFlags.Optional) !== 0,
								rest: (elementFlags & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0
							};
						})
					});
				}
				if (this.checker.isArrayType(type) || this.checker.isArrayLikeType(type)) {
					const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
					if (element === void 0) this.fail(authoredType, "Remote codec array has no element type");
					return add({
						kind: "array",
						element: convert(element)
					});
				}
				if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) this.fail(authoredType, "Remote codec cannot contain callable or constructable values");
				const members = [];
				for (const property of this.checker.getPropertiesOfType(type)) {
					const declaration = property.valueDeclaration ?? property.declarations?.[0];
					const propertyType = this.checker.getTypeOfSymbolAtLocation(property, declaration ?? authoredType);
					const symbolKey = property.getName();
					members.push({
						...EMPTY_DOCUMENTATION,
						id: `${id}#${symbolKey}`,
						name: symbolKey,
						...symbolKey.startsWith("__@") ? { computed: "symbol" } : {},
						optional: (property.flags & ts.SymbolFlags.Optional) !== 0,
						readonly: declaration !== void 0 && hasModifier(declaration, ts.SyntaxKind.ReadonlyKeyword),
						async: false,
						abstract: false,
						static: false,
						visibility: "public",
						location: this.location(authoredType),
						text: "",
						kind: "property",
						type: convert(propertyType)
					});
				}
				for (const [index, info] of this.checker.getIndexInfosOfType(type).entries()) members.push({
					...EMPTY_DOCUMENTATION,
					id: `${id}#index:${String(index)}`,
					name: "(index)",
					optional: false,
					readonly: info.isReadonly,
					async: false,
					abstract: false,
					static: false,
					visibility: "public",
					location: this.location(authoredType),
					text: "",
					kind: "index",
					signature: {
						typeParameters: [],
						parameters: [{
							name: "key",
							binding: "identifier",
							type: convert(info.keyType),
							optional: false,
							rest: false,
							receiver: false
						}],
						returns: convert(info.type)
					}
				});
				return add({
					kind: "object",
					members
				});
			} finally {
				active.delete(type);
			}
		};
		return convert(resolvedType);
	}
	assertRemoteJsonType(type, site, active, allowUndefined, allowVoid) {
		const flags = type.flags;
		if ((flags & ts.TypeFlags.Undefined) !== 0 && allowUndefined) return;
		if ((flags & ts.TypeFlags.Void) !== 0 && allowVoid) return;
		if ((flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) this.fail(site, `Remote boundary contains unconstrained ${this.checker.typeToString(type)} data`);
		if ((flags & (ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) this.fail(site, `Remote boundary contains non-JSON type ${this.checker.typeToString(type)}`);
		if ((flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Null | ts.TypeFlags.Never)) !== 0) return;
		if (type.isUnion()) {
			for (const member of type.types) this.assertRemoteJsonType(member, site, active, allowUndefined, allowVoid);
			return;
		}
		if (type.isIntersection()) {
			const material = type.types.filter((member) => !this.isRemotePhantomConstraint(member));
			if (material.length === 0) this.fail(site, "Remote boundary contains a symbol-only object");
			for (const member of material) this.assertRemoteJsonType(member, site, active, false, false);
			return;
		}
		if ((flags & ts.TypeFlags.TypeParameter) !== 0) this.fail(site, "Remote boundary contains an unresolved type parameter");
		if ((flags & ts.TypeFlags.Object) === 0) this.fail(site, `Remote boundary contains non-JSON type ${this.checker.typeToString(type)}`);
		const symbol = type.getSymbol();
		const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
		if (declaration !== void 0 && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))) this.fail(site, `Remote boundary contains class instance ${symbol?.name ?? this.checker.typeToString(type)}`);
		if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) this.fail(site, "Remote boundary contains callable or constructable data");
		if (active.has(type)) return;
		active.add(type);
		try {
			if (this.checker.isTupleType(type)) {
				const reference = type;
				const target = reference.target;
				this.checker.getTypeArguments(reference).forEach((argument, index) => {
					const elementFlags = target.elementFlags[index] ?? ts.ElementFlags.Required;
					this.assertRemoteJsonType(argument, site, active, (elementFlags & ts.ElementFlags.Optional) !== 0, false);
				});
				return;
			}
			if (this.checker.isArrayType(type) || this.checker.isArrayLikeType(type)) {
				const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
				if (element === void 0) this.fail(site, "Remote boundary array has no element type");
				this.assertRemoteJsonType(element, site, active, false, false);
				return;
			}
			const properties = this.checker.getPropertiesOfType(type);
			if (properties.some((property) => property.getName().startsWith("__@"))) this.fail(site, "Remote boundary contains a symbol-keyed property");
			for (const property of properties) {
				const propertyDeclaration = property.valueDeclaration ?? property.declarations?.[0];
				const propertyType = this.checker.getTypeOfSymbolAtLocation(property, propertyDeclaration ?? site);
				this.assertRemoteJsonType(propertyType, site, active, (property.flags & ts.SymbolFlags.Optional) !== 0, false);
			}
			for (const info of this.checker.getIndexInfosOfType(type)) {
				if ((info.keyType.flags & ts.TypeFlags.ESSymbolLike) !== 0) this.fail(site, "Remote boundary contains a symbol index signature");
				this.assertRemoteJsonType(info.type, site, active, false, false);
			}
		} finally {
			active.delete(type);
		}
	}
	includesRemoteAbsence(type) {
		if ((type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) return true;
		return type.isUnion() && type.types.some((member) => this.includesRemoteAbsence(member));
	}
	isRemotePhantomConstraint(type) {
		if ((type.flags & ts.TypeFlags.Unknown) !== 0) return true;
		if ((type.flags & ts.TypeFlags.Any) !== 0 || (type.flags & ts.TypeFlags.Object) === 0) return false;
		if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return false;
		if (this.checker.getIndexInfosOfType(type).length > 0) return false;
		return this.checker.getPropertiesOfType(type).every((property) => property.getName().startsWith("__@"));
	}
	resolvedCycleReference(type, site, resolvedType, recursiveDeclarations) {
		const symbol = type.aliasSymbol ?? type.getSymbol();
		if (symbol === void 0) this.fail(site, "Remote codec contains an unnamed recursive type");
		const resolved = this.resolveSymbol(symbol);
		const declaration = preferredDeclaration(resolved);
		if (declaration === void 0 || isStandardLibraryFile(declaration.getSourceFile().fileName)) this.fail(site, `Remote codec recursive type ${resolved.name} has no workspace declaration`);
		const owner = this.registrationForFile(declaration.getSourceFile().fileName);
		if (owner === void 0) this.fail(site, `Remote codec recursive type ${resolved.name} is not owned by this face`);
		let id = recursiveDeclarations.get(type);
		if (id === void 0) {
			id = `${this.symbolId(resolved)}#remote-codec:${resolvedType}`;
			recursiveDeclarations.set(type, id);
			this.declarations.set(id, {
				...EMPTY_DOCUMENTATION,
				id,
				package: owner.name,
				name: `${resolved.name}RemoteCodec`,
				kind: "alias",
				abstract: false,
				exported: false,
				location: this.location(declaration),
				text: "",
				typeParameters: [],
				extends: [],
				implements: [],
				members: [],
				type: resolvedType
			});
		}
		return this.addNode(site, {
			kind: "reference",
			name: `${resolved.name}RemoteCodec`,
			target: {
				kind: "declaration",
				symbol: id
			},
			arguments: []
		});
	}
	namedWorkspaceType(node) {
		if (!ts.isTypeReferenceNode(node) && !ts.isImportTypeNode(node)) return void 0;
		const symbol = ts.isTypeReferenceNode(node) ? this.checker.getSymbolAtLocation(node.typeName) : node.qualifier === void 0 ? void 0 : this.checker.getSymbolAtLocation(node.qualifier);
		if (symbol === void 0) return void 0;
		const resolved = this.resolveSymbol(symbol);
		const declaration = preferredDeclaration(resolved);
		if (declaration === void 0 || isStandardLibraryFile(declaration.getSourceFile().fileName) || this.registrationForFile(declaration.getSourceFile().fileName) === void 0) return void 0;
		return resolved;
	}
	publicRemoteType(symbol, site) {
		const declaration = preferredDeclaration(symbol);
		if (declaration === void 0) this.fail(site, `type ${symbol.name} has no declaration`);
		const registration = this.registrationForFile(declaration.getSourceFile().fileName);
		if (registration === void 0) this.fail(site, `type ${symbol.name} is not owned by a workspace package`);
		const candidates = [];
		for (const [subpath, target] of packageExportTargets(registration.manifest)) {
			if (subpath === "." || subpath === "./package.json" || subpath === "./typert" || subpath === "./client/typert" || subpath === "./remote" || target.includes("*")) continue;
			const sourceFile = this.sourceFiles.get(realPath(sourcePathForExport(registration.root, target)));
			if (sourceFile === void 0) continue;
			const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile);
			if (moduleSymbol === void 0) continue;
			for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
				if (this.resolveSymbol(exported) !== symbol) continue;
				candidates.push({
					symbol: this.symbolId(symbol),
					specifier: packageExportSpecifier$1(registration.name, subpath),
					name: exported.name
				});
			}
		}
		const selected = candidates.sort((left, right) => left.specifier.localeCompare(right.specifier) || left.name.localeCompare(right.name))[0];
		if (selected === void 0) this.fail(site, `Remote boundary type ${symbol.name} must be exported from a public non-root type subpath`);
		return selected;
	}
	isWorkspaceClass(symbol) {
		const declaration = preferredDeclaration(symbol);
		return declaration !== void 0 && ts.isClassDeclaration(declaration) && this.registrationForFile(declaration.getSourceFile().fileName) !== void 0;
	}
	isTypeMetaSymbol(node, name) {
		const symbol = this.checker.getSymbolAtLocation(node);
		if (symbol === void 0) return false;
		const resolved = this.resolveSymbol(symbol);
		if (resolved.name !== name) return false;
		const declaration = preferredDeclaration(resolved);
		if (declaration === void 0) return false;
		if (this.registrationForFile(declaration.getSourceFile().fileName)?.name === "@deepseek-ai/dsh-typert-protocol") return true;
		for (let current = declaration; current !== void 0; current = optionalParent(current)) if (ts.isModuleDeclaration(current) && ts.isStringLiteral(current.name) && current.name.text === "@deepseek-ai/dsh-typert-protocol") return true;
		return false;
	}
	validateInvocationIdentity(packages) {
		const endpoints = /* @__PURE__ */ new Map();
		const ids = /* @__PURE__ */ new Map();
		for (const invocation of packages.flatMap((packageModel) => packageModel.invocations)) {
			const endpoint = `${invocation.namespace}/${invocation.method}`;
			const existingEndpoint = endpoints.get(endpoint);
			if (existingEndpoint !== void 0) throw new TypertAnalysisError(`typert(${this.face}): ${invocation.location.file}:${String(invocation.location.line)}:${String(invocation.location.column)}: Remote endpoint ${endpoint} conflicts with ${existingEndpoint.id}`);
			const existingId = ids.get(invocation.id);
			if (existingId !== void 0) throw new TypertAnalysisError(`typert(${this.face}): ${invocation.location.file}:${String(invocation.location.line)}:${String(invocation.location.column)}: Remote invocation id ${invocation.id} conflicts with ${existingId.id}`);
			endpoints.set(endpoint, invocation);
			ids.set(invocation.id, invocation);
		}
	}
	collectEvents(events) {
		const result = [];
		for (const member of events.members) {
			const documentation = documentationOf(member);
			const mode = documentation.tags.find((tag) => tag.name === "mode")?.comment?.trim();
			if (ts.isMethodSignature(member)) {
				const signature = this.signature(member, member.type);
				result.push({
					...documentation,
					name: memberName(member.name),
					signature: this.addNode(member, {
						kind: "function",
						signature
					}),
					text: memberText(member),
					...mode === void 0 ? {} : { mode },
					location: this.location(member)
				});
			} else if (ts.isPropertySignature(member) && member.type !== void 0) result.push({
				...documentation,
				name: memberName(member.name),
				signature: this.convertType(member.type),
				text: memberText(member),
				...mode === void 0 ? {} : { mode },
				location: this.location(member)
			});
		}
		return result;
	}
	ensureDeclaration(symbol, selected) {
		const resolved = this.resolveSymbol(symbol);
		const id = this.symbolId(resolved);
		const existing = this.declarations.get(id);
		if (existing !== void 0) return existing;
		const declarationParts = resolved.declarations.filter(isTypeDeclaration);
		if (declarationParts.length > 1 && !declarationParts.every(ts.isInterfaceDeclaration)) this.fail(selected, `merged ${ts.SyntaxKind[selected.kind]} declaration ${resolved.name} is not supported`);
		if (selected.name === void 0) this.fail(selected, `anonymous ${ts.SyntaxKind[selected.kind]} cannot be represented as a named type declaration`);
		const owner = this.registrationForFile(selected.getSourceFile().fileName);
		this.declarationStates.add(id);
		if (declarationParts.length > 1) {
			const analyzedParts = declarationParts.map((declarationPart) => {
				const part = declarationPart;
				const partOwner = this.registrationForFile(part.getSourceFile().fileName);
				if (partOwner === void 0) this.fail(part, `merged interface ${resolved.name} contains a declaration outside this face`);
				const typeParameters = this.typeParameters(part.typeParameters);
				const heritage = this.heritage(part);
				const members = this.members(part.members, id);
				return {
					typeParameters,
					heritage,
					members,
					model: {
						...documentationOf(part),
						package: partOwner.name,
						location: this.location(part),
						typeParameters,
						extends: heritage.extends,
						members: members.map((member) => member.id)
					}
				};
			});
			const parameters = this.mergeTypeParameters(analyzedParts.map((part) => part.typeParameters), selected, resolved.name);
			const model = {
				...documentationOf(selected),
				id,
				package: owner.name,
				name: declarationName(selected),
				kind: "interface",
				abstract: false,
				exported: hasModifier(selected, ts.SyntaxKind.ExportKeyword),
				location: this.location(selected),
				text: declarationText(selected),
				typeParameters: parameters,
				extends: analyzedParts.flatMap((part) => part.heritage.extends),
				implements: [],
				members: analyzedParts.flatMap((part) => part.members),
				parts: analyzedParts.map((part) => part.model)
			};
			this.declarations.set(id, model);
			this.declarationStates.delete(id);
			return model;
		}
		const parameters = ts.isEnumDeclaration(selected) ? [] : this.typeParameters(selected.typeParameters);
		const heritage = ts.isTypeAliasDeclaration(selected) || ts.isEnumDeclaration(selected) ? {
			extends: [],
			implements: []
		} : this.heritage(selected);
		const kind = ts.isClassDeclaration(selected) ? "class" : ts.isInterfaceDeclaration(selected) ? "interface" : ts.isTypeAliasDeclaration(selected) ? "alias" : "enum";
		const model = {
			...documentationOf(selected),
			id,
			package: owner.name,
			name: declarationName(selected),
			kind,
			abstract: hasModifier(selected, ts.SyntaxKind.AbstractKeyword),
			exported: hasModifier(selected, ts.SyntaxKind.ExportKeyword),
			location: this.location(selected),
			text: declarationText(selected),
			typeParameters: parameters,
			extends: heritage.extends,
			implements: heritage.implements,
			members: ts.isTypeAliasDeclaration(selected) || ts.isEnumDeclaration(selected) ? [] : this.members(selected.members, id),
			...ts.isTypeAliasDeclaration(selected) ? { type: this.convertType(selected.type) } : {},
			...ts.isEnumDeclaration(selected) ? { enumMembers: this.enumMembers(selected) } : {}
		};
		this.declarations.set(id, model);
		this.declarationStates.delete(id);
		return model;
	}
	enumMembers(declaration) {
		return declaration.members.map((member) => ({
			...documentationOf(member),
			name: memberName(member.name),
			...member.initializer === void 0 ? {} : { initializer: member.initializer.getText() },
			location: this.location(member)
		}));
	}
	heritage(declaration) {
		const result = {
			extends: [],
			implements: []
		};
		for (const clause of declaration.heritageClauses ?? []) {
			const target = clause.token === ts.SyntaxKind.ExtendsKeyword ? result.extends : result.implements;
			for (const type of clause.types) target.push(this.convertHeritage(type));
		}
		return result;
	}
	convertHeritage(node) {
		const symbol = this.checker.getSymbolAtLocation(node.expression);
		return this.addNode(node, {
			kind: "reference",
			name: node.expression.getText(),
			target: this.targetForReference(this.resolveSymbol(symbol), node),
			arguments: node.typeArguments?.map((argument) => this.convertType(argument)) ?? []
		});
	}
	members(members, ownerId) {
		const result = [];
		for (const member of members) {
			if (ts.isPropertyDeclaration(member) && memberName(member.name) === "typertRemote" && member.initializer !== void 0 && ts.isCallExpression(member.initializer) && this.isTypeMetaSymbol(member.initializer.expression, "bindTypertRemote")) continue;
			if (ts.isMethodDeclaration(member) && member.body !== void 0 && members.some((candidate) => candidate !== member && (ts.isMethodDeclaration(candidate) || ts.isMethodSignature(candidate)) && memberName(candidate.name) === memberName(member.name) && (!ts.isMethodDeclaration(candidate) || candidate.body === void 0))) continue;
			const visibility = visibilityOf(member);
			const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
			if (visibility !== "public" || isStatic || ts.isConstructorDeclaration(member)) continue;
			const base = this.memberBase(member, ownerId, visibility, isStatic);
			if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
				const type = this.requiredType(member, member.type, "property");
				result.push({
					...base,
					kind: "property",
					type: this.convertType(type)
				});
			} else if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) result.push({
				...base,
				kind: "method",
				signature: this.signature(member, member.type)
			});
			else if (ts.isGetAccessorDeclaration(member)) result.push({
				...base,
				kind: "getter",
				signature: this.signature(member, member.type)
			});
			else if (ts.isSetAccessorDeclaration(member)) result.push({
				...base,
				kind: "setter",
				signature: this.signature(member, member.type)
			});
			else if (ts.isCallSignatureDeclaration(member)) result.push({
				...base,
				kind: "call",
				signature: this.signature(member, member.type)
			});
			else if (ts.isConstructSignatureDeclaration(member)) result.push({
				...base,
				kind: "construct",
				signature: this.signature(member, member.type)
			});
			else if (ts.isIndexSignatureDeclaration(member)) result.push({
				...base,
				kind: "index",
				signature: this.signature(member, member.type)
			});
		}
		return result;
	}
	memberBase(member, ownerId, visibility, isStatic) {
		const identity = member.name !== void 0 ? this.memberIdentity(member.name) : { name: ts.isCallSignatureDeclaration(member) ? "(call)" : ts.isConstructSignatureDeclaration(member) ? "(construct)" : "(index)" };
		return {
			...documentationOf(member),
			id: `${ownerId}#${identity.name}@${String(member.getStart())}`,
			...identity,
			optional: "questionToken" in member && member.questionToken !== void 0,
			readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
			async: hasModifier(member, ts.SyntaxKind.AsyncKeyword),
			abstract: hasModifier(member, ts.SyntaxKind.AbstractKeyword),
			static: isStatic,
			visibility,
			location: this.location(member),
			text: memberText(member)
		};
	}
	memberIdentity(name) {
		if (!ts.isComputedPropertyName(name)) return { name: memberName(name) };
		const expression = name.expression;
		if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return {
			name: memberName(name),
			jsonName: expression.text
		};
		const type = this.checker.getTypeAtLocation(expression);
		return {
			name: memberName(name),
			computed: (type.flags & ts.TypeFlags.UniqueESSymbol) !== 0 ? "symbol" : "dynamic"
		};
	}
	signature(node, explicitReturn) {
		const parameters = node.parameters.map((parameter) => ({
			name: memberName(parameter.name),
			binding: ts.isIdentifier(parameter.name) ? "identifier" : ts.isObjectBindingPattern(parameter.name) ? "object" : "array",
			type: this.convertType(this.requiredType(parameter, parameter.type, "parameter")),
			optional: parameter.questionToken !== void 0 || parameter.initializer !== void 0,
			rest: parameter.dotDotDotToken !== void 0,
			receiver: ts.isIdentifier(parameter.name) && parameter.name.text === "this",
			...parameter.initializer === void 0 ? {} : { initializer: parameter.initializer.getText() }
		}));
		return {
			typeParameters: this.typeParameters(node.typeParameters),
			parameters,
			returns: ts.isSetAccessorDeclaration(node) ? this.addNode(node, {
				kind: "keyword",
				name: "void"
			}) : this.convertType(this.requiredType(node, explicitReturn, "return"))
		};
	}
	typeParameters(parameters) {
		return parameters?.map((parameter) => ({
			id: `${this.locationKey(parameter)}#${parameter.name.text}`,
			name: parameter.name.text,
			const: hasModifier(parameter, ts.SyntaxKind.ConstKeyword),
			...parameter.constraint === void 0 ? {} : { constraint: this.convertType(parameter.constraint) },
			...parameter.default === void 0 ? {} : { default: this.convertType(parameter.default) },
			...hasModifier(parameter, ts.SyntaxKind.InKeyword) && hasModifier(parameter, ts.SyntaxKind.OutKeyword) ? { variance: "in-out" } : hasModifier(parameter, ts.SyntaxKind.InKeyword) ? { variance: "in" } : hasModifier(parameter, ts.SyntaxKind.OutKeyword) ? { variance: "out" } : {}
		})) ?? [];
	}
	mergeTypeParameters(parts, site, declarationName) {
		return parts[0].map((parameter, index) => {
			const peers = parts.map((part) => part[index]);
			const constraint = peers.find((peer) => peer.constraint !== void 0)?.constraint;
			const fallback = peers.find((peer) => peer.default !== void 0)?.default;
			const variances = [...new Set(peers.flatMap((peer) => peer.variance === void 0 ? [] : [peer.variance]))];
			if (variances.length > 1) this.fail(site, `merged interface ${declarationName} has incompatible variance modifiers`);
			return {
				id: parameter.id,
				name: parameter.name,
				const: peers.some((peer) => peer.const),
				...constraint === void 0 ? {} : { constraint },
				...fallback === void 0 ? {} : { default: fallback },
				...variances[0] === void 0 ? {} : { variance: variances[0] }
			};
		});
	}
	requiredType(owner, type, purpose) {
		if (type !== void 0) return type;
		if (this.mode === "check") this.fail(owner, `public ${purpose} is missing an explicit type annotation`);
		const inferred = this.inferType(owner, purpose);
		const rendered = ts.createPrinter().printNode(ts.EmitHint.Unspecified, inferred, owner.getSourceFile());
		const position = annotationPosition(owner, purpose);
		this.queueEdit({
			file: realPath(owner.getSourceFile().fileName),
			position,
			text: `: ${rendered}`
		});
		throw new SourceEditQueued();
	}
	inferType(owner, purpose) {
		let type;
		if (purpose === "return") {
			const signature = this.checker.getSignatureFromDeclaration(owner);
			type = this.checker.getReturnTypeOfSignature(signature);
		} else type = this.checker.getTypeAtLocation(owner);
		return this.checker.typeToTypeNode(type, owner, ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope);
	}
	convertType(node) {
		const id = this.allocateNodeId(node);
		const add = (model) => {
			this.nodes.set(id, {
				id,
				...model
			});
			return id;
		};
		const keyword = keywordName(node.kind);
		if (keyword !== void 0) return add({
			kind: "keyword",
			name: keyword
		});
		if (ts.isParenthesizedTypeNode(node)) return add({
			kind: "parenthesized",
			type: this.convertType(node.type)
		});
		if (ts.isLiteralTypeNode(node)) return add(literalModel(node));
		if (ts.isTypeReferenceNode(node)) {
			const symbol = this.checker.getSymbolAtLocation(node.typeName);
			return add({
				kind: "reference",
				name: node.typeName.getText(),
				target: this.targetForReference(this.resolveSymbol(symbol), node),
				arguments: node.typeArguments?.map((argument) => this.convertType(argument)) ?? []
			});
		}
		if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) return add({
			kind: ts.isUnionTypeNode(node) ? "union" : "intersection",
			types: node.types.map((type) => this.convertType(type))
		});
		if (ts.isArrayTypeNode(node)) return add({
			kind: "array",
			element: this.convertType(node.elementType)
		});
		if (ts.isTupleTypeNode(node)) return add({
			kind: "tuple",
			elements: node.elements.map((element) => {
				const named = ts.isNamedTupleMember(element) ? element : void 0;
				const raw = named?.type ?? element;
				const optional = named?.questionToken !== void 0 || ts.isOptionalTypeNode(raw);
				const rest = named?.dotDotDotToken !== void 0 || ts.isRestTypeNode(raw);
				const type = ts.isOptionalTypeNode(raw) || ts.isRestTypeNode(raw) ? raw.type : raw;
				return {
					...named === void 0 ? {} : { name: named.name.text },
					type: this.convertType(type),
					optional,
					rest
				};
			})
		});
		if (ts.isTypeLiteralNode(node)) return add({
			kind: "object",
			members: this.members(node.members, id)
		});
		if (ts.isFunctionTypeNode(node)) return add({
			kind: "function",
			signature: this.signature(node, node.type)
		});
		if (ts.isConstructorTypeNode(node)) return add({
			kind: "constructor",
			abstract: hasModifier(node, ts.SyntaxKind.AbstractKeyword),
			signature: this.signature(node, node.type)
		});
		if (ts.isIndexedAccessTypeNode(node)) return add({
			kind: "indexed-access",
			object: this.convertType(node.objectType),
			index: this.convertType(node.indexType)
		});
		if (ts.isTypeOperatorNode(node)) return add({
			kind: "operator",
			operator: ts.tokenToString(node.operator),
			type: this.convertType(node.type)
		});
		if (ts.isConditionalTypeNode(node)) return add({
			kind: "conditional",
			check: this.convertType(node.checkType),
			extends: this.convertType(node.extendsType),
			whenTrue: this.convertType(node.trueType),
			whenFalse: this.convertType(node.falseType)
		});
		if (ts.isInferTypeNode(node)) return add({
			kind: "infer",
			parameter: this.typeParameters(ts.factory.createNodeArray([node.typeParameter]))[0]
		});
		if (ts.isMappedTypeNode(node)) {
			const parameter = this.typeParameters(ts.factory.createNodeArray([node.typeParameter]))[0];
			return add({
				kind: "mapped",
				parameter,
				...node.nameType === void 0 ? {} : { nameType: this.convertType(node.nameType) },
				...node.type === void 0 ? {} : { value: this.convertType(node.type) },
				readonly: modifierMode(node.readonlyToken),
				optional: modifierMode(node.questionToken)
			});
		}
		if (ts.isTemplateLiteralTypeNode(node)) return add({
			kind: "template-literal",
			head: node.head.text,
			spans: node.templateSpans.map((span) => ({
				type: this.convertType(span.type),
				text: span.literal.text
			}))
		});
		if (ts.isTypeQueryNode(node)) return add({
			kind: "type-query",
			expression: node.exprName.getText(),
			arguments: node.typeArguments?.map((argument) => this.convertType(argument)) ?? []
		});
		if (ts.isImportTypeNode(node)) {
			const argument = node.argument;
			const symbol = node.qualifier === void 0 ? void 0 : this.checker.getSymbolAtLocation(node.qualifier);
			return add({
				kind: "import-type",
				module: argument.literal.text,
				...node.qualifier === void 0 ? {} : { qualifier: node.qualifier.getText() },
				arguments: node.typeArguments?.map((argument) => this.convertType(argument)) ?? [],
				typeof: node.isTypeOf,
				...node.attributes === void 0 ? {} : { attributes: importTypeAttributesText(node) },
				...symbol === void 0 ? {} : { target: this.targetForReference(this.resolveSymbol(symbol), node) }
			});
		}
		if (ts.isTypePredicateNode(node)) return add({
			kind: "predicate",
			asserts: node.assertsModifier !== void 0,
			parameter: node.parameterName.getText(),
			...node.type === void 0 ? {} : { type: this.convertType(node.type) }
		});
		/* v8 ignore else -- every source TypeNode kind accepted by TypeScript is handled above; this arm keeps
		* future compiler kinds fail-loud. */
		if (ts.isThisTypeNode(node)) return add({ kind: "this" });
		/* v8 ignore next -- paired with the exhaustive TypeNode guard above. */
		this.fail(node, `unsupported TypeScript type node ${ts.SyntaxKind[node.kind]}`);
	}
	addNode(site, model) {
		const id = this.allocateNodeId(site);
		this.nodes.set(id, {
			id,
			...model
		});
		return id;
	}
	referenceNode(symbol, site) {
		return this.addNode(site, {
			kind: "reference",
			name: symbol.name,
			target: {
				kind: "declaration",
				symbol: this.symbolId(symbol)
			},
			arguments: []
		});
	}
	targetForReference(symbol, site) {
		const declaration = preferredDeclaration(symbol);
		/* v8 ignore next -- a symbol from a semantically valid source type reference always has a declaration. */
		if (declaration === void 0) this.fail(site, `type symbol ${symbol.name} has no declaration`);
		if (ts.isTypeParameterDeclaration(declaration)) return {
			kind: "type-parameter",
			parameter: `${this.locationKey(declaration)}#${declaration.name.text}`
		};
		if (isStandardLibraryFile(declaration.getSourceFile().fileName)) return {
			kind: "standard",
			name: symbol.name
		};
		const moduleSpecifier = moduleSpecifierOf(site);
		const module = moduleSpecifier === void 0 ? void 0 : moduleIdentity(moduleSpecifier);
		const from = this.registrationForFile(site.getSourceFile().fileName);
		const owner = this.registrationForFile(declaration.getSourceFile().fileName);
		if (owner !== void 0) {
			if (owner.name !== from.name) {
				if (module === void 0) this.fail(site, `reference to ${symbol.name} crosses a package without an explicit package import`);
				const exportName = authoredExportName(site, moduleSpecifier);
				if (this.packageExportName(module, symbol, owner.face, exportName) === void 0) this.fail(site, `package reference ${exportName} is not exported by ${module.package} at ${module.subpath}`);
			}
			const typeDeclaration = declaration;
			if (!this.declarationStates.has(this.symbolId(symbol))) this.ensureDeclaration(symbol, typeDeclaration);
			return {
				kind: "declaration",
				symbol: this.symbolId(symbol)
			};
		}
		const otherFace = (module === void 0 ? [] : [...new Set(this.allRegistrations.filter((candidate) => candidate.name === module.package).map((candidate) => candidate.face))]).find((face) => face !== this.face);
		if (otherFace !== void 0 && module !== void 0) {
			const requestedName = authoredExportName(site, moduleSpecifier);
			const exportName = this.packageExportName(module, symbol, otherFace, requestedName);
			if (exportName === void 0) this.fail(site, `cross-face reference ${requestedName} is not exported by ${module.package} at ${module.subpath}`);
			this.recordCrossFaceLink(from.name, otherFace, module, exportName);
			return {
				kind: "cross-face",
				face: otherFace,
				package: module.package,
				subpath: module.subpath,
				name: exportName
			};
		}
		if (module !== void 0) return {
			kind: "external",
			module: module.package,
			subpath: module.subpath,
			name: symbol.name
		};
		const external = externalModuleIdentityForFile(declaration.getSourceFile().fileName);
		if (external !== void 0) return {
			kind: "external",
			module: external.package,
			subpath: external.subpath,
			name: symbol.name
		};
		this.fail(site, `reference to ${symbol.name} crosses a package or face without an explicit import`);
	}
	recordCrossFaceLink(fromPackage, toFace, module, name) {
		const link = {
			fromFace: this.face,
			fromPackage,
			toFace,
			toPackage: module.package,
			subpath: module.subpath,
			name
		};
		const key = [
			link.fromFace,
			link.fromPackage,
			link.toFace,
			link.toPackage,
			link.subpath,
			link.name
		].join("\0");
		this.crossFaceLinks.set(key, link);
	}
	packageExportName(module, symbol, face, requestedName) {
		const registration = this.allRegistrations.find((candidate) => candidate.face === face && candidate.name === module.package);
		const target = packageExportTargets(registration.manifest).find(([subpath]) => subpath === module.subpath)?.[1];
		if (target === void 0) return void 0;
		const sourceFile = this.sourceFiles.get(realPath(sourcePathForExport(registration.root, target)));
		const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile);
		return this.checker.getExportsOfModule(moduleSymbol).find((candidate) => candidate.name === requestedName && this.resolveSymbol(candidate) === symbol)?.name;
	}
	symbolAtType(node) {
		if (ts.isTypeReferenceNode(node)) return this.resolveSymbol(this.checker.getSymbolAtLocation(node.typeName));
		const type = this.checker.getTypeAtLocation(node);
		const symbol = type.aliasSymbol ?? type.getSymbol();
		return symbol === void 0 ? void 0 : this.resolveSymbol(symbol);
	}
	resolveSymbol(symbol) {
		return (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : this.checker.getAliasedSymbol(symbol);
	}
	symbolId(symbol) {
		const declaration = preferredDeclaration(symbol);
		if (declaration === void 0) return `symbol:${symbol.name}`;
		const location = this.location(declaration);
		return `${this.packageNameForFile(declaration.getSourceFile().fileName)}:${location.file}#${symbol.name}`;
	}
	registrationForFile(file) {
		const path = realPath(file);
		return this.allRegistrations.find((registration) => registration.face === this.face && isWithin(path, registration.root));
	}
	packageNameForFile(file) {
		const path = realPath(file);
		return this.allRegistrations.find((registration) => isWithin(path, registration.root))?.name ?? "<external>";
	}
	allocateNodeId(site) {
		const location = this.locationKey(site);
		const ordinal = (this.nodeOrdinals.get(location) ?? 0) + 1;
		this.nodeOrdinals.set(location, ordinal);
		return `type:${location}#${String(ordinal)}`;
	}
	locationKey(node) {
		const location = this.location(node);
		return `${location.file}:${String(location.line)}:${String(location.column)}`;
	}
	location(node) {
		const sourceFile = node.getSourceFile();
		const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		return {
			file: slash(relative(this.root, sourceFile.fileName)),
			line: position.line + 1,
			column: position.character + 1
		};
	}
	fail(node, message) {
		const location = this.location(node);
		throw new TypertAnalysisError(`typert(${this.face}): ${location.file}:${String(location.line)}:${String(location.column)}: ${message}`);
	}
};
function mergeWorkspaceModels(models) {
	const faces = /* @__PURE__ */ new Map();
	const links = /* @__PURE__ */ new Map();
	for (const model of models) {
		for (const face of model.faces) {
			const merged = faces.get(face.face) ?? {
				packages: /* @__PURE__ */ new Map(),
				declarations: /* @__PURE__ */ new Map(),
				nodes: /* @__PURE__ */ new Map()
			};
			for (const packageModel of face.packages) merged.packages.set(packageModel.name, packageModel);
			for (const declaration of face.graph.declarations) if (!merged.declarations.has(declaration.id)) merged.declarations.set(declaration.id, declaration);
			for (const node of face.graph.nodes) if (!merged.nodes.has(node.id)) merged.nodes.set(node.id, node);
			faces.set(face.face, merged);
		}
		for (const link of model.crossFaceLinks) links.set([
			link.fromFace,
			link.fromPackage,
			link.toFace,
			link.toPackage,
			link.subpath,
			link.name
		].join("\0"), link);
	}
	return {
		faces: [...faces].sort(([left], [right]) => (left === "host" ? 0 : 1) - (right === "host" ? 0 : 1)).map(([face, model]) => ({
			face,
			packages: [...model.packages.values()].sort((left, right) => left.name.localeCompare(right.name)),
			graph: {
				declarations: [...model.declarations.values()].sort((left, right) => left.id.localeCompare(right.id)),
				nodes: [...model.nodes.values()].sort((left, right) => left.id.localeCompare(right.id))
			}
		})),
		crossFaceLinks: [...links.values()].sort(compareCrossFaceLinks)
	};
}
function parseConfig(path) {
	const compilerPath = path.split(sep).join("/");
	const read = ts.readConfigFile(compilerPath, (file) => ts.sys.readFile(file));
	if (read.error !== void 0) throw new TypertAnalysisError(formatDiagnostic(read.error));
	const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(compilerPath), void 0, compilerPath);
	if (parsed.errors.length > 0) throw new TypertAnalysisError(parsed.errors.map(formatDiagnostic).join("\n"));
	return {
		path,
		parsed
	};
}
function projectConfigPath(path) {
	if (extname(path) === ".json") return path;
	return join(path, "tsconfig.json");
}
function sourceFileHasSurface(sourceFile) {
	for (const statement of sourceFile.statements) {
		if ((ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && (typertMode(statement) !== void 0 || typertServiceTag(statement) !== void 0)) return true;
		if (ts.isClassDeclaration(statement)) for (const member of statement.members) {
			if (ts.isPropertyDeclaration(member) && memberName(member.name) === "typertRemote" && member.initializer !== void 0 && ts.isCallExpression(member.initializer) && expressionName(member.initializer.expression) === "bindTypertRemote") return true;
			for (const decorator of ts.canHaveDecorators(member) ? ts.getDecorators(member) ?? [] : []) {
				const name = expressionName(ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression);
				if (name === "Remote" || name === "RemoteScope") return true;
			}
		}
		if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name) || statement.name.text !== "@deepseek-ai/cordis" || statement.body === void 0 || !ts.isModuleBlock(statement.body)) continue;
		if (statement.body.statements.some((member) => ts.isInterfaceDeclaration(member) && (member.name.text === "Context" || member.name.text === "Events") && member.members.length > 0)) return true;
	}
	return false;
}
function hasPackageSurface(model) {
	return model.services.length > 0 || model.events.length > 0 || model.objects.length > 0 || model.schemas.length > 0 || model.invocations.length > 0;
}
function isDualFacePackage(manifest) {
	const dsh = manifest.dsh;
	const client = dsh !== null && typeof dsh === "object" ? dsh.client : void 0;
	return client !== null && typeof client === "object" && clientExportSubpaths(manifest).length > 0;
}
function hostExportSubpaths(manifest) {
	return packageExportTargets(manifest).map(([subpath]) => subpath).filter((subpath) => subpath !== "./client" && !subpath.startsWith("./client/") && subpath !== "./remote");
}
function clientExportSubpaths(manifest) {
	return packageExportTargets(manifest).map(([subpath]) => subpath).filter((subpath) => subpath === "./client" || subpath.startsWith("./client/"));
}
function packageExportTargets(manifest) {
	const exportsField = manifest.exports;
	if (typeof exportsField === "string") return [[".", exportsField]];
	if (exportsField === null || typeof exportsField !== "object") {
		const types = manifest.types;
		return typeof types === "string" ? [[".", types]] : [];
	}
	if (Array.isArray(exportsField) || !Object.keys(exportsField).some((key) => key.startsWith("."))) {
		const target = exportTarget(exportsField);
		return target === void 0 ? [] : [[".", target]];
	}
	const result = [];
	for (const [subpath, value] of Object.entries(exportsField)) {
		if (!subpath.startsWith(".")) continue;
		const target = exportTarget(value);
		if (target !== void 0) result.push([subpath, target]);
	}
	return result.sort(([left], [right]) => left.localeCompare(right));
}
function exportTarget(value) {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const candidate of value) {
			const target = exportTarget(candidate);
			if (target !== void 0) return target;
		}
		return;
	}
	if (value === null || typeof value !== "object") return void 0;
	const conditions = value;
	for (const key of [
		"types",
		"import",
		"default"
	]) {
		const target = exportTarget(conditions[key]);
		if (target !== void 0) return target;
	}
	for (const candidate of Object.values(conditions)) {
		const target = exportTarget(candidate);
		if (target !== void 0) return target;
	}
}
function sourcePathForExport(packageRoot, target) {
	const normalized = target.replace(/^\.\//, "");
	if (normalized.startsWith("lib/types/")) return resolve(packageRoot, "src", normalized.slice(10).replace(/\.d\.(?:mts|cts|ts)$/, ".ts"));
	if (normalized.startsWith("lib/")) return resolve(packageRoot, "src", normalized.slice(4).replace(/\.(?:mjs|cjs|js|d\.ts)$/, ".ts"));
	return resolve(packageRoot, normalized);
}
function preferredDeclaration(symbol) {
	return symbol.declarations?.find(isTypeDeclaration) ?? symbol.valueDeclaration ?? symbol.declarations?.[0];
}
function optionalParent(node) {
	return node.parent;
}
function isTypeDeclaration(node) {
	return ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node);
}
function declarationName(declaration) {
	return declaration.name.text;
}
function memberText(member) {
	const sourceFile = member.getSourceFile();
	const full = member.getText(sourceFile);
	const body = member.body;
	return (body === void 0 ? full : full.slice(0, full.length - body.getText(sourceFile).length)).replace(/\s*;?\s*$/, "").replace(/\s+/g, " ").trim();
}
function declarationText(declaration) {
	const printer = ts.createPrinter({ removeComments: true });
	const projected = ts.isClassDeclaration(declaration) ? classShape(declaration) : declaration;
	return printer.printNode(ts.EmitHint.Unspecified, projected, declaration.getSourceFile()).replace(/\r/g, "");
}
function classShape(node) {
	const nonPublic = (member) => (ts.canHaveModifiers(member) ? ts.getModifiers(member) : void 0)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword) ?? false;
	const members = node.members.flatMap((member) => {
		if (nonPublic(member) || ts.isPropertyDeclaration(member) && ts.isPrivateIdentifier(member.name)) return [];
		if (ts.isMethodDeclaration(member)) return [ts.factory.updateMethodDeclaration(member, member.modifiers, member.asteriskToken, member.name, member.questionToken, member.typeParameters, member.parameters, member.type, void 0)];
		if (ts.isConstructorDeclaration(member)) return [ts.factory.updateConstructorDeclaration(member, member.modifiers, member.parameters, void 0)];
		if (ts.isGetAccessorDeclaration(member)) return [ts.factory.updateGetAccessorDeclaration(member, member.modifiers, member.name, member.parameters, member.type, void 0)];
		if (ts.isSetAccessorDeclaration(member)) return [ts.factory.updateSetAccessorDeclaration(member, member.modifiers, member.name, member.parameters, void 0)];
		if (ts.isPropertyDeclaration(member)) return [ts.factory.updatePropertyDeclaration(member, member.modifiers, member.name, member.questionToken ?? member.exclamationToken, member.type, void 0)];
		return [member];
	});
	return ts.factory.updateClassDeclaration(node, node.modifiers, node.name, node.typeParameters, node.heritageClauses, members);
}
function documentationOf(node) {
	const block = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc).at(-1);
	if (block === void 0) return EMPTY_DOCUMENTATION;
	const description = normalizedDocText(ts.getTextOfJSDocComment(block.comment));
	const tags = ts.getJSDocTags(node).map((tag) => {
		const named = tag;
		const comment = normalizedDocText(ts.getTextOfJSDocComment(tag.comment));
		return {
			name: tag.tagName.text,
			...named.name === void 0 ? {} : { argument: named.name.getText() },
			...comment === void 0 ? {} : { comment },
			text: tag.getText(tag.getSourceFile()).trim()
		};
	});
	return {
		...description === void 0 ? {} : {
			description,
			summary: firstSentence$1(description)
		},
		tags,
		jsDoc: rawJsDoc(node)
	};
}
function normalizedDocText(value) {
	if (value === void 0) return void 0;
	const normalized = value.replace(/\s+/g, " ").trim();
	/* v8 ignore next -- TypeScript represents whitespace-only JSDoc as undefined before this helper is called. */
	return normalized.length === 0 ? void 0 : normalized;
}
function firstSentence$1(value) {
	return (/^(.*?[.!?])(?:\s|$)/.exec(value)?.[1] ?? value).trim();
}
function rawJsDoc(node) {
	const sourceFile = node.getSourceFile();
	const source = sourceFile.getFullText();
	const range = ts.getLeadingCommentRanges(source, node.getFullStart()).filter((candidate) => source.slice(candidate.pos, candidate.pos + 3) === "/**").at(-1);
	const raw = source.slice(range.pos, range.end);
	const { line } = sourceFile.getLineAndCharacterOfPosition(range.pos);
	const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);
	const indent = source.slice(lineStart, range.pos);
	return raw.split("\n").map((text, index) => index > 0 && text.startsWith(indent) ? text.slice(indent.length) : text).join("\n");
}
function typertMode(node) {
	for (const tag of ts.getJSDocTags(node)) {
		if (tag.tagName.text !== "typert") continue;
		const mode = (ts.getTextOfJSDocComment(tag.comment) ?? "").trim().split(/\s+/, 1)[0];
		if (mode === "object") return "object";
		if (mode === "" || mode === "schema" || mode === "type") return "schema";
	}
}
function typertServiceTag(node) {
	return ts.getJSDocTags(node).find((tag) => tag.tagName.text === "typert" && (ts.getTextOfJSDocComment(tag.comment) ?? "").trim().split(/\s+/, 1)[0] === "service");
}
function memberName(name) {
	if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
	if (ts.isComputedPropertyName(name)) return `[${name.expression.getText()}]`;
	return name.getText();
}
function stringLiteralValue(node) {
	return node !== void 0 && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : void 0;
}
function isRemoteSegment(value) {
	return value !== "." && value !== ".." && /^[A-Za-z0-9_$.-]+$/.test(value);
}
function expressionName(node) {
	if (ts.isIdentifier(node)) return node.text;
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
}
function packageExportSpecifier$1(packageName, subpath) {
	return subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`;
}
function visibilityOf(node) {
	if ("name" in node && node.name !== void 0 && ts.isPrivateIdentifier(node.name)) return "private";
	if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) return "private";
	if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return "protected";
	return "public";
}
function hasModifier(node, kind) {
	return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : void 0)?.some((modifier) => modifier.kind === kind) ?? false;
}
function exposableMember(member) {
	return member.visibility === "public" && !member.static;
}
function keywordName(kind) {
	switch (kind) {
		case ts.SyntaxKind.AnyKeyword: return "any";
		case ts.SyntaxKind.BigIntKeyword: return "bigint";
		case ts.SyntaxKind.BooleanKeyword: return "boolean";
		case ts.SyntaxKind.NeverKeyword: return "never";
		case ts.SyntaxKind.NumberKeyword: return "number";
		case ts.SyntaxKind.ObjectKeyword: return "object";
		case ts.SyntaxKind.StringKeyword: return "string";
		case ts.SyntaxKind.SymbolKeyword: return "symbol";
		case ts.SyntaxKind.UndefinedKeyword: return "undefined";
		case ts.SyntaxKind.UnknownKeyword: return "unknown";
		case ts.SyntaxKind.VoidKeyword: return "void";
		default: return;
	}
}
function literalModel(node) {
	const literal = node.literal;
	if (ts.isStringLiteral(literal)) return {
		kind: "literal",
		value: literal.text,
		text: literal.getText()
	};
	if (ts.isNoSubstitutionTemplateLiteral(literal)) return {
		kind: "literal",
		value: literal.text,
		text: literal.getText()
	};
	if (ts.isNumericLiteral(literal)) return {
		kind: "literal",
		value: Number(literal.text),
		text: literal.getText()
	};
	if (ts.isBigIntLiteral(literal)) return {
		kind: "literal",
		value: BigInt(literal.text.slice(0, -1)),
		text: literal.getText()
	};
	if (literal.kind === ts.SyntaxKind.TrueKeyword) return {
		kind: "literal",
		value: true,
		text: "true"
	};
	if (literal.kind === ts.SyntaxKind.FalseKeyword) return {
		kind: "literal",
		value: false,
		text: "false"
	};
	if (literal.kind === ts.SyntaxKind.NullKeyword) return {
		kind: "literal",
		value: null,
		text: "null"
	};
	/* v8 ignore else -- all remaining LiteralTypeNode syntax is a signed numeric or bigint literal. */
	if (ts.isPrefixUnaryExpression(literal) && (ts.isNumericLiteral(literal.operand) || ts.isBigIntLiteral(literal.operand))) return {
		kind: "literal",
		value: ts.isBigIntLiteral(literal.operand) ? BigInt(literal.getText().slice(0, -1)) : Number(literal.getText()),
		text: literal.getText()
	};
	/* v8 ignore next -- TypeScript's LiteralTypeNode grammar is exhausted above; this contains future compiler syntax. */
	throw new TypertAnalysisError(`typert: unsupported literal type ${literal.getText()}`);
}
function modifierMode(token) {
	if (token?.kind === ts.SyntaxKind.PlusToken) return "add";
	if (token?.kind === ts.SyntaxKind.MinusToken) return "remove";
	return token === void 0 ? "preserve" : "add";
}
function annotationPosition(node, purpose) {
	if (purpose === "return") return node.parameters.end + 1;
	return node.name.end;
}
function moduleSpecifierOf(node) {
	if (ts.isImportTypeNode(node)) return node.argument.literal.text;
	const symbol = ts.isTypeReferenceNode(node) ? node.typeName : node.expression;
	const sourceFile = node.getSourceFile();
	const first = ts.isIdentifier(symbol) ? symbol.text : symbol.getFirstToken(sourceFile)?.getText(sourceFile);
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement) || statement.importClause === void 0 || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		if (statement.importClause.name?.text === first) return statement.moduleSpecifier.text;
		const bindings = statement.importClause.namedBindings;
		if (bindings !== void 0 && ts.isNamespaceImport(bindings) && bindings.name.text === first) return statement.moduleSpecifier.text;
		if (bindings !== void 0 && ts.isNamedImports(bindings) && bindings.elements.some((element) => element.name.text === first)) return statement.moduleSpecifier.text;
	}
}
function authoredExportName(node, moduleSpecifier) {
	if (ts.isImportTypeNode(node)) return node.qualifier.getText().split(".")[0];
	const referenced = ts.isTypeReferenceNode(node) ? node.typeName.getText().split(".") : node.expression.getText().split(".");
	const localName = referenced[0];
	for (const statement of node.getSourceFile().statements) {
		if (!ts.isImportDeclaration(statement) || statement.importClause === void 0 || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== moduleSpecifier) continue;
		if (statement.importClause.name?.text === localName) return "default";
		const bindings = statement.importClause.namedBindings;
		if (bindings !== void 0 && ts.isNamedImports(bindings)) {
			const imported = bindings.elements.find((element) => element.name.text === localName);
			if (imported !== void 0) return imported.propertyName?.text ?? imported.name.text;
		}
		if (bindings !== void 0 && ts.isNamespaceImport(bindings) && bindings.name.text === localName) return referenced[1];
	}
	/* v8 ignore next -- moduleSpecifierOf returns only the matching import inspected by this loop. */
	throw new TypertAnalysisError(`typert: cannot recover export name for ${localName} from ${moduleSpecifier}`);
}
function importTypeAttributesText(node) {
	const sourceFile = node.getSourceFile();
	const children = node.getChildren(sourceFile);
	const comma = children.find((child) => child.kind === ts.SyntaxKind.CommaToken);
	const close = children.find((child) => child.kind === ts.SyntaxKind.CloseParenToken);
	return sourceFile.text.slice(comma.end, close.pos).trim();
}
function moduleIdentity(specifier) {
	if (specifier.startsWith(".") || specifier.startsWith("/")) return void 0;
	const parts = specifier.split("/");
	const packageLength = specifier.startsWith("@") ? 2 : 1;
	const packageName = parts.slice(0, packageLength).join("/");
	const rest = parts.slice(packageLength).join("/");
	return {
		package: packageName,
		subpath: rest.length === 0 ? "." : `./${rest}`
	};
}
function externalModuleIdentityForFile(file) {
	const normalized = slash(file);
	const index = normalized.lastIndexOf("/node_modules/");
	if (index < 0) return void 0;
	const parts = normalized.slice(index + 14).split("/");
	const packageLength = parts[0].startsWith("@") ? 2 : 1;
	return {
		package: parts.slice(0, packageLength).join("/"),
		subpath: "."
	};
}
function isStandardLibraryFile(file) {
	const base = file.replaceAll("\\", "/");
	return /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/.test(base);
}
function formatDiagnostic(diagnostic) {
	return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}
function formatProgramDiagnostic(root, face, diagnostic) {
	const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
	const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
	return `typert(${face}): ${slash(relative(root, diagnostic.file.fileName))}:${String(position.line + 1)}:${String(position.character + 1)}: TypeScript TS${String(diagnostic.code)}: ${message}`;
}
const realPathCache = /* @__PURE__ */ new Map();
function realPath(path) {
	const absolute = resolve(path);
	const cached = realPathCache.get(absolute);
	if (cached !== void 0) return cached;
	if (!existsSync(absolute)) return absolute;
	const resolved = realpathSync(absolute);
	realPathCache.set(absolute, resolved);
	return resolved;
}
function isWithin(path, root) {
	const absolute = realPath(path);
	const parent = realPath(root);
	return absolute === parent || absolute.startsWith(parent + sep);
}
function slash(value) {
	return value.replaceAll("\\", "/");
}
function uniqueBy(values, key) {
	const result = /* @__PURE__ */ new Map();
	for (const value of values) if (!result.has(key(value))) result.set(key(value), value);
	return [...result.values()];
}
function compareCrossFaceLinks(left, right) {
	return left.fromFace.localeCompare(right.fromFace) || left.fromPackage.localeCompare(right.fromPackage) || left.toFace.localeCompare(right.toFace) || left.toPackage.localeCompare(right.toPackage) || left.subpath.localeCompare(right.subpath) || left.name.localeCompare(right.name);
}
//#endregion
//#region lib/types/model.js
/**
* Compiler-independent Typert analysis model. TypeScript nodes and checker
* objects are extraction inputs only; emitters consume this graph.
* @module @deepseek-ai/dsh-typert-generator/model
*/
/**
* Return the direct type-expression edges owned by one node.
* @param node - compiler-independent type node to inspect.
* @returns graph-local ids of its direct child type nodes.
*/
function childTypeNodeIds(node) {
	switch (node.kind) {
		case "parenthesized":
		case "operator": return [node.type];
		case "reference": return [...node.arguments];
		case "union":
		case "intersection": return [...node.types];
		case "array": return [node.element];
		case "tuple": return node.elements.map((element) => element.type);
		case "indexed-access": return [node.object, node.index];
		case "conditional": return [
			node.check,
			node.extends,
			node.whenTrue,
			node.whenFalse
		];
		case "mapped": return [
			...node.parameter.constraint === void 0 ? [] : [node.parameter.constraint],
			...node.parameter.default === void 0 ? [] : [node.parameter.default],
			...node.nameType === void 0 ? [] : [node.nameType],
			...node.value === void 0 ? [] : [node.value]
		];
		case "template-literal": return node.spans.map((span) => span.type);
		case "type-query":
		case "import-type": return [...node.arguments];
		case "predicate": return node.type === void 0 ? [] : [node.type];
		case "infer": return [...node.parameter.constraint === void 0 ? [] : [node.parameter.constraint], ...node.parameter.default === void 0 ? [] : [node.parameter.default]];
		case "keyword":
		case "literal":
		case "object":
		case "function":
		case "constructor":
		case "this": return [];
		default: return assertNever$1(node);
	}
}
function assertNever$1(value) {
	throw new Error(`unsupported model variant ${JSON.stringify(value)}`);
}
//#endregion
//#region lib/types/renderer.js
/**
* Rendering and traversal over the compiler-independent TypeGraph. Emitters
* use this module instead of reaching back into TypeScript AST nodes.
* @module @deepseek-ai/dsh-typert-generator/renderer
*/
/** Failure to render or traverse an internally inconsistent TypeGraph. */
var TypeGraphRenderError = class extends Error {
	name = "TypeGraphRenderError";
};
/** Read and render one TypeGraph without compiler objects. */
var TypeGraphRenderer = class {
	graph;
	nodes;
	declarations;
	members;
	parameterNames = /* @__PURE__ */ new Map();
	/**
	* Index one complete graph.
	* @param graph - compiler-independent graph to render.
	*/
	constructor(graph) {
		this.graph = graph;
		this.nodes = new Map(graph.nodes.map((node) => [node.id, node]));
		this.declarations = new Map(graph.declarations.map((declaration) => [declaration.id, declaration]));
		this.members = new Map(graph.declarations.flatMap((declaration) => declaration.members.map((member) => [member.id, member])));
		for (const declaration of graph.declarations) {
			this.indexParameters(declaration.typeParameters);
			for (const member of declaration.members) if ("signature" in member) this.indexParameters(member.signature.typeParameters);
		}
	}
	/**
	* Resolve a node id or fail with the broken edge.
	* @param id - graph-local type node id.
	* @returns the referenced node.
	*/
	node(id) {
		const node = this.nodes.get(id);
		if (node === void 0) throw new TypeGraphRenderError(`type graph references missing node ${id}`);
		return node;
	}
	/**
	* Resolve a declaration id or fail with the broken edge.
	* @param id - workspace symbol id.
	* @returns the referenced declaration.
	*/
	declaration(id) {
		const declaration = this.declarations.get(id);
		if (declaration === void 0) throw new TypeGraphRenderError(`type graph references missing declaration ${id}`);
		return declaration;
	}
	/**
	* Resolve a public member id.
	* @param id - declaration member id.
	* @returns the referenced member.
	*/
	member(id) {
		const member = this.members.get(id);
		if (member === void 0) throw new TypeGraphRenderError(`type graph references missing member ${id}`);
		return member;
	}
	/**
	* Render one type expression from the retained source structure.
	* @param id - type node id.
	* @param references - optional generated names for declaration references.
	* @returns TypeScript type text.
	*/
	renderType(id, references) {
		const node = this.node(id);
		switch (node.kind) {
			case "keyword": return node.name;
			case "literal": return node.text;
			case "parenthesized": return `(${this.renderType(node.type, references)})`;
			case "reference": {
				const name = node.target.kind === "type-parameter" ? this.parameterNames.get(node.target.parameter) ?? node.name : node.target.kind === "declaration" ? references?.get(node.target.symbol) ?? node.name : node.name;
				return node.arguments.length === 0 ? name : `${name}<${node.arguments.map((argument) => this.renderType(argument, references)).join(", ")}>`;
			}
			case "union": return node.types.map((type) => this.renderType(type, references)).join(" | ");
			case "intersection": return node.types.map((type) => this.renderType(type, references)).join(" & ");
			case "array": {
				const element = this.renderType(node.element, references);
				return `${needsArrayParentheses(this.node(node.element)) ? `(${element})` : element}[]`;
			}
			case "tuple": return `[${node.elements.map((element) => {
				const type = this.renderType(element.type, references);
				if (element.name !== void 0) return `${element.rest ? "..." : ""}${element.name}${element.optional ? "?" : ""}: ${type}`;
				return `${element.rest ? "..." : ""}${type}${element.optional ? "?" : ""}`;
			}).join(", ")}]`;
			case "object": return this.renderObject(node.members, references);
			case "function": return `${this.renderSignatureHead(node.signature, references)} => ${this.renderType(node.signature.returns, references)}`;
			case "constructor": return `${node.abstract ? "abstract " : ""}new ${this.renderSignatureHead(node.signature, references)} => ${this.renderType(node.signature.returns, references)}`;
			case "indexed-access": return `${this.renderType(node.object, references)}[${this.renderType(node.index, references)}]`;
			case "operator": return `${node.operator} ${this.renderType(node.type, references)}`;
			case "conditional": return `${this.renderType(node.check, references)} extends ${this.renderType(node.extends, references)} ? ${this.renderType(node.whenTrue, references)} : ${this.renderType(node.whenFalse, references)}`;
			case "infer": return `infer ${this.renderTypeParameter(node.parameter, false, references)}`;
			case "mapped": {
				const readonly = node.readonly === "preserve" ? "" : node.readonly === "remove" ? "-readonly " : "readonly ";
				const optional = node.optional === "preserve" ? "" : node.optional === "remove" ? "-?" : "?";
				if (node.parameter.constraint === void 0) throw new TypeGraphRenderError(`mapped type parameter ${node.parameter.name} has no constraint`);
				return `{ ${readonly}[${`${node.parameter.name} in ${this.renderType(node.parameter.constraint, references)}`}${node.nameType === void 0 ? "" : ` as ${this.renderType(node.nameType, references)}`}]${optional}: ${node.value === void 0 ? "unknown" : this.renderType(node.value, references)} }`;
			}
			case "template-literal": {
				const spans = node.spans.map((span) => `\${${this.renderType(span.type, references)}}${escapeTemplate(span.text)}`).join("");
				return `\`${escapeTemplate(node.head)}${spans}\``;
			}
			case "type-query": {
				const argumentsText = node.arguments.length === 0 ? "" : `<${node.arguments.map((argument) => this.renderType(argument, references)).join(", ")}>`;
				return `typeof ${node.expression}${argumentsText}`;
			}
			case "import-type": {
				const attributes = node.attributes === void 0 ? "" : `, ${node.attributes}`;
				const imported = `import(${quote$2(node.module)}${attributes})${node.qualifier === void 0 ? "" : `.${node.qualifier}`}`;
				const argumentsText = node.arguments.length === 0 ? "" : `<${node.arguments.map((argument) => this.renderType(argument, references)).join(", ")}>`;
				return `${node.typeof ? "typeof " : ""}${imported}${argumentsText}`;
			}
			case "predicate": {
				const assertion = node.asserts ? "asserts " : "";
				return node.type === void 0 ? `${assertion}${node.parameter}` : `${assertion}${node.parameter} is ${this.renderType(node.type, references)}`;
			}
			case "this": return "this";
			default: return assertNever(node);
		}
	}
	/**
	* Render a callable signature without a member name.
	* @param signature - modeled signature.
	* @param references - optional generated names for declaration references.
	* @returns parameter list and return type.
	*/
	renderSignature(signature, references) {
		return `${this.renderSignatureHead(signature, references)}: ${this.renderType(signature.returns, references)}`;
	}
	/**
	* Render one class/interface member as a body-free declaration.
	* @param member - modeled member.
	* @param sourceModifiers - retain source-only modifiers for reflection text.
	* @param references - optional generated names for declaration references.
	* @returns one-line TypeScript member text.
	*/
	renderMember(member, sourceModifiers = false, references) {
		if (sourceModifiers) return member.text;
		const name = renderPropertyName(member.name);
		const optional = member.optional ? "?" : "";
		const readonly = member.readonly ? "readonly " : "";
		const abstract = member.abstract ? "abstract " : "";
		switch (member.kind) {
			case "property": return `${abstract}${readonly}${name}${optional}: ${this.renderType(member.type, references)}`;
			case "method": return `${abstract}${name}${optional}${this.renderSignature(member.signature, references)}`;
			case "getter": return `${abstract}get ${name}()${this.renderReturn(member.signature, references)}`;
			case "setter": return `${abstract}set ${name}${this.renderSignatureHead(member.signature, references)}`;
			case "call": return this.renderSignature(member.signature, references);
			case "construct": return `new ${this.renderSignature(member.signature, references)}`;
			case "index": return `${readonly}[${member.signature.parameters.map((parameter) => this.renderParameter(parameter, references)).join(", ")}]: ${this.renderType(member.signature.returns, references)}`;
			default: return assertNever(member);
		}
	}
	/**
	* Render a named declaration without JSDoc.
	* @param id - declaration symbol id.
	* @returns exported TypeScript declaration text.
	*/
	renderDeclaration(id) {
		const declaration = this.declaration(id);
		const parameters = this.renderTypeParameters(declaration.typeParameters);
		if (declaration.kind === "enum") {
			const members = declaration.enumMembers?.map((member) => `    ${renderPropertyName(member.name)}${member.initializer === void 0 ? "" : ` = ${member.initializer}`},`) ?? [];
			return [
				`export enum ${declaration.name} {`,
				...members,
				"}"
			].join("\n");
		}
		if (declaration.kind === "alias") {
			if (declaration.type === void 0) throw new TypeGraphRenderError(`alias ${id} has no type node`);
			return `export type ${declaration.name}${parameters} = ${this.renderType(declaration.type)};`;
		}
		const extendsTypes = declaration.extends.map((type) => this.renderType(type));
		const implementsTypes = declaration.implements.map((type) => this.renderType(type));
		const heritage = [extendsTypes.length === 0 ? "" : ` extends ${extendsTypes.join(", ")}`, implementsTypes.length === 0 ? "" : ` implements ${implementsTypes.join(", ")}`].join("");
		const prefix = declaration.kind === "class" && declaration.abstract ? "abstract " : "";
		const members = declaration.members.map((member) => `    ${this.renderMember(member)};`);
		return [
			`export ${prefix}${declaration.kind} ${declaration.name}${parameters}${heritage} {`,
			...members,
			"}"
		].join("\n");
	}
	/**
	* Find the transitive declaration closure referenced by members.
	* @param memberIds - business-API member ids.
	* @returns declarations in graph order, excluding no roots implicitly.
	*/
	declarationClosureForMembers(memberIds) {
		return this.declarationClosure(memberIds, []);
	}
	/**
	* Find the transitive declaration closure referenced by type roots.
	* @param typeIds - graph type roots.
	* @returns declarations in graph order.
	*/
	declarationClosureForTypes(typeIds) {
		return this.declarationClosure([], typeIds);
	}
	declarationClosure(memberIds, typeIds) {
		const found = /* @__PURE__ */ new Set();
		const visiting = /* @__PURE__ */ new Set();
		const visitNode = (id) => {
			const node = this.node(id);
			if (node.kind === "reference" && node.target.kind === "declaration") visitDeclaration(node.target.symbol);
			if (node.kind === "import-type" && node.target?.kind === "declaration") visitDeclaration(node.target.symbol);
			for (const child of childTypeNodeIds(node)) visitNode(child);
			for (const signature of nodeSignatures(node)) visitSignature(signature);
			if (node.kind === "object") for (const member of node.members) visitMember(member);
		};
		const visitSignature = (signature) => {
			for (const parameter of signature.typeParameters) {
				if (parameter.constraint !== void 0) visitNode(parameter.constraint);
				if (parameter.default !== void 0) visitNode(parameter.default);
			}
			for (const parameter of signature.parameters) visitNode(parameter.type);
			visitNode(signature.returns);
		};
		const visitMember = (member) => {
			if (member.kind === "property") visitNode(member.type);
			else visitSignature(member.signature);
		};
		const visitDeclaration = (id) => {
			if (found.has(id) || visiting.has(id)) return;
			visiting.add(id);
			const declaration = this.declaration(id);
			for (const parameter of declaration.typeParameters) {
				if (parameter.constraint !== void 0) visitNode(parameter.constraint);
				if (parameter.default !== void 0) visitNode(parameter.default);
			}
			for (const type of [...declaration.extends, ...declaration.implements]) visitNode(type);
			if (declaration.type !== void 0) visitNode(declaration.type);
			for (const member of declaration.members) visitMember(member);
			visiting.delete(id);
			found.add(id);
		};
		for (const id of memberIds) visitMember(this.member(id));
		for (const id of typeIds) visitNode(id);
		return this.graph.declarations.filter((declaration) => found.has(declaration.id));
	}
	renderSignatureHead(signature, references) {
		return `${this.renderTypeParameters(signature.typeParameters, references)}(${signature.parameters.map((parameter) => this.renderParameter(parameter, references)).join(", ")})`;
	}
	renderReturn(signature, references) {
		return `: ${this.renderType(signature.returns, references)}`;
	}
	renderParameter(parameter, references) {
		const name = parameter.binding === "identifier" ? renderPropertyName(parameter.name) : parameter.name;
		const optional = parameter.initializer === void 0 && parameter.optional && !parameter.rest ? "?" : "";
		const initializer = parameter.initializer === void 0 ? "" : ` = ${parameter.initializer}`;
		return `${parameter.rest ? "..." : ""}${name}${optional}: ${this.renderType(parameter.type, references)}${initializer}`;
	}
	renderTypeParameters(parameters, references) {
		return parameters.length === 0 ? "" : `<${parameters.map((parameter) => this.renderTypeParameter(parameter, true, references)).join(", ")}>`;
	}
	renderTypeParameter(parameter, includeDefault, references) {
		const variance = parameter.variance === void 0 ? "" : `${parameter.variance === "in-out" ? "in out" : parameter.variance} `;
		const constModifier = parameter.const ? "const " : "";
		const constraint = parameter.constraint === void 0 ? "" : ` extends ${this.renderType(parameter.constraint, references)}`;
		const fallback = !includeDefault || parameter.default === void 0 ? "" : ` = ${this.renderType(parameter.default, references)}`;
		return `${constModifier}${variance}${parameter.name}${constraint}${fallback}`;
	}
	renderObject(members, references) {
		if (members.length === 0) return "{}";
		return `{ ${members.map((member) => `${this.renderMember(member, false, references)};`).join(" ")} }`;
	}
	indexParameters(parameters) {
		for (const parameter of parameters) this.parameterNames.set(parameter.id, parameter.name);
	}
};
function nodeSignatures(node) {
	return node.kind === "function" || node.kind === "constructor" ? [node.signature] : [];
}
function needsArrayParentheses(node) {
	return node.kind === "union" || node.kind === "intersection" || node.kind === "function" || node.kind === "constructor" || node.kind === "conditional";
}
function renderPropertyName(name) {
	if (name.startsWith("[") && name.endsWith("]")) return name;
	if (/^(?:[$A-Z_a-z][$\w]*|\d+)$/u.test(name)) return name;
	return quote$2(name);
}
function quote$2(value) {
	return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n")}'`;
}
function escapeTemplate(value) {
	return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${");
}
function assertNever(value) {
	throw new TypeGraphRenderError(`unsupported model variant ${JSON.stringify(value)}`);
}
//#endregion
//#region lib/types/emitter.js
/**
* Model-driven Typert artifact emitter. It consumes only FaceModel and
* TypeGraph data; TypeScript compiler nodes are not part of this boundary.
* @module @deepseek-ai/dsh-typert-generator/emitter
*/
/** Failure to project a modeled construct into an emitted artifact. */
var TypertEmitError = class extends Error {
	name = "TypertEmitError";
};
/** Emit generated runtime and type artifacts from one independently analyzed face. */
var FaceModelEmitter = class {
	face;
	renderer;
	/**
	* Create an emitter for one face graph.
	* @param face - independently analyzed face.
	*/
	constructor(face) {
		this.face = face;
		this.renderer = new TypeGraphRenderer(face.graph);
	}
	/**
	* Emit one modeled package.
	* @param packageName - exact package name in the face model.
	* @returns executable JavaScript and its precise declaration file.
	*/
	emit(packageName) {
		const packageModel = this.face.packages.find((candidate) => candidate.name === packageName);
		if (packageModel === void 0) throw new TypertEmitError(`typert emitter(${this.face.face}): package ${packageName} is not modeled on this face`);
		const schemaArtifact = new SchemaEmitter(this.renderer, packageModel.schemas, invocationBoundaryRoots(packageModel.invocations)).emit();
		const runtimeModel = this.runtimeModel(packageModel);
		const js = this.renderJs(packageModel, schemaArtifact, runtimeModel);
		const dts = this.renderDts(packageModel, schemaArtifact);
		return {
			package: packageName,
			face: this.face.face,
			exports: packageModel.schemas.map((schema) => schema.export.name),
			js,
			dts,
			...this.face.face === "host" && packageModel.invocations.length > 0 ? { remote: this.emitRemote(packageModel) } : {}
		};
	}
	runtimeModel(packageModel) {
		return {
			services: packageModel.services.map((service) => {
				const members = service.members.map((id) => this.runtimeMember(this.renderer.member(id)));
				return {
					...documentationLiteral(service),
					key: service.key,
					exportName: service.export.name,
					members,
					types: this.runtimeTypes(this.renderer.declarationClosureForMembers(service.members), service.symbol)
				};
			}),
			events: packageModel.events.map((event) => {
				const node = this.renderer.node(event.signature);
				if (node.kind !== "function") throw new TypertEmitError(`typert emitter(${this.face.face}): event ${event.name} is not a function type`);
				return {
					...documentationLiteral(event),
					name: event.name,
					...event.mode === void 0 ? {} : { mode: event.mode },
					signature: `${quote$1(event.name)}${this.renderer.renderSignature(node.signature)}`
				};
			}),
			objects: packageModel.objects.map((object) => {
				const declaration = this.renderer.declaration(object.symbol);
				return {
					...documentationLiteral(object),
					name: declaration.name,
					exportName: object.export.name,
					members: declaration.members.map((member) => this.runtimeMember(member)),
					types: this.runtimeTypes(this.renderer.declarationClosureForMembers(declaration.members.map((member) => member.id)), declaration.id)
				};
			})
		};
	}
	runtimeMember(member) {
		return {
			kind: member.kind,
			name: member.name,
			signature: this.renderer.renderMember(member, true),
			...member.summary === void 0 ? {} : { summary: member.summary },
			...member.jsDoc === void 0 ? {} : { jsDoc: member.jsDoc }
		};
	}
	runtimeTypes(declarations, root) {
		return declarations.filter((declaration) => declaration.id !== root).map((declaration) => ({
			name: declaration.name,
			declaration: this.renderer.renderDeclaration(declaration.id)
		})).sort((left, right) => left.name.localeCompare(right.name));
	}
	renderJs(packageModel, schemas, runtimeModel) {
		const lines = ["/* Generated by @deepseek-ai/dsh-typert-generator from FaceModel — do not edit. */"];
		if (schemas.definitions.length > 0) lines.push("import { z } from 'zod'", "");
		lines.push(...schemas.definitions);
		if (schemas.definitions.length > 0) lines.push("");
		for (const schema of schemas.exports) lines.push(`export const ${schema.exportName} = ${schema.internalName}`);
		if (schemas.exports.length > 0) lines.push("");
		const model = JSON.stringify(runtimeModel, null, 2);
		lines.push("export const TYPERT = {");
		lines.push(`  package: ${quote$1(packageModel.name)},`);
		lines.push(`  face: ${quote$1(this.face.face)},`);
		lines.push("  schemas: [");
		for (const schema of schemas.exports) lines.push(`    { name: ${quote$1(schema.exportName)}, schema: ${schema.exportName} },`);
		lines.push("  ],");
		lines.push("  invocations: [");
		for (const invocation of packageModel.invocations) lines.push(`${indent(this.invocationLiteral(invocation, schemas), 4)},`);
		lines.push("  ],");
		lines.push(`  model: ${indent(model, 2).trimStart()},`);
		lines.push("}");
		return `${lines.join("\n")}\n`;
	}
	renderDts(packageModel, schemas) {
		const imports = /* @__PURE__ */ new Map();
		for (const schema of schemas.exports) {
			const specifier = packageExportSpecifier(packageModel.name, schema.model.export.subpath);
			const names = imports.get(specifier) ?? [];
			names.push(`${schema.model.export.name} as ${schema.exportName}$source`);
			imports.set(specifier, names);
		}
		const lines = ["/* Generated by @deepseek-ai/dsh-typert-generator from FaceModel — do not edit. */"];
		if (schemas.exports.length > 0) lines.splice(1, 0, "import type { z } from 'zod'");
		for (const [specifier, names] of [...imports].sort(([left], [right]) => left.localeCompare(right))) lines.push(`import type { ${names.sort().join(", ")} } from ${quote$1(specifier)}`);
		lines.push("");
		for (const schema of schemas.exports) lines.push(`export declare const ${schema.exportName}: z.ZodType<${schema.exportName}$source>`);
		if (schemas.exports.length > 0) lines.push("");
		lines.push("export declare const TYPERT: unknown");
		return `${lines.join("\n")}\n`;
	}
	emitRemote(packageModel) {
		const schemas = new SchemaEmitter(this.renderer, [], invocationBoundaryRoots(packageModel.invocations)).emit();
		const lines = ["/* Generated by @deepseek-ai/dsh-typert-generator from the Host FaceModel — do not edit. */"];
		if (schemas.definitions.length > 0) lines.push("import { z } from 'zod'", "");
		lines.push(...schemas.definitions);
		if (schemas.definitions.length > 0) lines.push("");
		lines.push("export const TYPERT_REMOTE = {");
		lines.push(`  package: ${quote$1(packageModel.name)},`);
		lines.push("  descriptors: [");
		for (const invocation of packageModel.invocations) lines.push(`${indent(this.invocationLiteral(invocation, schemas), 4)},`);
		lines.push("  ],");
		lines.push("}");
		lines.push("");
		lines.push("export default TYPERT_REMOTE");
		const declaration = this.renderRemoteDts(packageModel);
		return {
			js: `${lines.join("\n")}\n`,
			...declaration
		};
	}
	invocationLiteral(invocation, schemas) {
		const lines = [
			"{",
			`  id: ${quote$1(invocation.id)},`,
			`  service: ${quote$1(invocation.service)},`,
			`  namespace: ${quote$1(invocation.namespace)},`,
			`  method: ${quote$1(invocation.method)},`
		];
		if (invocation.implementation !== void 0) lines.push(`  implementation: ${quote$1(invocation.implementation)},`);
		if (invocation.mode !== void 0) lines.push(`  mode: ${quote$1(invocation.mode)},`);
		if (invocation.invocation.kind === "direct") lines.push("  invocation: { kind: 'direct' },");
		else {
			lines.push("  invocation: {");
			lines.push("    kind: 'context',");
			lines.push(`    context: ${quote$1(invocation.invocation.context)},`);
			lines.push(`    wire: ${quote$1(invocation.invocation.wire)},`);
			lines.push(`    codec: ${indent(strictCodec(invocation.invocation.boundary, schemas.boundary(contextBoundaryKey(invocation))), 4).trimStart()},`);
			lines.push("  },");
		}
		if (invocation.scope !== void 0) {
			lines.push("  scope: {");
			lines.push(`    context: ${quote$1(invocation.scope.context)},`);
			lines.push(`    wire: ${quote$1(invocation.scope.wire)},`);
			lines.push("  },");
		}
		lines.push("  parameters: [");
		invocation.parameters.forEach((parameter, index) => {
			lines.push("    {");
			lines.push(`      name: ${quote$1(parameter.name)},`);
			lines.push(`      wire: ${quote$1(parameter.wire)},`);
			lines.push(`      source: ${quote$1(parameter.source)},`);
			if (parameter.lookup !== void 0) lines.push(`      lookup: ${quote$1(parameter.lookup)},`);
			if (parameter.boundary.acceptsUndefined) lines.push("      acceptsUndefined: true,");
			lines.push(`      codec: ${indent(strictCodec(parameter.boundary, schemas.boundary(parameterBoundaryKey(invocation, index))), 6).trimStart()},`);
			lines.push("    },");
		});
		lines.push("  ],");
		if (invocation.cancellation !== void 0) lines.push("  cancellation: { parameter: 'signal' },");
		lines.push(`  result: ${indent(strictCodec(invocation.result, schemas.boundary(resultBoundaryKey(invocation))), 2).trimStart()},`);
		lines.push(`  sourceLocation: ${JSON.stringify(invocation.location)},`);
		lines.push("}");
		return lines.join("\n");
	}
	renderRemoteDts(packageModel) {
		const imports = remoteImports(packageModel.invocations);
		const referenceNames = allocateRemoteImportNames(imports);
		const grouped = /* @__PURE__ */ new Map();
		for (const imported of imports) {
			const values = grouped.get(imported.specifier) ?? [];
			values.push({
				name: imported.name,
				local: referenceNames.get(imported.symbol)
			});
			grouped.set(imported.specifier, values);
		}
		const lines = [
			"/* Generated by @deepseek-ai/dsh-typert-generator from the Host FaceModel — do not edit. */",
			"import type {",
			"  RemoteResult,",
			"  TypertRemoteContribution,",
			"} from '@deepseek-ai/dsh-typert-protocol'"
		];
		const sourceMap = new GenMapping({ file: "typert.remote-client.d.ts" });
		for (const [specifier, values] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
			const names = values.sort((left, right) => left.local.localeCompare(right.local)).map((value) => value.name === value.local ? value.name : `${value.name} as ${value.local}`);
			lines.push(`import type { ${names.join(", ")} } from ${quote$1(specifier)}`);
		}
		lines.push("");
		lines.push("declare module '@deepseek-ai/dsh-typert-protocol' {");
		const direct = packageModel.invocations.filter((invocation) => invocation.invocation.kind === "direct");
		const scoped = packageModel.invocations.filter((invocation) => invocation.invocation.kind === "context" || invocation.scope !== void 0);
		if (direct.length > 0) {
			for (const namespace of uniqueNamespaces(direct)) {
				lines.push(`  interface ${remoteNamespaceInterface(namespace)} {`);
				for (const invocation of direct.filter((candidate) => candidate.namespace === namespace)) this.pushRemoteNamespaceSignature(lines, sourceMap, packageModel, invocation, referenceNames);
				lines.push("  }");
			}
			lines.push("  interface TypertRemoteMap {");
			for (const invocation of direct) this.pushRemoteSignature(lines, sourceMap, packageModel, invocation, referenceNames, false);
			lines.push("  }");
			lines.push("  interface TypertRemoteNamespaceMap {");
			for (const namespace of uniqueNamespaces(direct)) lines.push(`    ${quote$1(namespace)}: ${remoteNamespaceInterface(namespace)}`);
			lines.push("  }");
		}
		if (scoped.length > 0) {
			lines.push("  interface TypertRemoteScopeMap {");
			for (const invocation of scoped) this.pushRemoteSignature(lines, sourceMap, packageModel, invocation, referenceNames, true);
			lines.push("  }");
		}
		lines.push("}");
		lines.push("");
		lines.push("export declare const TYPERT_REMOTE: TypertRemoteContribution");
		lines.push("export default TYPERT_REMOTE");
		lines.push("//# sourceMappingURL=typert.remote-client.d.ts.map");
		return {
			dts: `${lines.join("\n")}\n`,
			dtsMap: `${JSON.stringify(toEncodedMap(sourceMap))}\n`
		};
	}
	pushRemoteSignature(lines, sourceMap, packageModel, invocation, referenceNames, scoped) {
		const signature = this.remoteSignature(invocation, referenceNames, scoped);
		const keyLength = signature.indexOf(": (");
		if (keyLength < 0) throw new TypertEmitError(`Remote signature ${invocation.id} has no property delimiter`);
		this.pushMappedRemoteSignature(lines, sourceMap, packageModel, invocation, signature, keyLength);
	}
	pushRemoteNamespaceSignature(lines, sourceMap, packageModel, invocation, referenceNames) {
		const key = renderRemotePropertyName(invocation.method);
		const signature = `${key}: ${this.remoteFunctionType(invocation, referenceNames, false)}`;
		this.pushMappedRemoteSignature(lines, sourceMap, packageModel, invocation, signature, key.length);
	}
	pushMappedRemoteSignature(lines, sourceMap, packageModel, invocation, signature, keyLength) {
		lines.push(`    ${signature}`);
		const generatedLine = lines.length;
		const source = remoteDeclarationSource(packageModel, invocation);
		addMapping(sourceMap, {
			generated: {
				line: generatedLine,
				column: 4
			},
			source,
			original: {
				line: invocation.location.line,
				column: invocation.location.column - 1
			},
			name: invocation.method
		});
		addMapping(sourceMap, { generated: {
			line: generatedLine,
			column: 4 + keyLength
		} });
	}
	remoteSignature(invocation, referenceNames, scoped) {
		const context = invocation.invocation.kind === "context" ? invocation.invocation.context : invocation.scope?.context;
		return `${quote$1(scoped ? `${context}:${invocation.namespace}/${invocation.method}` : `${invocation.namespace}/${invocation.method}`)}: ${this.remoteFunctionType(invocation, referenceNames, scoped)}`;
	}
	remoteFunctionType(invocation, referenceNames, scoped) {
		const parameters = invocation.parameters.filter((parameter) => !scoped || invocation.invocation.kind === "context" || parameter.wire !== invocation.scope?.wire).map((parameter) => `${safeIdentifier(parameter.wire)}${parameter.optional === true ? "?" : ""}: ${this.renderer.renderType(parameter.boundary.type, referenceNames)}`);
		if (invocation.cancellation !== void 0) parameters.push("signal?: AbortSignal");
		const result = this.renderer.renderType(invocation.result.type, referenceNames);
		if (invocation.mode === "stream") return `(${parameters.join(", ")}) => AsyncIterable<${result}>`;
		return `(${parameters.join(", ")}) => Promise<RemoteResult<${result}>>`;
	}
};
function remoteDeclarationSource(packageModel, invocation) {
	const relativeSource = posix.relative(packageModel.root, invocation.location.file);
	if (relativeSource === "" || relativeSource === ".." || relativeSource.startsWith("../") || posix.isAbsolute(relativeSource)) throw new TypertEmitError(`Remote declaration ${invocation.id} is outside its package root ${packageModel.root}`);
	return posix.join("..", relativeSource);
}
function uniqueNamespaces(invocations) {
	return [...new Set(invocations.map((invocation) => invocation.namespace))].sort();
}
function remoteNamespaceInterface(namespace) {
	return `TypertRemoteNamespace$${Buffer.from(namespace, "utf8").toString("hex")}`;
}
var SchemaEmitter = class {
	renderer;
	schemas;
	boundaries;
	names = /* @__PURE__ */ new Map();
	boundaryNames = /* @__PURE__ */ new Map();
	declarations;
	constructor(renderer, schemas, boundaries) {
		this.renderer = renderer;
		this.schemas = schemas;
		this.boundaries = boundaries;
		const declarations = /* @__PURE__ */ new Map();
		for (const schema of schemas) for (const declaration of renderer.declarationClosureForTypes([schema.type])) declarations.set(declaration.id, declaration);
		for (const boundary of boundaries) for (const declaration of renderer.declarationClosureForTypes([boundary.type])) declarations.set(declaration.id, declaration);
		this.declarations = renderer.graph.declarations.filter((declaration) => declarations.has(declaration.id));
		const identifiers = /* @__PURE__ */ new Set();
		for (const declaration of this.declarations) {
			const base = `${safeIdentifier(declaration.name)}$schema`;
			let name = base;
			let suffix = 2;
			while (identifiers.has(name)) name = `${base}${String(suffix++)}`;
			identifiers.add(name);
			this.names.set(declaration.id, name);
		}
		for (const boundary of boundaries) {
			const base = `${safeIdentifier(boundary.key)}$schema`;
			let name = base;
			let suffix = 2;
			while (identifiers.has(name)) name = `${base}${String(suffix++)}`;
			identifiers.add(name);
			this.boundaryNames.set(boundary.key, name);
		}
	}
	emit() {
		const definitions = this.declarations.map((declaration) => this.declarationDefinition(declaration));
		for (const boundary of this.boundaries) definitions.push(`const ${this.boundaryName(boundary.key)} = ${this.typeSchema(boundary.type)}`);
		return {
			definitions,
			exports: this.schemas.map((model) => ({
				model,
				exportName: safeIdentifier(model.export.name),
				internalName: this.exportSchemaName(model)
			})),
			boundary: (key) => this.boundaryName(key)
		};
	}
	declarationDefinition(declaration) {
		const name = this.schemaName(declaration.id);
		if (declaration.typeParameters.length === 0) return `const ${name} = ${this.declarationSchema(declaration, /* @__PURE__ */ new Map())}`;
		const parameters = declaration.typeParameters.map((parameter, index) => [`type${String(index)}$schema`, parameter.id]);
		const substitutions = new Map(parameters.map(([schema, id]) => [id, schema]));
		return `const ${name} = (${parameters.map(([schema]) => schema).join(", ")}) => ${this.declarationSchema(declaration, substitutions)}`;
	}
	declarationSchema(declaration, substitutions) {
		if (declaration.kind === "enum") this.fail(declaration.name, "enum declarations have no Zod projection");
		if (declaration.kind === "alias") {
			if (declaration.type === void 0) this.fail(declaration.name, "alias has no modeled type");
			return this.describe(this.typeSchema(declaration.type, substitutions), declaration);
		}
		let result = this.objectSchema(declaration.members, declaration.name, substitutions);
		for (const heritage of declaration.extends) result = `z.intersection(${this.typeSchema(heritage, substitutions)}, ${result})`;
		return this.describe(result, declaration);
	}
	typeSchema(id, substitutions = /* @__PURE__ */ new Map()) {
		const node = this.renderer.node(id);
		switch (node.kind) {
			case "keyword": return this.keywordSchema(node.name);
			case "literal": return `z.literal(${node.text})`;
			case "parenthesized": return this.typeSchema(node.type, substitutions);
			case "reference": return this.referenceSchema(node, substitutions);
			case "union":
				if (node.types.length === 0) return "z.never()";
				if (node.types.length === 1) return this.typeSchema(node.types[0], substitutions);
				return `z.union([${node.types.map((type) => this.typeSchema(type, substitutions)).join(", ")}])`;
			case "intersection": {
				const [head, ...tail] = node.types;
				if (head === void 0) return "z.unknown()";
				return tail.reduce((left, right) => `z.intersection(${left}, ${this.typeSchema(right, substitutions)})`, this.typeSchema(head, substitutions));
			}
			case "array": return `z.array(${this.typeSchema(node.element, substitutions)})`;
			case "tuple": {
				const fixed = node.elements.filter((element) => !element.rest);
				const rest = node.elements.find((element) => element.rest);
				let schema = `z.tuple([${fixed.map((element) => this.optional(this.typeSchema(element.type, substitutions), element.optional)).join(", ")}])`;
				if (rest !== void 0) schema += `.rest(${this.tupleRestSchema(rest.type, substitutions)})`;
				return schema;
			}
			case "object": return this.objectSchema(node.members, id, substitutions);
			case "operator":
			case "indexed-access":
			case "conditional":
			case "infer":
			case "mapped":
			case "template-literal":
			case "type-query":
			case "import-type":
			case "predicate":
			case "function":
			case "constructor":
			case "this": return this.unsupported(node);
		}
	}
	referenceSchema(node, substitutions) {
		if (node.target.kind === "declaration") {
			const name = this.schemaName(node.target.symbol);
			const declaration = this.renderer.declaration(node.target.symbol);
			if (declaration.typeParameters.length === 0) {
				if (node.arguments.length > 0) this.fail(node.name, `non-generic declaration received ${String(node.arguments.length)} type arguments`);
				return `z.lazy(() => ${name})`;
			}
			return `z.lazy(() => ${name}(${this.declarationArguments(node, declaration, substitutions).join(", ")}))`;
		}
		if (node.target.kind === "type-parameter") {
			if (node.arguments.length > 0) this.fail(node.name, "type parameter reference cannot receive type arguments");
			const schema = substitutions.get(node.target.parameter);
			if (schema === void 0) this.fail(node.name, "type parameter has no schema substitution");
			return schema;
		}
		if (node.target.kind === "standard") switch (node.target.name) {
			case "Array":
			case "ReadonlyArray": {
				const element = node.arguments[0];
				if (element === void 0) this.fail(node.name, "array reference has no element type");
				return this.readonly(`z.array(${this.typeSchema(element, substitutions)})`, node.target.name === "ReadonlyArray");
			}
			case "Record": {
				const key = node.arguments[0];
				const value = node.arguments[1];
				if (key === void 0 || value === void 0) this.fail(node.name, "Record requires key and value types");
				return `z.record(${this.typeSchema(key, substitutions)}, ${this.typeSchema(value, substitutions)})`;
			}
			case "Date": return "z.date()";
			default: this.fail(node.name, `standard type ${node.target.name} has no Zod projection`);
		}
		this.fail(node.name, `${node.target.kind} reference has no Zod projection`);
	}
	declarationArguments(node, declaration, substitutions) {
		if (node.arguments.length > declaration.typeParameters.length) this.fail(node.name, `generic declaration accepts ${String(declaration.typeParameters.length)} type arguments but received ${String(node.arguments.length)}`);
		const resolved = new Map(substitutions);
		const arguments_ = [];
		for (const [index, parameter] of declaration.typeParameters.entries()) {
			const argument = node.arguments[index];
			const schema = argument === void 0 ? parameter.default === void 0 ? this.fail(node.name, `missing type argument ${parameter.name}`) : this.typeSchema(parameter.default, resolved) : this.typeSchema(argument, substitutions);
			arguments_.push(schema);
			resolved.set(parameter.id, schema);
		}
		return arguments_;
	}
	tupleRestSchema(id, substitutions) {
		const node = this.renderer.node(id);
		if (node.kind === "array") return this.typeSchema(node.element, substitutions);
		if (node.kind === "reference" && node.target.kind === "standard" && (node.target.name === "Array" || node.target.name === "ReadonlyArray")) {
			const element = node.arguments[0];
			if (element === void 0) this.fail(node.name, "tuple rest array has no element type");
			return this.typeSchema(element, substitutions);
		}
		this.fail(id, "tuple rest element must retain an array type");
	}
	objectSchema(members, subject, substitutions) {
		const properties = [];
		const indices = [];
		let symbolMembers = 0;
		for (const member of members) {
			if (member.static || member.visibility !== "public") continue;
			if (member.computed === "symbol") {
				symbolMembers++;
				continue;
			}
			if (member.computed === "dynamic") this.fail(subject, `computed member ${member.name} has no fixed JSON property name`);
			if (member.kind === "index") {
				const parameter = member.signature.parameters[0];
				if (member.signature.parameters.length !== 1 || parameter === void 0) this.fail(subject, "index signature must have exactly one key parameter");
				indices.push(this.readonly(`z.record(${this.typeSchema(parameter.type, substitutions)}, ${this.typeSchema(member.signature.returns, substitutions)})`, member.readonly));
				continue;
			}
			if (member.kind !== "property") this.fail(subject, `${member.kind} member ${member.name} is not data-schema projectable`);
			const property = this.describe(this.optional(this.readonly(this.typeSchema(member.type, substitutions), member.readonly), member.optional), member);
			properties.push(`${quote$1(member.jsonName ?? member.name)}: ${property}`);
		}
		if (indices.length > 1) this.fail(subject, "object type has more than one JSON index signature");
		if (properties.length === 0 && indices.length === 0 && symbolMembers > 0) return "z.unknown()";
		const object = `z.object({${properties.length === 0 ? "" : `\n${properties.map((property) => `  ${property},`).join("\n")}\n`}})`;
		const index = indices[0];
		if (index === void 0) return object;
		if (properties.length === 0) return index;
		return `z.intersection(${object}, ${index})`;
	}
	exportSchemaName(model) {
		const name = this.schemaName(model.symbol);
		if (this.renderer.declaration(model.symbol).typeParameters.length > 0) this.fail(model.export.name, "generic schema exports require a concrete declaration");
		return name;
	}
	keywordSchema(name) {
		switch (name) {
			case "any": return "z.any()";
			case "unknown": return "z.unknown()";
			case "never": return "z.never()";
			case "string": return "z.string()";
			case "number": return "z.number()";
			case "bigint": return "z.bigint()";
			case "boolean": return "z.boolean()";
			case "symbol": return "z.symbol()";
			case "undefined": return "z.undefined()";
			case "void": return "z.void()";
			case "object": return "z.custom((value) => (typeof value === 'object' && value !== null) || typeof value === 'function')";
			default: this.fail(name, `keyword ${name} has no Zod projection`);
		}
	}
	schemaName(symbol) {
		const name = this.names.get(symbol);
		if (name === void 0) this.fail(symbol, "referenced declaration is outside the selected schema closure");
		return name;
	}
	boundaryName(key) {
		const name = this.boundaryNames.get(key);
		if (name === void 0) this.fail(key, "invocation boundary is outside the selected schema roots");
		return name;
	}
	describe(schema, documentation) {
		return documentation.description === void 0 ? schema : `${schema}.describe(${quote$1(documentation.description)})`;
	}
	optional(schema, optional) {
		return optional ? `${schema}.optional()` : schema;
	}
	readonly(schema, readonly) {
		return readonly ? `${schema}.readonly()` : schema;
	}
	unsupported(node) {
		this.fail(node.id, `type node ${node.kind} has no Zod projection`);
	}
	fail(subject, message) {
		throw new TypertEmitError(`typert Zod emitter: ${subject}: ${message}`);
	}
};
function documentationLiteral(documentation) {
	return {
		...documentation.description === void 0 ? {} : { description: documentation.description },
		...documentation.summary === void 0 ? {} : { summary: documentation.summary },
		tags: documentation.tags,
		...documentation.jsDoc === void 0 ? {} : { jsDoc: documentation.jsDoc }
	};
}
function invocationBoundaryRoots(invocations) {
	const result = [];
	for (const invocation of invocations) {
		if (invocation.invocation.kind === "context") result.push({
			key: contextBoundaryKey(invocation),
			type: invocation.invocation.boundary.codecType
		});
		invocation.parameters.forEach((parameter, index) => {
			result.push({
				key: parameterBoundaryKey(invocation, index),
				type: parameter.boundary.codecType
			});
		});
		result.push({
			key: resultBoundaryKey(invocation),
			type: invocation.result.codecType
		});
	}
	return result;
}
function contextBoundaryKey(invocation) {
	return `${invocation.id}:context`;
}
function parameterBoundaryKey(invocation, index) {
	return `${invocation.id}:parameter:${String(index)}`;
}
function resultBoundaryKey(invocation) {
	return `${invocation.id}:result`;
}
function strictCodec(boundary, schema) {
	return [
		"{",
		"  mode: 'strict',",
		`  typeSymbol: ${quote$1(boundary.typeSymbol)},`,
		`  schema: ${schema},`,
		"}"
	].join("\n");
}
function remoteImports(invocations) {
	const imports = /* @__PURE__ */ new Map();
	const add = (boundary) => {
		for (const imported of boundary.imports) {
			const current = imports.get(imported.symbol);
			if (current !== void 0 && (current.specifier !== imported.specifier || current.name !== imported.name)) throw new TypertEmitError(`typert Remote emitter: symbol ${imported.symbol} has inconsistent public imports`);
			imports.set(imported.symbol, imported);
		}
	};
	for (const invocation of invocations) {
		if (invocation.invocation.kind === "context") add(invocation.invocation.boundary);
		for (const parameter of invocation.parameters) add(parameter.boundary);
		add(invocation.result);
	}
	return [...imports.values()].sort((left, right) => left.specifier.localeCompare(right.specifier) || left.name.localeCompare(right.name));
}
function allocateRemoteImportNames(imports) {
	const used = new Set(["TypertRemoteContribution", "TYPERT_REMOTE"]);
	const names = /* @__PURE__ */ new Map();
	for (const imported of imports) {
		const base = safeIdentifier(imported.name);
		let name = base;
		let suffix = 2;
		while (used.has(name)) name = `${base}$remote${String(suffix++)}`;
		used.add(name);
		names.set(imported.symbol, name);
	}
	return names;
}
function packageExportSpecifier(packageName, subpath) {
	return subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`;
}
function safeIdentifier(name) {
	const normalized = name.replace(/[^$\w]/gu, "_");
	if (/^[$A-Z_a-z]/u.test(normalized)) return normalized;
	return `_${normalized}`;
}
function renderRemotePropertyName(name) {
	return /^[$A-Z_a-z][$\w]*$/u.test(name) ? name : quote$1(name);
}
function quote$1(value) {
	return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n").replaceAll("\r", "\\r")}'`;
}
function indent(value, spaces) {
	const prefix = " ".repeat(spaces);
	return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}
//#endregion
//#region lib/types/cordis-catalog.js
/**
* Cordis catalog-specific projection over the compiler-independent Typert
* model. This module owns Cordis validation and text projection mechanics;
* callers supply repository-specific type classifications and inherited data.
* @module @deepseek-ai/dsh-typert-generator
*/
/** Append fail-closed signature type-link violations from the retained type tree. */
function checkTypeLinks(where, names, policy, violations) {
	for (const name of names) {
		if (Object.hasOwn(policy.linkedTypePages, name) || policy.foundationTypeNames.has(name) || Object.hasOwn(policy.typeLinkExemptions, name)) continue;
		violations.push(`${where} references unclassified type '${name}'. Add it to linkedTypePages with its documentation page, to foundationTypeNames if TypeScript or the framework owns it, or to typeLinkExemptions with the non-catalog documentation owner.`);
	}
}
/** Throw one aggregated diagnostic for every unclassified signature type. */
function reportTypeLinkViolations(gate, violations) {
	if (violations.length === 0) return;
	throw new Error(`${gate}: ${violations.length} signature type-link coverage violation(s):\n` + violations.map((violation) => `  ${violation}`).join("\n"));
}
/** Repository-specific Cordis validation and projection over one Typert face. */
var CordisCatalogProjector = class {
	face;
	sourceDeclarations;
	policy;
	renderer;
	/**
	* @param face - analyzed Host or Client face containing package business semantics.
	* @param sourceDeclarations - exported declarations available to the runtime type closure.
	* @param policy - caller-owned type classifications and inherited Cordis data.
	*/
	constructor(face, sourceDeclarations, policy) {
		this.face = face;
		this.sourceDeclarations = sourceDeclarations;
		this.policy = policy;
		this.renderer = new TypeGraphRenderer(face.graph);
	}
	/**
	* Validate and project the host model's Cordis API.
	* @returns every validated service and event projected from the host model.
	*/
	project() {
		return {
			events: this.collectEvents(),
			services: this.collectServices()
		};
	}
	/**
	* Render the model-facing static API consumed by `tool-cordis`.
	* @param model - validated Cordis catalog projection from this projector.
	* @returns the model-facing TypeScript catalog source.
	*/
	renderRuntimeApi(model) {
		const services = [...model.services, ...this.policy.runtimeServices ?? []].filter((service) => !this.policy.runtimeServiceExclusions?.has(service.key)).sort((left, right) => left.key.localeCompare(right.key));
		return renderRuntimeApi(services, model.events, this.runtimeTypes(services, model.events), this.policy.inheritedServices);
	}
	collectEvents() {
		const entries = [];
		const violations = [];
		const typeLinkViolations = [];
		for (const packageModel of this.face.packages) for (const event of packageModel.events) {
			const parsed = parseJsDoc(event.jsDoc ?? "");
			if (parsed.deprecated) continue;
			const source = pointer(event.location);
			const where = `event '${event.name}' (${source})`;
			const node = this.renderer.node(event.signature);
			if (node.kind !== "function") {
				violations.push(`${where} is not represented by a callable type.`);
				continue;
			}
			if (this.face.face === "host") checkTypeLinks(where, signatureTypeNames(this.renderer, node.signature), this.policy, typeLinkViolations);
			const mode = event.mode;
			if (!isMode(mode)) violations.push(`${where} is missing an @mode tag. Add '@mode emit|bail|waterfall|parallel|serial' to its JSDoc (see AGENTS.md).`);
			const last = node.signature.parameters.at(-1);
			const hasNext = last?.name === "next";
			if (isMode(mode) && hasNext && mode !== "waterfall") violations.push(`${where} has a trailing 'next' parameter (structurally a waterfall) but is tagged '@mode ${mode}'. Fix the tag or the signature.`);
			if (isMode(mode) && !hasNext && mode === "waterfall") violations.push(`${where} is tagged '@mode waterfall' but has no trailing 'next' parameter. A waterfall delegates via next().`);
			if (parsed.doc === "") violations.push(`${where} has no description prose. Say what happened / what a listener may do, above the block tags.`);
			checkParams(where, "event", node.signature.parameters, parsed.params, (parameter) => parameter.receiver || hasNext && parameter === last, violations);
			if (isMode(mode)) entries.push({
				name: event.name,
				scope: event.name.split("/")[0] ?? event.name,
				signature: event.text,
				jsDoc: event.jsDoc ?? "",
				mode,
				doc: parsed.doc,
				source
			});
		}
		reportViolations("gen-cordis-catalog", violations);
		reportTypeLinkViolations("gen-cordis-catalog", typeLinkViolations);
		return entries;
	}
	/**
	* The services this projection describes, one per `ctx.<key>`: those whose
	* Context merge sits one level under a package's `src` and whose declaration
	* belongs to that same package.
	*
	* Interfaces qualify beside classes, because an interface-typed key
	* (`lsp: LspService`) has its Service Definition — and, by repository
	* convention, its member documentation — on the interface; requiring a class
	* would drop a real injectable service from every catalog. The declaration may
	* live in any file of the package (`types.ts` is the usual home), while a
	* declaration from ANOTHER package is not this package's surface to document.
	*
	* One key can have both kinds of candidate across packages: `ctx.typert` is
	* typed by a merge-extensible interface in `type-meta` and implemented by a
	* class in `registry`. The CLASS wins — it carries the documentation and is the
	* object a caller meets — and picking before validating is what keeps a
	* discarded candidate's missing JSDoc from failing the gate.
	*/
	renderableServices() {
		const chosen = /* @__PURE__ */ new Map();
		for (const packageModel of this.face.packages) for (const service of packageModel.services) {
			const declaration = this.renderer.declaration(service.symbol);
			const owner = /^packages\/[^/]+\/[^/]+\/src\//.exec(service.location.file)?.[0];
			if (declaration.kind !== "class" && declaration.kind !== "interface" || owner === void 0 || (this.face.face === "host" ? !/^packages\/[^/]+\/[^/]+\/src\/[^/]+\.ts$/.test(service.location.file) : !/^packages\/[^/]+\/[^/]+\/src\/client\/.+\.tsx?$/.test(service.location.file)) || !declaration.location.file.startsWith(owner)) continue;
			const current = chosen.get(service.key);
			if (current !== void 0 && this.renderer.declaration(current.symbol).kind === "class") continue;
			chosen.set(service.key, service);
		}
		return [...chosen.values()];
	}
	collectServices() {
		const entries = [];
		const violations = [];
		const typeLinkViolations = [];
		for (const service of this.renderableServices()) {
			const declaration = this.renderer.declaration(service.symbol);
			const parsedDeclaration = parseJsDoc(declaration.jsDoc ?? "");
			if (parsedDeclaration.deprecated) continue;
			const doc = parsedDeclaration.doc;
			const source = pointer(declaration.location);
			if (doc === "") violations.push(`service ctx.${service.key} (${source}): ${declaration.kind} ${declaration.name} has no JSDoc.`);
			const methods = [];
			for (const memberId of service.members) {
				const member = this.renderer.member(memberId);
				if (member.name.startsWith("[")) continue;
				const parsed = parseJsDoc(member.jsDoc ?? "");
				if (parsed.deprecated) continue;
				if (member.kind === "property") {
					if (member.jsDoc === void 0) continue;
					methods.push({
						kind: "property",
						signature: member.text,
						jsDoc: member.jsDoc
					});
					continue;
				}
				if (member.kind !== "method") continue;
				const where = `service method ctx.${service.key}.${member.name} (${pointer(member.location)})`;
				if (this.face.face === "host") checkTypeLinks(where, signatureTypeNames(this.renderer, member.signature), this.policy, typeLinkViolations);
				methods.push({
					kind: "method",
					signature: member.text,
					jsDoc: member.jsDoc ?? ""
				});
				if (member.jsDoc === void 0) {
					violations.push(`${where} has no JSDoc.`);
					continue;
				}
				if (parsed.doc === "") violations.push(`${where} has no description prose above its block tags.`);
				checkParams(where, "service", member.signature.parameters, parsed.params, (parameter) => parameter.receiver, violations);
				checkReturns(where, member.signature, parsed.returns, this.renderer, violations);
			}
			entries.push({
				key: service.key,
				type: declaration.name,
				abstract: declaration.abstract,
				doc,
				methods,
				source
			});
		}
		reportViolations("gen-cordis-catalog", violations);
		reportTypeLinkViolations("gen-cordis-catalog", typeLinkViolations);
		return entries.sort((left, right) => left.key.localeCompare(right.key));
	}
	runtimeTypes(services, events) {
		const declarations = /* @__PURE__ */ new Map();
		const ambiguous = /* @__PURE__ */ new Set();
		for (const declaration of this.sourceDeclarations) {
			if (declaration.face !== this.face.face || declaration.kind === "enum" || !/^packages\/[^/]+\/[^/]+\/src\/.+\.tsx?$/.test(declaration.location.file)) continue;
			if (declarations.has(declaration.name)) {
				ambiguous.add(declaration.name);
				continue;
			}
			declarations.set(declaration.name, declaration.text.length > MAX_DECL_CHARS ? `${declaration.text.slice(0, MAX_DECL_CHARS)} /* …truncated — full shape in source */` : declaration.text);
		}
		for (const name of ambiguous) declarations.delete(name);
		return referencedTypes([...services.flatMap((service) => service.methods.map((method) => method.signature)), ...events.map((event) => event.signature)], declarations);
	}
};
/**
* Analyze the host project once and return both the model and its projection.
* @param scanRoot - workspace root containing `tsconfig.host.json`.
* @param policy - caller-owned type classifications and inherited Cordis data.
* @param targetFace - Host or Client Typert face to project.
* @returns the configured projector and its validated catalog model.
*/
function projectCordisCatalog(scanRoot, policy, targetFace = "host") {
	const caches = new WorkspaceCaches();
	const packages = new WorkspaceAnalyzer({
		root: scanRoot,
		faces: [targetFace],
		checkDiagnostics: false,
		caches
	}).discoverPackages().filter((candidate) => candidate.faces.includes(targetFace)).map((candidate) => candidate.package);
	const face = new WorkspaceAnalyzer({
		root: scanRoot,
		faces: [targetFace],
		packages,
		checkDiagnostics: false,
		caches
	}).analyzeInBatches().faces.find((candidate) => candidate.face === targetFace);
	if (face === void 0) throw new Error(`gen-cordis-catalog: Typert produced no ${targetFace} face`);
	const projector = new CordisCatalogProjector(face, new WorkspaceAnalyzer({
		root: scanRoot,
		faces: [targetFace],
		checkDiagnostics: false,
		caches
	}).indexSourceDeclarations(), policy);
	return {
		projector,
		model: projector.project()
	};
}
/**
* Collect all modeled events for relationship-document consumers.
* @param scanRoot - workspace root containing `tsconfig.host.json`.
* @param policy - caller-owned Cordis catalog policy.
* @returns all validated event entries.
*/
function collectEvents(scanRoot, policy) {
	return [...projectCordisCatalog(scanRoot, policy).model.events];
}
/**
* Collect all modeled services for relationship-document consumers.
* @param scanRoot - workspace root containing `tsconfig.host.json`.
* @param policy - caller-owned Cordis catalog policy.
* @returns all validated service entries.
*/
function collectServices(scanRoot, policy) {
	return [...projectCordisCatalog(scanRoot, policy).model.services];
}
function parseJsDoc(raw) {
	const lines = raw.replace(/^\/\*\*/, "").replace(/\*\/$/, "").split("\n").map((line) => line.replace(/^\s*\*?\s?/, "").replace(/\s+$/, ""));
	const blocks = [];
	let paragraph = [];
	let list = [];
	let item = [];
	let inTags = false;
	const join = (parts) => parts.join(" ").replace(/\s+/g, " ").trim();
	const flushItem = () => {
		if (item.length > 0) list.push(join(item));
		item = [];
	};
	const flushList = () => {
		flushItem();
		if (list.length > 0) blocks.push(list.join("\n"));
		list = [];
	};
	const flushParagraph = () => {
		flushList();
		if (paragraph.length > 0) blocks.push(join(paragraph));
		paragraph = [];
	};
	for (const line of lines) {
		if (line.trimStart().startsWith("@")) {
			flushParagraph();
			inTags = true;
			continue;
		}
		if (inTags) continue;
		if (line.trim() === "") {
			flushParagraph();
			continue;
		}
		if (/^-\s+/.test(line)) {
			flushItem();
			if (paragraph.length > 0) {
				blocks.push(join(paragraph));
				paragraph = [];
			}
			item.push(line);
			continue;
		}
		if (item.length > 0) item.push(line);
		else paragraph.push(line);
	}
	flushParagraph();
	const params = /* @__PURE__ */ new Map();
	let returns = null;
	const throws = [];
	let deprecated = false;
	let sink;
	for (const line of lines) {
		if (/^@deprecated(?:\s|$)/.test(line)) {
			deprecated = true;
			sink = void 0;
			continue;
		}
		const param = /^@param\s+(\[?[\w$]+\]?)\s*(?:[-—–]\s*)?(.*)$/.exec(line);
		if (param !== null) {
			const name = (param[1] ?? "").replace(/^\[|\]$/g, "");
			let value = param[2] ?? "";
			params.set(name, value);
			sink = (text) => {
				value = value === "" ? text : `${value} ${text}`;
				params.set(name, value);
			};
			continue;
		}
		const returnsTag = /^@returns?(?:\s+[-—–]?\s*(.*))?$/.exec(line);
		if (returnsTag !== null) {
			let value = returnsTag[1] ?? "";
			returns = value;
			sink = (text) => {
				value = value === "" ? text : `${value} ${text}`;
				returns = value;
			};
			continue;
		}
		const throwsTag = /^@throws?(?:\s+[-—–]?\s*(.*))?$/.exec(line);
		if (throwsTag !== null) {
			let value = throwsTag[1] ?? "";
			throws.push(value);
			const index = throws.length - 1;
			sink = (text) => {
				value = value === "" ? text : `${value} ${text}`;
				throws[index] = value;
			};
			continue;
		}
		if (line.startsWith("@") || line.trim() === "") sink = void 0;
		else sink?.(line.trim());
	}
	return {
		doc: blocks.join("\n\n").replace(/\{@link\s+([^}]+)\}/g, "$1").trim(),
		params,
		returns,
		throws,
		deprecated
	};
}
function checkParams(where, apiKind, parameters, tags, isExempt, violations) {
	for (const parameter of parameters) {
		if (parameter.binding !== "identifier") {
			violations.push(`${where}: parameter '${parameter.name}' is a binding pattern; the ${apiKind} API needs simple identifier parameters so @param can name them.`);
			continue;
		}
		if (isExempt(parameter)) continue;
		const description = tags.get(parameter.name);
		if (description === void 0) violations.push(`${where} is missing @param ${parameter.name}.`);
		else if (description.trim() === "") violations.push(`${where}: @param ${parameter.name} has an empty description.`);
	}
	for (const tag of tags.keys()) if (!parameters.some((parameter) => parameter.binding === "identifier" && parameter.name === tag)) violations.push(`${where}: @param ${tag} does not match any parameter (stale tag?).`);
}
function checkReturns(where, signature, returns, renderer, violations) {
	const type = renderer.renderType(signature.returns);
	if (type === "void" || type === "Promise<void>") return;
	if (returns === null) violations.push(`${where} is missing @returns (return type: ${type}).`);
	else if (returns.trim() === "") violations.push(`${where}: @returns has an empty description.`);
}
function reportViolations(gate, violations) {
	if (violations.length === 0) return;
	throw new Error(`${gate}: ${String(violations.length)} JSDoc completeness violation(s) (see AGENTS.md):\n` + violations.map((violation) => `  ${violation}`).join("\n"));
}
function pointer(location) {
	return `${location.file}:${String(location.line)}`;
}
function isMode(mode) {
	return mode === "emit" || mode === "bail" || mode === "waterfall" || mode === "parallel" || mode === "serial";
}
function signatureTypeNames(renderer, signature) {
	const names = /* @__PURE__ */ new Set();
	const visited = /* @__PURE__ */ new Set();
	const visitSignature = (current) => {
		for (const parameter of current.typeParameters) {
			if (parameter.constraint !== void 0) visit(parameter.constraint);
			if (parameter.default !== void 0) visit(parameter.default);
		}
		for (const parameter of current.parameters) visit(parameter.type);
		visit(current.returns);
	};
	const visitMember = (member) => {
		if (member.kind === "property") visit(member.type);
		else visitSignature(member.signature);
	};
	const visit = (id) => {
		if (visited.has(id)) return;
		visited.add(id);
		const node = renderer.node(id);
		if (node.kind === "reference" && node.target.kind !== "type-parameter") names.add(node.name);
		if (node.kind === "type-query") names.add(node.expression);
		for (const child of childTypeNodeIds(node)) visit(child);
		if (node.kind === "object") for (const member of node.members) visitMember(member);
		if (node.kind === "function" || node.kind === "constructor") visitSignature(node.signature);
	};
	visitSignature(signature);
	return [...names].sort();
}
/** Declarations longer than this render as a truncated stub. */
const MAX_DECL_CHARS = 1500;
/** Render one value as a single-quoted TypeScript literal. */
function quote(value) {
	return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n")}'`;
}
/** Render a compact TypeScript string-array literal. */
function quoteList(values) {
	return `[${values.map(quote).join(", ")}]`;
}
/** Render structured parameter documentation as a compact TypeScript literal. */
function renderParameters(parameters) {
	return `[${[...parameters].map(([name, description]) => `{ name: ${quote(name)}, description: ${quote(description)} }`).join(", ")}]`;
}
/** Resolve and sort the word-bounded transitive type closure referenced by seed text. */
function referencedTypes(seeds, declarations) {
	const included = /* @__PURE__ */ new Map();
	let frontier = [...seeds];
	while (frontier.length > 0) {
		const next = [];
		for (const [name, declaration] of declarations) {
			if (included.has(name)) continue;
			const pattern = new RegExp(`\\b${name}\\b`);
			if (frontier.some((text) => pattern.test(text))) {
				included.set(name, declaration);
				next.push(declaration);
			}
		}
		frontier = next;
	}
	return [...included].map(([name, declaration]) => ({
		name,
		declaration
	})).sort((left, right) => left.name.localeCompare(right.name));
}
function firstSentence(doc) {
	const line = doc.split("\n", 1)[0] ?? "";
	return (/^(.*?[.!?])(?:\s|$)/.exec(line)?.[1] ?? line).trim();
}
/** Render the byte-compatible model-facing API catalog. */
function renderRuntimeApi(services, events, types, inheritedServices) {
	const lines = [
		"/**",
		" * Generated by scripts/gen-cordis-api.ts — do not edit by hand; run",
		" * `pnpm run gen-cordis-api` to regenerate (freshness-gated by",
		" * `pnpm run verify-cordis-api` in doc-sync).",
		" *",
		" * The machine-readable cordis API catalog `cordis_inspect` serves to the",
		" * model: harness services (summary + structured public method contracts),",
		" * harness events (mode + structured listener contracts), and the inherited `ctx` API. Produced by",
		" * the same AST walk as docs/cordis-catalog, so this data and the rendered",
		" * docs cannot diverge.",
		" *",
		" * @module @deepseek-ai/dsh-tool-cordis/api-catalog",
		" */",
		"",
		"/* jscpd:ignore-start */",
		"/** One named parameter in a Service method or Event listener. */",
		"export interface ApiParameter {",
		"  /** Parameter name from the exact signature. */",
		"  name: string",
		"  /** Source-owned parameter contract. */",
		"  description: string",
		"}",
		"",
		"/** One public service member and its source-owned contract. */",
		"export interface ServiceApiMethod {",
		"  /** Public method signature with its body stripped. */",
		"  signature: string",
		"  /** Method purpose and behavior. */",
		"  description: string",
		"  /** Named parameters in signature order. */",
		"  parameters: readonly ApiParameter[]",
		"  /** Non-void result contract when documented. */",
		"  returns?: string",
		"  /** Documented failure conditions. */",
		"  throws?: readonly string[]",
		"}",
		"",
		"/** One harness `ctx.<key>` service and its public methods. */",
		"export interface ServiceApiEntry {",
		"  /** The `ctx.<key>` name, e.g. `tools`. */",
		"  key: string",
		"  /** First sentence of the service class JSDoc. */",
		"  summary: string",
		"  /** Complete service description. */",
		"  description: string",
		"  /** Public methods, bodies stripped, in source order. */",
		"  methods: readonly ServiceApiMethod[]",
		"}",
		"",
		"/** One harness event: its dispatch mode, exact signature, and listener contract. */",
		"export interface EventApiEntry {",
		"  /** The scoped event name, e.g. `agent/status`. */",
		"  name: string",
		"  /** The dispatch mode from the declaration's `@mode` tag. */",
		"  mode: string",
		"  /** The exact listener signature, whitespace-normalized. */",
		"  signature: string",
		"  /** First sentence of the event JSDoc. */",
		"  summary: string",
		"  /** Complete event description. */",
		"  description: string",
		"  /** Named listener parameters in signature order. */",
		"  parameters: readonly ApiParameter[]",
		"}",
		"",
		"/** One inherited (cordis core + loader/hmr/timer) `ctx` member group with its summary. */",
		"export interface InheritedApiEntry {",
		"  /** The `ctx` member name(s), e.g. `ctx.on / ctx.once`. */",
		"  name: string",
		"  /** One-line summary of what the member does. */",
		"  summary: string",
		"}",
		"",
		"/** One named type declaration referenced by a Service or Event signature. */",
		"export interface TypeApiEntry {",
		"  /** The exported type/interface name, e.g. `ShellRunResult`. */",
		"  name: string",
		"  /** The full declaration text, comments stripped. */",
		"  declaration: string",
		"}",
		"",
		"/** Every harness `ctx.<key>` service, sorted by key. */",
		"export const SERVICE_API: readonly ServiceApiEntry[] = ["
	];
	for (const service of services) {
		lines.push("  {");
		lines.push(`    key: ${quote(service.key)},`);
		lines.push(`    summary: ${quote(firstSentence(service.doc))},`);
		lines.push(`    description: ${quote(service.doc)},`);
		if (service.methods.length === 0) lines.push("    methods: [],");
		else {
			lines.push("    methods: [");
			for (const method of service.methods) {
				const contract = parseJsDoc(method.jsDoc);
				lines.push("      {");
				lines.push(`        signature: ${quote(method.signature)},`);
				lines.push(`        description: ${quote(contract.doc)},`);
				lines.push(`        parameters: ${renderParameters(contract.params)},`);
				if (contract.returns !== null) lines.push(`        returns: ${quote(contract.returns)},`);
				if (contract.throws.length > 0) lines.push(`        throws: ${quoteList(contract.throws)},`);
				lines.push("      },");
			}
			lines.push("    ],");
		}
		lines.push("  },");
	}
	lines.push("]", "", "/** Every harness event, sorted by name. */", "export const EVENT_API: readonly EventApiEntry[] = [");
	for (const event of [...events].sort((left, right) => left.name.localeCompare(right.name))) {
		const contract = parseJsDoc(event.jsDoc);
		lines.push("  {");
		lines.push(`    name: ${quote(event.name)},`);
		lines.push(`    mode: ${quote(event.mode)},`);
		lines.push(`    signature: ${quote(event.signature)},`);
		lines.push(`    summary: ${quote(firstSentence(event.doc))},`);
		lines.push(`    description: ${quote(event.doc)},`);
		lines.push(`    parameters: ${renderParameters(contract.params)},`);
		lines.push("  },");
	}
	lines.push("]", "", "/** Shapes of every exported type the Service and Event signatures reference (transitively), sorted by name. */", "export const TYPE_API: readonly TypeApiEntry[] = [");
	for (const type of types) {
		lines.push("  {");
		lines.push(`    name: ${quote(type.name)},`);
		lines.push(`    declaration: ${quote(type.declaration)},`);
		lines.push("  },");
	}
	lines.push("]", "", "/** The inherited `ctx` API (cordis core + loader/hmr/timer), in curated order. */", "export const INHERITED_CTX_API: readonly InheritedApiEntry[] = [");
	for (const inherited of inheritedServices) lines.push(`  { name: ${quote(inherited.name)}, summary: ${quote(inherited.summary)} },`);
	lines.push("]", "", "function referencedTypeClosure(seeds: readonly string[]): TypeApiEntry[] {", "  const included = new Set<string>()", "  let frontier = [...seeds]", "  while (frontier.length > 0) {", "    const next: string[] = []", "    for (const entry of TYPE_API) {", "      if (included.has(entry.name)) continue", "      const pattern = new RegExp(`\\\\b${entry.name}\\\\b`)", "      if (!frontier.some(text => pattern.test(text))) continue", "      included.add(entry.name)", "      next.push(entry.declaration)", "    }", "    frontier = next", "  }", "  return TYPE_API.filter(entry => included.has(entry.name))", "}", "", "function contextProperty(key: string): string {", "  return /^[A-Za-z_$][\\w$]*$/.test(key) ? `ctx.${key}` : `ctx[${JSON.stringify(key)}]`", "}", "", "/**", " * Project the Service Catalog as a compact directory or one exact coding contract.", " * @param key - exact Service key; omit it to list all Services and method signatures.", " * @param services - platform-specific visible Service entries.", " * @returns compact navigation data or one detailed Service with its referenced type closure.", " */", "export function queryServiceApi(key?: string, services: readonly ServiceApiEntry[] = SERVICE_API): object {", "  if (key === undefined) {", "    return {", "      mode: 'catalog',", "      services: services.map(service => ({", "        key: service.key,", "        description: service.summary,", "        methods: service.methods.map(method => ({ signature: method.signature })),", "      })),", "    }", "  }", "  const service = services.find(candidate => candidate.key === key)", "  if (service === undefined) throw new Error(`no catalogued Service named \"${key}\"`)", "  return {", "    mode: 'service',", "    service: {", "      key: service.key,", "      description: service.description,", "      access: {", "        optional: { expression: `ctx.get(${JSON.stringify(service.key)})`, requiresUndefinedCheck: true },", "        hardDependency: { inject: [service.key], expression: contextProperty(service.key) },", "      },", "      methods: service.methods,", "    },", "    referencedTypes: referencedTypeClosure(service.methods.map(method => method.signature)),", "  }", "}", "", "/**", " * Project the Event Catalog as a compact directory or one exact listener contract.", " * @param name - exact Event name; omit it to list all Events and listener signatures.", " * @param events - platform-specific visible Event entries.", " * @returns compact navigation data or one detailed Event with its referenced type closure.", " */", "export function queryEventApi(name?: string, events: readonly EventApiEntry[] = EVENT_API): object {", "  if (name === undefined) {", "    return {", "      mode: 'catalog',", "      events: events.map(event => ({", "        name: event.name,", "        description: event.summary,", "        mode: event.mode,", "        signature: event.signature,", "      })),", "    }", "  }", "  const event = events.find(candidate => candidate.name === name)", "  if (event === undefined) throw new Error(`no catalogued Event named \"${name}\"`)", "  return {", "    mode: 'event',", "    event: {", "      name: event.name,", "      description: event.description,", "      mode: event.mode,", "      signature: event.signature,", "      parameters: event.parameters,", "    },", "    referencedTypes: referencedTypeClosure([event.signature]),", "  }", "}", "/* jscpd:ignore-end */", "");
	return lines.join("\n");
}
/** Opening region delimiter; injected content lives between the pair and the page owns everything outside. */
const REGION_BEGIN = "<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->";
/** Closing region delimiter matching {@link REGION_BEGIN}. */
const REGION_END = "<!-- END GENERATED cordis-surface -->";
/**
* Render the cross-link "Types:" line for a signature relative to one
* subsystems page, or '' if none apply. A type whose primary page IS the
* rendering page would link as a fragmentless self-link readers already sit
* on, so it is dropped instead.
*/
function typeLinks(signature, onPage, linkedTypePages) {
	const seen = /* @__PURE__ */ new Set();
	for (const name of Object.keys(linkedTypePages)) if (new RegExp(`\\b${name}\\b`).test(signature)) seen.add(name);
	const links = [...seen].sort().filter((name) => linkedTypePages[name] !== onPage).map((name) => `[${name}](${linkedTypePages[name]})`);
	if (links.length === 0) return "";
	return `Types: ${links.join(" · ")}`;
}
/**
* GitHub's heading-slug algorithm (lowercase; drop everything but letters,
* numbers, spaces, hyphens; spaces become hyphens). Region headings carry
* backticks and em-dashes, which VitePress slugifies differently, so each
* generated heading is preceded by an explicit `<a id>` carrying this slug —
* the historical flat-catalog anchor — making `#ctx<key>--<class>` fragments
* resolve identically on GitHub and the published site.
*/
function githubSlug(heading) {
	return heading.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, "").replaceAll(" ", "-");
}
/** The explicit-anchor line emitted before one generated heading. */
function anchorFor(headingText) {
	return [`<a id="${githubSlug(headingText)}"></a>`, ""];
}
/** Render a subsystem `file:line` source pointer as a file-only link. */
function sourceLink(source) {
	const file = source.split(":")[0];
	return `[\`${file}\`](../../${file})`;
}
/** Render one harness event entry onto its owning page, nested under its scope heading. */
function renderEvent(e, onPage, linkedTypePages) {
	const out = [
		...anchorFor(`${e.name} — ${e.mode}`),
		`#### \`${e.name}\` — ${e.mode}`,
		""
	];
	if (e.doc) out.push(e.doc, "");
	out.push("```ts cordis-catalog", e.jsDoc, e.signature, "```", "");
	const links = typeLinks(e.signature, onPage, linkedTypePages);
	if (links) out.push(links, "");
	out.push(`Source: ${sourceLink(e.source)}`, "");
	return out;
}
/** Render one harness service entry onto its owning page. */
function renderService(s, onPage, linkedTypePages) {
	const kind = s.abstract ? " (abstract seam)" : "";
	const out = [
		...anchorFor(`ctx.${s.key} — ${s.type}${kind}`),
		`### \`ctx.${s.key}\` — \`${s.type}\`${kind}`,
		""
	];
	if (s.doc) out.push(s.doc, "");
	const methods = s.methods.filter((member) => member.kind !== "property");
	if (methods.length) {
		const declarations = methods.flatMap((method, index) => [
			...index > 0 ? [""] : [],
			method.jsDoc,
			method.signature
		]);
		out.push("```ts cordis-catalog", ...declarations, "```", "");
		const links = typeLinks(methods.map((method) => method.signature).join("\n"), onPage, linkedTypePages);
		if (links) out.push(links, "");
	}
	out.push(`Source: ${sourceLink(s.source)}`, "");
	return out;
}
/** The shared generated-file banner comment. */
const BANNER = [
	"<!-- Generated by scripts/gen-cordis-catalog.ts — do not edit by hand.",
	"     Run `pnpm run gen-cordis-catalog` to regenerate. -->",
	""
];
/** The shared GENERATED + freshness-gate + fence notice paragraph. */
const GATE_NOTICE = "This file is GENERATED from source (`scripts/gen-cordis-catalog.ts`) and verified fresh by `pnpm run verify-cordis-catalog` (part of `doc-sync`) — do not edit it by hand. Signature blocks use a `ts cordis-catalog` fence and include the original source JSDoc immediately before each event or service method. doc-typecheck skips these bare declaration fragments; type names in a signature link to the page that documents them.";
/**
* Render one page's generated Cordis API region: the services mapped to
* the page, then the event scopes mapped to it, markers included. Pure and
* deterministic given sorted inputs; identical bytes land in both pair sides.
* @param page - the owning `docs/subsystems/` page basename, e.g. `core.md`.
* @param services - validated services mapped to this page.
* @param events - validated events whose scopes map to this page.
* @param policy - type links supplied by the caller.
* @returns the complete marker-delimited region text.
*/
function renderPageRegion(page, services, events, policy) {
	const lines = [
		REGION_BEGIN,
		"",
		"<a id=\"cordis-surface\"></a>",
		"",
		"## Cordis API",
		"",
		"Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).",
		""
	];
	for (const s of services) lines.push(...renderService(s, page, policy.linkedTypePages));
	const scopes = [...new Set(events.map((e) => e.scope))].sort();
	for (const scope of scopes) {
		lines.push(...anchorFor(`${scope}/* events`), `### \`${scope}/*\` events`, "");
		for (const e of events.filter((x) => x.scope === scope).sort((a, b) => a.name.localeCompare(b.name))) lines.push(...renderEvent(e, page, policy.linkedTypePages));
	}
	while (lines.at(-1) === "") lines.pop();
	lines.push(REGION_END);
	return lines.join("\n");
}
/**
* Render the inherited (pinned vendor) tier as its own generated page.
* @param policy - inherited events and services supplied by the caller.
* @returns the complete generated Markdown document.
*/
function renderInheritedPage(policy) {
	const lines = [
		...BANNER,
		"# Inherited Cordis API",
		"",
		"The framework `ctx` members and events every plugin sees beyond the harness tier — pinned vendor source ([vendoring policy](../../vendor/README.md)), summarized tersely so the harness pages stay focused on repository-owned vocabulary. Detailed Context, Fiber, Registry, and Service APIs are generated in [context.md](context.md), [fiber.md](fiber.md), [registry.md](registry.md), and [service.md](service.md); the event-dispatch methods in [events.md](events.md).",
		"",
		GATE_NOTICE,
		"",
		"## Inherited `ctx` members (cordis core + loader/hmr/timer)",
		""
	];
	for (const s of policy.inheritedServices) lines.push(`- \`${s.name}\` — ${s.summary} ([\`${s.source}\`](../../${s.source.split(":")[0]}))`);
	lines.push("", "## Inherited events (cordis core + loader/hmr/timer)", "");
	for (const e of policy.inheritedEvents) lines.push(`- \`${e.name}\` — ${e.summary} ([\`${e.source}\`](../../${e.source.split(":")[0]}))`);
	lines.push("");
	return lines.join("\n");
}
//#endregion
//#region lib/types/workspace.js
/**
* Workspace-level discovery and model-driven Typert generation.
* @module @deepseek-ai/dsh-typert-generator/workspace
*/
/** Discover, analyze, and emit package reflection from independent faces. */
var WorkspaceTypertGenerator = class {
	root;
	options;
	/** Parsed-config and program-host state shared by every analyzer this generator creates. */
	caches = new WorkspaceCaches();
	/**
	* Bind generation to one workspace root.
	* @param root - directory containing face aggregate tsconfigs.
	* @param options - behavior switches applied to every pass of this generator.
	*/
	constructor(root, options = {}) {
		this.root = root;
		this.options = options;
	}
	/**
	* Find public package faces that contribute Cordis services/events or
	* explicitly tagged Typert roots.
	* @param faces - optional independent program faces to inspect.
	* @returns discovered packages in stable package-name order.
	*/
	discover(faces) {
		return new WorkspaceAnalyzer({
			root: this.root,
			caches: this.caches,
			...faces === void 0 ? {} : { faces }
		}).discoverPackages();
	}
	/**
	* Generate all discovered contributors, or an explicit package subset.
	* @param packages - optional exact package names for a focused pass.
	* @param faces - optional independent program faces to analyze.
	* @returns one artifact per package face.
	*/
	generate(packages, faces) {
		const selected = packages ?? this.discover(faces).map((candidate) => candidate.package);
		const workspace = new WorkspaceAnalyzer({
			root: this.root,
			packages: selected,
			caches: this.caches,
			...faces === void 0 ? {} : { faces },
			...this.options.checkDiagnostics === void 0 ? {} : { checkDiagnostics: this.options.checkDiagnostics }
		}).analyze();
		const artifacts = [];
		for (const face of workspace.faces) {
			const emitter = new FaceModelEmitter(face);
			for (const packageModel of face.packages) {
				const artifact = {
					...emitter.emit(packageModel.name),
					packageRoot: packageModel.root
				};
				this.validateExport(artifact);
				artifacts.push(artifact);
			}
		}
		return artifacts;
	}
	validateExport(artifact) {
		const manifestPath = resolve(this.root, artifact.packageRoot, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		const subpath = artifact.face === "host" ? "./typert" : "./client/typert";
		const expected = {
			types: `./lib/typert.${artifact.face}.d.ts`,
			default: `./lib/typert.${artifact.face}.js`
		};
		if (!sameExport(manifest.exports !== null && typeof manifest.exports === "object" ? manifest.exports[subpath] : void 0, expected)) throw new TypertAnalysisError(`typert(${artifact.face}): ${artifact.package} must export ${subpath} as ${JSON.stringify(expected)}`);
		const files = Array.isArray(manifest.files) ? manifest.files : [];
		for (const file of [`lib/typert.${artifact.face}.js`, `lib/typert.${artifact.face}.d.ts`]) if (!files.includes(file)) throw new TypertAnalysisError(`typert(${artifact.face}): ${artifact.package} package files must include ${file}`);
		if (artifact.face !== "host") return;
		const remoteExpected = {
			types: "./lib/typert.remote-client.d.ts",
			default: "./lib/typert.remote-client.js"
		};
		const remoteActual = manifest.exports !== null && typeof manifest.exports === "object" ? manifest.exports["./remote"] : void 0;
		const remoteFiles = ["lib/typert.remote-client.js", "lib/typert.remote-client.d.ts"];
		if (artifact.remote === void 0) {
			if (remoteActual !== void 0 || remoteFiles.some((file) => files.includes(file))) throw new TypertAnalysisError(`typert(host): ${artifact.package} publishes Remote artifacts but has no Remote methods`);
			return;
		}
		if (!sameExport(remoteActual, remoteExpected)) throw new TypertAnalysisError(`typert(host): ${artifact.package} must export ./remote as ${JSON.stringify(remoteExpected)}`);
		for (const file of remoteFiles) if (!files.includes(file)) throw new TypertAnalysisError(`typert(host): ${artifact.package} package files must include ${file}`);
	}
};
function sameExport(actual, expected) {
	if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
	const value = actual;
	return value.types === expected.types && value.default === expected.default;
}
//#endregion
export { CordisCatalogProjector, FaceModelEmitter, REGION_BEGIN, REGION_END, TypeGraphRenderError, TypeGraphRenderer, TypertAnalysisError, TypertEmitError, WorkspaceAnalyzer, WorkspaceCaches, WorkspaceTypertGenerator, collectEvents, collectServices, projectCordisCatalog, renderInheritedPage, renderPageRegion };
