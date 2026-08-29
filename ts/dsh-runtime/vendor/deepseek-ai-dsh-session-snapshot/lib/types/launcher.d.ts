/**
 * Shared launcher for ACP tests that drive an agent subprocess over JSON-RPC
 * stdio. It owns source-or-built launch resolution, workspace environment,
 * stdout tee, SDK client, update collection, permission fallback, and process
 * shutdown so e2e and snapshot suites do not each reconstruct that boundary.
 *
 * @module @deepseek-ai/dsh-session-snapshot/launcher
 */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { type CancelNotification, type CloseSessionRequest, type CloseSessionResponse, type InitializeRequest, type InitializeResponse, type ListSessionsRequest, type ListSessionsResponse, type NewSessionRequest, type NewSessionResponse, type PromptRequest, type PromptResponse, type RequestPermissionRequest, type RequestPermissionResponse, type ResumeSessionRequest, type ResumeSessionResponse, type SetSessionConfigOptionRequest, type SetSessionConfigOptionResponse, type SessionNotification } from '@agentclientprotocol/sdk';
/** The source/built entry, profile patch, and workspace tsconfig an ACP test boots. */
export interface AgentUnderTest {
    /** The source bin entry; product suites use `apps/cli/src/bin.ts`. */
    binScript: string;
    /** Explicit built-mode entry for fixtures whose source path is not under `src/`. */
    libBinScript?: string | undefined;
    /** Base config or profile patch loaded by the bin. */
    configPath: string;
    /** Named dsh profile; omitted only for test-only fake bins with their own config grammar. */
    profile?: string;
    /** The repo tsconfig whose paths resolve unbuilt workspace imports. */
    tsconfigPath: string;
}
/** Options for one ACP test subprocess. */
export interface AcpTestLaunchOptions {
    /** The agent composition to boot. */
    agent: AgentUnderTest;
    /** Process cwd and default session-home root. */
    cwd: string;
    /** Alternate leaf config for this launch. */
    configPath?: string;
    /** Extra environment values layered over the parent environment. */
    env?: NodeJS.ProcessEnv;
    /** Permission handler; omitted requests fail closed as `cancelled`. */
    requestPermission?: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}
/** Stable ACP methods used by the subprocess test harness. */
export interface AcpTestClient {
    readonly closed: Promise<void>;
    initialize: (params: InitializeRequest) => Promise<InitializeResponse>;
    newSession: (params: NewSessionRequest) => Promise<NewSessionResponse>;
    listSessions: (params: ListSessionsRequest) => Promise<ListSessionsResponse>;
    resumeSession: (params: ResumeSessionRequest) => Promise<ResumeSessionResponse>;
    closeSession: (params: CloseSessionRequest) => Promise<CloseSessionResponse>;
    setSessionConfigOption: (params: SetSessionConfigOptionRequest) => Promise<SetSessionConfigOptionResponse>;
    prompt: (params: PromptRequest) => Promise<PromptResponse>;
    cancel: (params: CancelNotification) => Promise<void>;
}
/** A running ACP test process and its captured client-side outputs. */
export interface LaunchedAcpTestAgent {
    /** The child process, exposed for process-level assertions. */
    child: ChildProcessWithoutNullStreams;
    /** Resolve when the OS spawns the child; reject with its asynchronous spawn failure. */
    spawned: Promise<void>;
    /** The SDK connection backed by the child's stdio. */
    client: AcpTestClient;
    /** Session updates in receive order. */
    updates: SessionNotification['update'][];
    /** Decode all stdout bytes captured so far. */
    rawStdout(): string;
    /** Decode all stderr chunks captured so far. */
    stderr(): string;
    /** Resolve when a future session update matches the predicate. */
    waitForUpdate(match: (update: SessionNotification['update']) => boolean): Promise<SessionNotification['update']>;
    /** Close the process and drain its streams and callbacks; rejects promptly if fallback termination is refused. */
    close(signal?: NodeJS.Signals): Promise<void>;
}
/**
 * Boot an ACP agent subprocess and connect an SDK client to its stdio.
 *
 * @param options Agent paths, cwd, environment, and optional permission handler.
 * @returns The running process, connected client, captures, and shutdown handle.
 */
export declare function launchAcpTestAgent(options: AcpTestLaunchOptions): LaunchedAcpTestAgent;
/**
 * Copy one authored patch into the launch cwd with relative plugin names made absolute.
 * @param source - authored profile patch path.
 * @param cwd - isolated process cwd whose profile fallback receives package links.
 * @param targetDir - existing directory that owns the materialized patch.
 * @param index - stable patch ordinal used in the output filename.
 * @returns absolute materialized patch path.
 */
export declare function materializeProfilePatch(source: string, cwd: string, targetDir: string, index: number): string;
//# sourceMappingURL=launcher.d.ts.map