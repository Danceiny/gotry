/**
 * Workspace-level discovery and model-driven Typert generation.
 * @module @deepseek-ai/dsh-typert-generator/workspace
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TypertAnalysisError, WorkspaceAnalyzer, WorkspaceCaches } from "./analyzer.js";
import { FaceModelEmitter } from "./emitter.js";
/** Discover, analyze, and emit package reflection from independent faces. */
export class WorkspaceTypertGenerator {
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
            ...(faces === undefined ? {} : { faces }),
        }).discoverPackages();
    }
    /**
     * Generate all discovered contributors, or an explicit package subset.
     * @param packages - optional exact package names for a focused pass.
     * @param faces - optional independent program faces to analyze.
     * @returns one artifact per package face.
     */
    generate(packages, faces) {
        const selected = packages ?? this.discover(faces).map(candidate => candidate.package);
        const workspace = new WorkspaceAnalyzer({
            root: this.root,
            packages: selected,
            caches: this.caches,
            ...(faces === undefined ? {} : { faces }),
            ...(this.options.checkDiagnostics === undefined ? {} : { checkDiagnostics: this.options.checkDiagnostics }),
        }).analyze();
        const artifacts = [];
        for (const face of workspace.faces) {
            const emitter = new FaceModelEmitter(face);
            for (const packageModel of face.packages) {
                const artifact = {
                    ...emitter.emit(packageModel.name),
                    packageRoot: packageModel.root,
                };
                this.validateExport(artifact);
                artifacts.push(artifact);
            }
        }
        return artifacts;
    }
    validateExport(artifact) {
        const manifestPath = resolve(this.root, artifact.packageRoot, 'package.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const subpath = artifact.face === 'host' ? './typert' : './client/typert';
        const expected = {
            types: `./lib/typert.${artifact.face}.d.ts`,
            default: `./lib/typert.${artifact.face}.js`,
        };
        const actual = manifest.exports !== null && typeof manifest.exports === 'object'
            ? manifest.exports[subpath]
            : undefined;
        if (!sameExport(actual, expected)) {
            throw new TypertAnalysisError(`typert(${artifact.face}): ${artifact.package} must export ${subpath} as ${JSON.stringify(expected)}`);
        }
        const files = Array.isArray(manifest.files) ? manifest.files : [];
        for (const file of [`lib/typert.${artifact.face}.js`, `lib/typert.${artifact.face}.d.ts`]) {
            if (!files.includes(file)) {
                throw new TypertAnalysisError(`typert(${artifact.face}): ${artifact.package} package files must include ${file}`);
            }
        }
        if (artifact.face !== 'host')
            return;
        const remoteExpected = {
            types: './lib/typert.remote-client.d.ts',
            default: './lib/typert.remote-client.js',
        };
        const remoteActual = manifest.exports !== null && typeof manifest.exports === 'object'
            ? manifest.exports['./remote']
            : undefined;
        // The declaration map is emitted beside these two but never published: it
        // serves editor navigation in the workspace, where the package link
        // resolves its source.
        const remoteFiles = [
            'lib/typert.remote-client.js',
            'lib/typert.remote-client.d.ts',
        ];
        if (artifact.remote === undefined) {
            if (remoteActual !== undefined || remoteFiles.some(file => files.includes(file))) {
                throw new TypertAnalysisError(`typert(host): ${artifact.package} publishes Remote artifacts but has no Remote methods`);
            }
            return;
        }
        if (!sameExport(remoteActual, remoteExpected)) {
            throw new TypertAnalysisError(`typert(host): ${artifact.package} must export ./remote as ${JSON.stringify(remoteExpected)}`);
        }
        for (const file of remoteFiles) {
            if (!files.includes(file)) {
                throw new TypertAnalysisError(`typert(host): ${artifact.package} package files must include ${file}`);
            }
        }
    }
}
function sameExport(actual, expected) {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual))
        return false;
    const value = actual;
    return value.types === expected.types && value.default === expected.default;
}
//# sourceMappingURL=workspace.js.map