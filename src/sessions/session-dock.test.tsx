// @vitest-environment happy-dom
/** Dock v2: session tabs, closing without stopping, background terminals, safe conversation, table sort. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDock } from "./session-dock";
import { migrateDock, SessionDockProvider, useSessionDock } from "./session-dock-state";
import {
	type ConversationEntry,
	type PermissionRequest,
	type SessionSummary,
	sessionsApi,
} from "./sessions-api";
import { SessionsView } from "./sessions-view";
import "../i18n";

type EventHandler = (event: { payload: unknown }) => void;
const listeners = vi.hoisted(() => new Map<string, Set<EventHandler>>());
vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, handler: EventHandler) => {
		const handlers = listeners.get(name) ?? new Set<EventHandler>();
		handlers.add(handler);
		listeners.set(name, handlers);
		return () => handlers.delete(handler);
	},
}));
function sessionEvent(payload: unknown) {
	for (const handler of listeners.get("boa:session-event") ?? []) handler({ payload });
}
const clipboard = vi.hoisted(() => ({ writeText: vi.fn(async (_text: string) => undefined) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => clipboard);
vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		cols = 80;
		rows = 24;
		loadAddon() {}
		open() {}
		focus() {}
		write() {}
		dispose() {}
		onData() {
			return { dispose() {} };
		}
	},
}));
vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit() {}
	},
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("./sessions-api", async (original) => {
	const actual = await original<typeof import("./sessions-api")>();
	const api = Object.fromEntries(
		[
			"list",
			"terminals",
			"branch",
			"actions",
			"conversation",
			"settings",
			"openTerminal",
			"send",
			"pin",
			"permission",
			"pendingPermissions",
			"rename",
			"closeTerminal",
		].map((name) => [name, vi.fn()]),
	);
	return { ...actual, sessionsApi: api };
});

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
	const yes = { available: true };
	return {
		key: { provider: "claude", id },
		title: `Session ${id}`,
		project: "/p",
		cwd: "/p",
		recordedBranch: "dev",
		createdAt: 1,
		updatedAt: 2,
		state: "idle",
		evidence: "claudeNoProcess",
		capabilities: { rename: yes, send: yes, resume: yes, openInApp: { available: false }, terminal: yes },
		pinned: true,
		...overrides,
	};
}

let host: HTMLDivElement;
let root: Root;
let dock: ReturnType<typeof useSessionDock>;
let catalog: SessionSummary[];
let running: { terminalId: string; session: { provider: "claude" | "codex"; id: string } }[];
let conversation: ConversationEntry[];
function Probe() {
	dock = useSessionDock();
	return null;
}
const settle = () => act(async () => new Promise((done) => setTimeout(done, 20)));
async function render(children: ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<SessionDockProvider>
					<Probe />
					{children}
				</SessionDockProvider>
			</QueryClientProvider>,
		),
	);
	await settle();
}
const tabs = () => [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
const button = (name: string) =>
	[...host.querySelectorAll("button")].find(
		(item) => item.textContent?.includes(name) || item.ariaLabel === name,
	);

beforeEach(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	Reflect.set(
		globalThis,
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	// happy-dom lacks the Popover API; menus only need it to open and close.
	for (const method of ["showPopover", "hidePopover", "togglePopover"])
		if (!(method in HTMLElement.prototype)) Reflect.set(HTMLElement.prototype, method, () => undefined);
	localStorage.clear();
	catalog = [summary("a"), summary("b", { state: "awaitingInput" }), summary("c")];
	running = [];
	conversation = [];
	const api = vi.mocked(sessionsApi);
	api.list.mockImplementation(async () => ({
		discoveryEnabled: true,
		sessions: catalog,
		pinnedCount: catalog.length,
		totalCount: catalog.length,
		truncated: false,
		issues: [],
	}));
	api.terminals.mockImplementation(async () => running);
	api.branch.mockResolvedValue({
		current: "dev",
		detached: false,
		options: [],
		pending: null,
		sharedWith: [],
	});
	api.actions.mockResolvedValue({ revision: 1, project: "/p", actions: [] });
	api.conversation.mockImplementation(async () => conversation);
	api.openTerminal.mockReturnValue(new Promise(() => undefined));
	api.openTerminal.mockClear();
	api.pendingPermissions.mockReset().mockResolvedValue([]);
	api.rename.mockReset();
	api.closeTerminal.mockReset().mockResolvedValue({ closed: true });
	clipboard.writeText.mockClear();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
});

describe("dock storage migration", () => {
	it("turns a v1 dock (current + recent) into tabs and keeps drafts and window flags", () => {
		const migrated = migrateDock({
			current: { provider: "codex", id: "x" },
			recent: [
				{ provider: "claude", id: "y" },
				{ provider: "codex", id: "x" },
				{ provider: "evil", id: "z" },
			],
			open: true,
			collapsed: true,
			detached: false,
			drafts: { "codex:x": "brouillon", bad: 3 },
		});
		expect(migrated.tabs).toEqual([
			{ provider: "codex", id: "x" },
			{ provider: "claude", id: "y" },
		]);
		expect(migrated.current).toEqual({ provider: "codex", id: "x" });
		expect(migrated.drafts).toEqual({ "codex:x": "brouillon" });
		expect(migrated).toMatchObject({ version: 2, open: true, collapsed: true, views: {} });
		expect(migrateDock("garbage").tabs).toEqual([]);
	});
});

describe("session tabs", () => {
	it("opens each session once, closes a tab without losing its draft or view", async () => {
		await render(<SessionDock projects={[{ path: "/p", name: "Cedar" }]} />);
		await act(async () => dock.show(catalog[0].key));
		await act(async () => dock.show(catalog[1].key));
		await act(async () => dock.show(catalog[0].key));
		await settle();
		expect(tabs()).toEqual(["Session aDisponible", "Session bAttend votre réponse"]);
		expect(host.querySelector('[aria-selected="true"]')?.textContent).toBe("Session aDisponible");
		await act(async () => dock.setDraft(catalog[0].key, "à garder"));
		await act(async () => dock.setView(catalog[0].key, "terminal"));
		await act(async () =>
			(host.querySelector('[data-testid="close-session-tab-a"]') as HTMLButtonElement).click(),
		);
		expect(tabs()).toEqual(["Session bAttend votre réponse"]);
		expect(dock.current).toEqual(catalog[1].key);
		expect(dock.draftFor(catalog[0].key)).toBe("à garder");
		expect(dock.viewFor(catalog[0].key)).toBe("terminal");
		// Reopened: draft and remembered view come back, a single tab again.
		await act(async () => dock.show(catalog[0].key));
		await settle();
		expect(tabs()).toHaveLength(2);
		expect(button("Terminal")?.getAttribute("aria-pressed")).toBe("true");
	});

	it("moves between tabs with the arrow keys and closes with Delete", async () => {
		await render(<SessionDock projects={[]} />);
		for (const item of catalog) await act(async () => dock.show(item.key));
		await settle();
		const selected = () => host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
		await act(async () =>
			selected()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })),
		);
		expect(dock.current).toEqual(catalog[0].key);
		await act(async () =>
			selected()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
		);
		expect(dock.current).toEqual(catalog[2].key);
		await act(async () =>
			selected()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })),
		);
		expect(dock.tabs).toHaveLength(2);
		expect(dock.current).toEqual(catalog[1].key);
	});

	it("keeps a background terminal one click away after the last tab closes", async () => {
		running = [{ terminalId: "t-a", session: catalog[0].key }];
		await render(<SessionDock projects={[]} />);
		await act(async () => dock.show(catalog[0].key));
		await settle();
		await act(async () =>
			(host.querySelector('[data-testid="close-session-tab-a"]') as HTMLButtonElement).click(),
		);
		await settle();
		expect(dock.tabs).toEqual([]);
		expect(host.querySelector('[data-testid="session-dock"]')).not.toBeNull();
		const reopen = button("Terminal de Session a");
		expect(reopen).toBeDefined();
		await act(async () => reopen?.click());
		await settle();
		expect(tabs()).toEqual(["Session aDisponible"]);
		expect(dock.viewFor(catalog[0].key)).toBe("terminal");
		// Restored from the registry: attach only, never a new start.
		expect(sessionsApi.openTerminal).toHaveBeenCalledWith(catalog[0].key, 80, 24, true);
	});

	it("leaves no dock at all when the last tab closes and no terminal runs", async () => {
		await render(<SessionDock projects={[]} />);
		await act(async () => dock.show(catalog[1].key));
		await settle();
		expect(host.querySelector('[data-testid="session-dock"]')).not.toBeNull();
		await act(async () => dock.closeTab(catalog[1].key));
		await settle();
		expect(host.querySelector('[data-testid="session-dock"]')).toBeNull();
	});
});

describe("dock invariants", () => {
	it("brings a pending permission into a new dock and clears both views when it is answered", async () => {
		await render(<SessionDock projects={[]} />);
		const primary = () => dock.permissions;
		const session = catalog[0].key;
		const prompt = { sessionId: session.id, requestId: "pending", toolName: "Read", summary: "notes.txt" };
		const other = { ...prompt, sessionId: catalog[1].key.id, summary: "private.txt" };
		const snapshot = vi.mocked(sessionsApi).pendingPermissions;
		snapshot.mockResolvedValue([prompt, other]);
		await act(async () => sessionEvent({ event: "permissionRequest", ...prompt }));
		await act(async () => dock.show(session));
		expect(primary()).toContainEqual(expect.objectContaining(prompt));
		const detachedHost = document.createElement("div");
		const detached = createRoot(detachedHost);
		vi.mocked(sessionsApi.permission).mockImplementationOnce(async () => {
			snapshot.mockResolvedValue([other]);
			sessionEvent({ event: "permissionResolved", sessionId: session.id, requestId: prompt.requestId });
			return { answered: true };
		});
		try {
			await act(async () =>
				detached.render(
					<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
						<SessionDockProvider>
							<SessionDock detachedWindow projects={[]} />
						</SessionDockProvider>
					</QueryClientProvider>,
				),
			);
			const promptText = () => detachedHost.querySelector(".session-permission")?.textContent ?? "";
			expect(promptText()).toContain(prompt.summary);
			expect(detachedHost.textContent).not.toContain(other.summary);
			const allow = [...detachedHost.querySelectorAll<HTMLButtonElement>(".session-permission button")].find(
				(element) => element.textContent === "Autoriser",
			);
			await act(async () => allow?.click());
			expect(sessionsApi.permission).toHaveBeenCalledWith(session, prompt.requestId, true);
			expect(promptText()).toBe("");
			expect(primary()).toEqual([other]);
			expect(localStorage.getItem("boa-session-dock")).not.toContain(prompt.summary);
		} finally {
			await act(async () => detached.unmount());
		}
	});

	it("does not revive a closed session's prompt from a delayed mount snapshot", async () => {
		const snapshot = vi.mocked(sessionsApi).pendingPermissions;
		const prompt = { sessionId: catalog[0].key.id, requestId: "closing", toolName: "Read", summary: "notes" };
		let finishSnapshot: (prompts: PermissionRequest[]) => void = () => undefined;
		snapshot.mockReturnValueOnce(
			new Promise((resolve) => {
				finishSnapshot = resolve;
			}),
		);
		await render(null);
		expect(snapshot).toHaveBeenCalledTimes(1);
		await act(async () => sessionEvent({ event: "sessionClosed", sessionId: prompt.sessionId }));
		expect(snapshot).toHaveBeenCalledTimes(2);
		await act(async () => finishSnapshot([prompt]));
		expect(dock.permissions).toEqual([]);
	});

	it("never applies a rename form opened on A to B after a tab switch", async () => {
		vi.mocked(sessionsApi.rename).mockImplementation(async (key, title) => ({ ...summary(key.id), title }));
		await render(<SessionDock projects={[]} />);
		await act(async () => dock.show(catalog[0].key));
		await act(async () => dock.show(catalog[1].key));
		await act(async () => dock.show(catalog[0].key));
		await settle();
		await act(async () => button("Renommer…")?.click());
		const field = () => host.querySelector<HTMLInputElement>('[aria-label="Nouveau titre"]');
		expect(field()?.value).toBe("Session a");
		await act(async () => {
			const input = field() as HTMLInputElement;
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Titre pour A");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => dock.show(catalog[1].key));
		// Switching tabs cancels A's form: B shows none, and nothing can rename B.
		expect(field()).toBeNull();
		await act(async () => dock.show(catalog[0].key));
		await settle();
		expect(field()).toBeNull();
		await act(async () => button("Renommer…")?.click());
		expect(field()?.value).toBe("Session a");
		await act(async () => field()?.form?.requestSubmit());
		expect(sessionsApi.rename).not.toHaveBeenCalled();
		await act(async () => {
			const input = field() as HTMLInputElement;
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Nouveau A");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => field()?.form?.requestSubmit());
		expect(sessionsApi.rename).toHaveBeenCalledTimes(1);
		expect(sessionsApi.rename).toHaveBeenCalledWith(catalog[0].key, "Nouveau A");
	});

	it("reaches and stops a running BOA terminal whose session is missing from the catalog", async () => {
		const ghost = { provider: "claude" as const, id: "ghost" };
		running = [{ terminalId: "t-ghost", session: ghost }];
		vi.mocked(sessionsApi.openTerminal).mockResolvedValue({
			terminalId: "t-ghost",
			running: true,
			snapshot: "",
			snapshotEnd: 0,
		});
		await render(<SessionDock projects={[]} />);
		await act(async () => dock.show(catalog[0].key));
		await act(async () => dock.closeTab(catalog[0].key));
		await settle();
		await act(async () => button("Terminal de ghost")?.click());
		await settle();
		expect(tabs()).toEqual(["ghost"]);
		expect(host.querySelector<HTMLButtonElement>('[data-testid="dock-view-terminal"]')?.disabled).toBe(false);
		expect(sessionsApi.openTerminal).toHaveBeenCalledWith(ghost, 80, 24, true);
		await act(async () => button("Arrêter le terminal")?.click());
		expect(sessionsApi.closeTerminal).toHaveBeenCalledWith("t-ghost");
		// Sending stays governed by the catalog: no composer without a known session.
		expect(host.querySelector('[aria-label="Message pour la session"]')).toBeNull();
	});

	it("restores the Terminal view without restarting a stopped PTY; Start is explicit", async () => {
		vi.mocked(sessionsApi.openTerminal).mockResolvedValue({
			terminalId: "t-a",
			running: true,
			snapshot: "",
			snapshotEnd: 0,
		});
		await render(<SessionDock projects={[]} />);
		await act(async () => dock.show(catalog[1].key));
		await act(async () => dock.show(catalog[0].key));
		await settle();
		await act(async () =>
			host.querySelector<HTMLButtonElement>('[data-testid="dock-view-terminal"]')?.click(),
		);
		await settle();
		expect(sessionsApi.openTerminal).toHaveBeenCalledTimes(1);
		expect(sessionsApi.openTerminal).toHaveBeenLastCalledWith(catalog[0].key, 80, 24, false);
		await act(async () => button("Arrêter le terminal")?.click());
		await settle();
		await act(async () => dock.show(catalog[1].key));
		await act(async () => dock.show(catalog[0].key));
		await settle();
		expect(dock.viewFor(catalog[0].key)).toBe("terminal");
		expect(host.querySelector('[data-testid="terminal-stopped"]')).not.toBeNull();
		expect(sessionsApi.openTerminal).toHaveBeenCalledTimes(1);
		await act(async () => button("Démarrer le terminal")?.click());
		await settle();
		expect(sessionsApi.openTerminal).toHaveBeenCalledTimes(2);
		expect(sessionsApi.openTerminal).toHaveBeenLastCalledWith(catalog[0].key, 80, 24, false);
	});
});

describe("conversation", () => {
	it("renders history as safe Markdown with copyable code and folded technical events", async () => {
		conversation = [
			{ role: "user", text: "Pourquoi ?", at: Date.UTC(2026, 10, 18, 11, 38) },
			{ role: "tool", text: "Read · plan-card.tsx" },
			{ role: "tool", text: "Read · pricing.ts" },
			{
				role: "agent",
				text: [
					"Un **double arrondi** :",
					"",
					'<img src="https://tracker.example/x.png" onerror="alert(1)"> <script>alert(2)</script>',
					"",
					"![pixel](https://tracker.example/p.png) [lien](javascript:alert(3))",
					"",
					"```ts",
					"export const x = 1;",
					"```",
				].join("\n"),
			},
		];
		await render(<SessionDock projects={[]} />);
		await act(async () => dock.show(catalog[0].key));
		await settle();
		const log = host.querySelector('[role="log"]') as HTMLElement;
		expect(log.textContent).toContain("Vous");
		expect(log.textContent).toContain("Claude Code");
		expect(log.querySelector("time")).not.toBeNull();
		expect(log.querySelector(".conversation-body strong")?.textContent).toBe("double arrondi");
		// Untrusted history: no element that loads, runs or navigates.
		expect(log.querySelector("img, script, a, iframe")).toBeNull();
		expect(log.innerHTML).not.toContain("onerror");
		expect(log.textContent).toContain("Image non chargée : pixel");
		const events = log.querySelector("details");
		expect(events?.open).toBe(false);
		expect(events?.querySelector("summary")?.textContent).toContain("2 actions techniques");
		expect(log.querySelector("figcaption")?.textContent).toContain("TypeScript");
		await act(async () => button("Copier")?.click());
		expect(clipboard.writeText).toHaveBeenCalledWith("export const x = 1;\n");
		expect(log.textContent).toContain("Copié");
	});
});

describe("sessions table", () => {
	it("sorts by clickable headers with aria-sort and keeps the choice", async () => {
		vi.mocked(sessionsApi.settings).mockResolvedValue({ discoveryEnabled: true, providers: [] } as never);
		catalog = [
			summary("old", { title: "Zèbre", updatedAt: 10, state: "awaitingInput" }),
			summary("new", { title: "abeille", updatedAt: 30 }),
		];
		await render(<SessionsView projects={[{ path: "/p", name: "Cedar" }]} />);
		const rows = () =>
			[...host.querySelectorAll<HTMLElement>('[data-testid^="session-row-"]')].map(
				(row) => row.dataset.testid,
			);
		const sortOf = (column: string) =>
			host
				.querySelector(`[data-testid="sort-${column}"]`)
				?.closest('[role="columnheader"]')
				?.getAttribute("aria-sort");
		expect(rows()).toEqual(["session-row-new", "session-row-old"]);
		expect(sortOf("activity")).toBe("descending");
		await act(async () => (host.querySelector('[data-testid="sort-title"]') as HTMLButtonElement).click());
		expect(sortOf("title")).toBe("ascending");
		expect(sortOf("activity")).toBe("none");
		expect(rows()).toEqual(["session-row-new", "session-row-old"]);
		await act(async () => (host.querySelector('[data-testid="sort-title"]') as HTMLButtonElement).click());
		expect(sortOf("title")).toBe("descending");
		expect(rows()).toEqual(["session-row-old", "session-row-new"]);
		await act(async () => (host.querySelector('[data-testid="sort-state"]') as HTMLButtonElement).click());
		expect(rows()).toEqual(["session-row-old", "session-row-new"]);
		expect(JSON.parse(localStorage.getItem("boa-session-sort") ?? "{}")).toEqual({
			column: "state",
			direction: "asc",
		});
	});
});
