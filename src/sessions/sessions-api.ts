/** Typed boundary to the native sessions service (same service as `boa sessions` / `boa actions`). */
import { invoke } from "@tauri-apps/api/core";

export type Provider = "codex" | "claude";
export type SessionState = "working" | "awaitingInput" | "idle" | "inactive" | "failed" | "unknown";
export type StateEvidence =
	| "codexDaemon"
	| "codexHistoryOnly"
	| "claudeLiveProcess"
	| "claudeNoProcess"
	| "boaOwned"
	| "unavailable";
export type SessionKey = { provider: Provider; id: string };
export type Capability = { available: boolean; reason?: string };
export type Capabilities = {
	rename: Capability;
	send: Capability;
	resume: Capability;
	openInApp: Capability;
	terminal: Capability;
};
export type SessionSummary = {
	key: SessionKey;
	title: string;
	project: string | null;
	cwd: string;
	recordedBranch: string | null;
	createdAt: number | null;
	updatedAt: number | null;
	state: SessionState;
	evidence: StateEvidence;
	capabilities: Capabilities;
	pinned: boolean;
};
export type Listing = {
	discoveryEnabled: boolean;
	sessions: SessionSummary[];
	pinnedCount: number;
	totalCount: number;
	truncated: boolean;
	issues: { provider: Provider; code: string }[];
};
export type ListQuery = {
	scope: "pinned" | "all";
	search?: string;
	provider?: Provider;
	project?: string;
	state?: SessionState;
};
export type ProviderStatus = { provider: Provider; available: boolean; reason?: string; live: boolean };
export type SessionsSettings = {
	revision: number;
	discoveryEnabled: boolean;
	discoveryProviders: { codex: boolean; claude: boolean };
	autoPinNew: boolean;
	providers: ProviderStatus[];
	storeRecovered: boolean;
};
export type ConversationEntry = { role: "user" | "agent" | "tool"; text: string; at?: number };
export type SendReceipt =
	| { status: "started"; turnId: string | null }
	| { status: "steered"; turnId: string }
	| { status: "queuedByProvider"; submissionId: string }
	| { status: "accepted"; messageId: string }
	| { status: "unknown" };
export type CreatedSession = {
	session: SessionKey;
	receipt: SendReceipt;
	titleWarning?: "title_unconfirmed";
};
export type BranchOption = { name: string; worktree: string | null };
export type SessionBranch = {
	current: string | null;
	detached: boolean;
	options: BranchOption[];
	pending: {
		target: string;
		previous: string | null;
		requestedAt: number;
		status: "awaiting" | "unconfirmed";
	} | null;
	sharedWith: SessionKey[];
};
export type ActionMode = "prepare" | "send";
export type ActionDef = {
	id: string;
	label: string;
	template: string;
	mode: ActionMode;
	providers: Provider[];
	enabled: boolean;
};
export type ResolvedAction = ActionDef & { origin: "global" | "overridden" | "project" };
export type ActionsView = { revision: number; project: string | null; actions: ResolvedAction[] };
export type OpenReceipt = { url: string; handler: string; requested: boolean; displayConfirmed: boolean };
/** Short prompt from a BOA-driven Claude session. */
export type PermissionRequest = { sessionId: string; requestId: string; toolName: string; summary: string };

/** Typed failure from the native service; `code` is stable and localized by the UI. */
export class SessionsError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

async function call<T>(request: Record<string, unknown>): Promise<T> {
	try {
		return await invoke<T>("sessions", { request });
	} catch (error) {
		if (error && typeof error === "object" && "code" in error)
			throw new SessionsError(
				String((error as { code: unknown }).code),
				String((error as { message?: unknown }).message ?? ""),
			);
		throw new SessionsError("generic", String(error));
	}
}

export const keyId = (key: SessionKey): string => `${key.provider}:${key.id}`;
export const sameKey = (a: SessionKey | null | undefined, b: SessionKey | null | undefined): boolean =>
	!!a && !!b && a.provider === b.provider && a.id === b.id;

export const sessionsApi = {
	settings: () => call<SessionsSettings>({ action: "settings" }),
	setDiscovery: (enabled: boolean, revision?: number) =>
		call<SessionsSettings>({ action: "setDiscovery", enabled, revision }),
	setAutoPin: (enabled: boolean, revision?: number) =>
		call<SessionsSettings>({ action: "setAutoPin", enabled, revision }),
	list: (query: ListQuery) => call<Listing>({ action: "list", query }),
	conversation: (session: SessionKey, limit = 60) =>
		call<ConversationEntry[]>({ action: "conversation", session, limit }),
	pin: (session: SessionKey, pinned: boolean) =>
		call<{ changed: boolean }>({ action: pinned ? "pin" : "unpin", session }),
	rename: (session: SessionKey, title: string) => call<SessionSummary>({ action: "rename", session, title }),
	send: (session: SessionKey, text: string) => call<SendReceipt>({ action: "send", session, text }),
	create: (provider: Provider, project: string, text: string, title?: string) =>
		call<CreatedSession>({ action: "create", provider, project, text, title }),
	resume: (session: SessionKey) => call<{ resumed: boolean }>({ action: "resume", session }),
	openInApp: (session: SessionKey) => call<OpenReceipt>({ action: "openInApp", session }),
	branch: (session: SessionKey) => call<SessionBranch>({ action: "branch", session }),
	requestBranch: (session: SessionKey, target: string) =>
		call<SendReceipt>({ action: "requestBranch", session, target }),
	clearBranchRequest: (session: SessionKey) =>
		call<{ cleared: boolean }>({ action: "clearBranchRequest", session }),
	permission: (session: SessionKey, requestId: string, allow: boolean) =>
		call<{ answered: boolean }>({ action: "permission", session, requestId, allow }),
	/** Returns the app-only snapshot for a webview that may have missed earlier events. */
	pendingPermissions: () => invoke<PermissionRequest[]>("sessions_pending_permissions"),
	/** `attachOnly`: restore a view onto a running PTY; the backend never starts one then. */
	openTerminal: (session: SessionKey, cols: number, rows: number, attachOnly = false) =>
		call<{ terminalId: string; running: boolean; snapshot: string; snapshotEnd: number }>({
			action: "openTerminal",
			session,
			cols,
			rows,
			attachOnly,
		}),
	terminalWrite: (terminalId: string, data: string) =>
		call<unknown>({ action: "terminalWrite", terminalId, data }),
	terminalResize: (terminalId: string, cols: number, rows: number) =>
		call<unknown>({ action: "terminalResize", terminalId, cols, rows }),
	closeTerminal: (terminalId: string) => call<unknown>({ action: "closeTerminal", terminalId }),
	/** BOA terminals still running, including those whose tab was closed. */
	terminals: () =>
		call<{ terminals: { terminalId: string; session: SessionKey }[] }>({ action: "terminals" }).then(
			(result) => result.terminals,
		),
	startCodexDaemon: () => call<ProviderStatus[]>({ action: "startCodexDaemon" }),
	actions: (project?: string | null) =>
		call<ActionsView>({ action: "actions", project: project ?? undefined }),
	replaceActions: (project: string | null, actions: ActionDef[], revision: number) =>
		call<{ revision: number }>({
			action: "changeActions",
			revision,
			change: { change: "replace", project: project ?? undefined, actions },
		}),
	resetActions: (project: string, revision: number) =>
		call<{ revision: number }>({ action: "changeActions", revision, change: { change: "reset", project } }),
	renderAction: (session: SessionKey, actionId: string, file?: string, selection?: string) =>
		call<{ text: string; mode: ActionMode }>({ action: "renderAction", session, actionId, file, selection }),
};
