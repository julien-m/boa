// @vitest-environment happy-dom
/** Session cockpit UI invariants: target captured at click, compare-and-clear drafts, no BOA queue. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsEn, sessionsFr } from "../locales/sessions";
import { previewTemplate } from "./action-template";
import { SessionAttention } from "./session-attention";
import { SessionComposer } from "./session-composer";
import { SessionDockProvider, useSessionDock } from "./session-dock-state";
import { type SendReceipt, type SessionSummary, sessionsApi } from "./sessions-api";
import { groupByProject } from "./sessions-view";
import "../i18n";

type Handler = (event: { payload: unknown }) => void;
const events = vi.hoisted(() => new Map<string, Set<Handler>>());
vi.mock("@tauri-apps/api/event", () => ({
	listen: async (name: string, handler: Handler) => {
		const handlers = events.get(name) ?? new Set<Handler>();
		handlers.add(handler);
		events.set(name, handlers);
		return () => handlers.delete(handler);
	},
}));
const emit = (name: string, payload: unknown) => {
	for (const handler of events.get(name) ?? []) handler({ payload });
};
vi.mock("./sessions-api", async (original) => {
	const actual = await original<typeof import("./sessions-api")>();
	return {
		...actual,
		sessionsApi: { send: vi.fn(), renderAction: vi.fn(), actions: vi.fn(), list: vi.fn() },
	};
});

function summary(id: string, project = "/p"): SessionSummary {
	const yes = { available: true };
	return {
		key: { provider: "codex", id },
		title: `Session ${id}`,
		project,
		cwd: project,
		recordedBranch: "dev",
		createdAt: 1,
		updatedAt: 2,
		state: "working",
		evidence: "codexDaemon",
		capabilities: { rename: yes, send: yes, resume: yes, openInApp: yes, terminal: { available: false } },
		pinned: true,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

let host: HTMLDivElement;
let root: Root;
let dock: ReturnType<typeof useSessionDock>;
function Probe() {
	dock = useSessionDock();
	return null;
}
async function render(session: SessionSummary, client: QueryClient) {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<SessionDockProvider>
					<Probe />
					<SessionComposer session={session} projectName="p" branch="dev" />
				</SessionDockProvider>
			</QueryClientProvider>,
		),
	);
}

beforeEach(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	localStorage.clear();
	vi.mocked(sessionsApi.send).mockReset();
	vi.mocked(sessionsApi.renderAction).mockReset();
	vi.mocked(sessionsApi.actions)
		.mockReset()
		.mockResolvedValue({
			revision: 1,
			project: "/p",
			actions: [
				{
					id: "tests",
					label: "Tests",
					template: "t",
					mode: "send",
					providers: ["codex", "claude"],
					enabled: true,
					origin: "global",
				},
			],
		});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
});

describe("session composer", () => {
	it("sends an action rendered for session A to A even if the dock switched to B meanwhile", async () => {
		const client = new QueryClient();
		const rendered = deferred<{ text: string; mode: "send" }>();
		vi.mocked(sessionsApi.renderAction).mockReturnValue(rendered.promise);
		vi.mocked(sessionsApi.send).mockResolvedValue({ status: "started", turnId: "t" });
		await render(summary("a"), client);
		// React Query batches notifications on a timer; let the action list arrive.
		await act(async () => new Promise((done) => setTimeout(done, 20)));
		const button = [...host.querySelectorAll("button")].find((item) => item.textContent === "Tests");
		expect(button).toBeDefined();
		await act(async () => button?.click());
		expect(sessionsApi.renderAction).toHaveBeenCalledWith(
			{ provider: "codex", id: "a" },
			"tests",
			undefined,
			undefined,
		);
		await render(summary("b"), client);
		await act(async () => {
			rendered.resolve({ text: "run tests", mode: "send" });
			await new Promise((done) => setTimeout(done, 20));
		});
		expect(sessionsApi.send).toHaveBeenCalledWith({ provider: "codex", id: "a" }, "run tests");
	});

	it("clears only an unchanged draft after a confirmed receipt and keeps it on unknown results", async () => {
		const client = new QueryClient();
		const pending = deferred<SendReceipt>();
		vi.mocked(sessionsApi.send).mockReturnValue(pending.promise);
		await render(summary("a"), client);
		const key = { provider: "codex" as const, id: "a" };
		await act(async () => dock.setDraft(key, "hello"));
		await act(async () => host.querySelector("form")?.requestSubmit());
		await act(async () => dock.setDraft(key, "hello, edited"));
		await act(async () => pending.resolve({ status: "steered", turnId: "t" }));
		expect(dock.draftFor(key)).toBe("hello, edited");

		vi.mocked(sessionsApi.send).mockResolvedValueOnce({ status: "queuedByProvider", submissionId: "q" });
		await act(async () => host.querySelector("form")?.requestSubmit());
		expect(dock.draftFor(key)).toBe("");

		vi.mocked(sessionsApi.send).mockResolvedValueOnce({ status: "unknown" });
		await act(async () => dock.setDraft(key, "maybe"));
		await act(async () => host.querySelector("form")?.requestSubmit());
		expect(dock.draftFor(key)).toBe("maybe");
		expect(host.textContent).toContain(sessionsFr.composer.unknown);
	});

	it("always offers Send and never a BOA queue control", async () => {
		await render(summary("a"), new QueryClient());
		const labels = [...host.querySelectorAll("button")].map((button) => button.textContent ?? "");
		expect(labels).toContain(sessionsFr.composer.send);
		expect(labels.join(" ")).not.toMatch(/attente|file|queue/i);
		expect(JSON.stringify(sessionsFr)).not.toMatch(/Mettre en (file|attente)/);
		expect(JSON.stringify(sessionsEn)).not.toMatch(/Add to queue/i);
	});
});

describe("session helpers", () => {
	it("previews bilingual variables and keeps missing ones visible", () => {
		expect(
			previewTemplate("Sur {projet}, {branch} {{x}} {fichier}", { project: "cedar", branch: "dev" }),
		).toEqual({
			text: "Sur cedar, dev {x} {fichier}",
			missing: ["fichier"],
		});
	});

	it("groups sessions by registered project and puts unmatched ones last", () => {
		const groups = groupByProject(
			[summary("1", "/b"), summary("2", "/a"), { ...summary("3"), project: null }, summary("4", "/b")],
			[
				{ path: "/a", name: "Atlas" },
				{ path: "/b", name: "Cedar" },
			],
		);
		expect(groups.map((group) => [group.name, group.sessions.length])).toEqual([
			["Atlas", 1],
			["Cedar", 2],
			["", 1],
		]);
	});
});

describe("app-level dock state", () => {
	it("reattaches an orphaned detached dock at startup and keeps its drafts", async () => {
		localStorage.setItem(
			"boa-session-dock",
			JSON.stringify({
				current: { provider: "codex", id: "a" },
				recent: [],
				open: true,
				collapsed: false,
				detached: true,
				drafts: { "codex:a": "brouillon conservé" },
			}),
		);
		await act(async () =>
			root.render(
				<QueryClientProvider client={new QueryClient()}>
					<SessionDockProvider>
						<Probe />
					</SessionDockProvider>
				</QueryClientProvider>,
			),
		);
		await act(async () => new Promise((done) => setTimeout(done, 20)));
		expect(dock.detached).toBe(false);
		expect(dock.draftFor({ provider: "codex", id: "a" })).toBe("brouillon conservé");
	});

	it("signals a Claude permission prompt while the dock is closed and opens its session", async () => {
		await act(async () =>
			root.render(
				<QueryClientProvider client={new QueryClient()}>
					<SessionDockProvider>
						<Probe />
						<SessionAttention />
					</SessionDockProvider>
				</QueryClientProvider>,
			),
		);
		expect(host.querySelector('[data-testid="session-attention"]')).toBeNull();
		await act(async () =>
			emit("boa:session-event", {
				event: "permissionRequest",
				sessionId: "c9",
				requestId: "p1",
				toolName: "Bash",
				summary: "x",
			}),
		);
		const signal = host.querySelector<HTMLButtonElement>('[data-testid="session-attention"]');
		expect(signal?.textContent).toContain(sessionsFr.permissions.waiting_one);
		expect(signal?.textContent).not.toContain("Bash");
		await act(async () => signal?.click());
		expect(dock.current).toEqual({ provider: "claude", id: "c9" });
		expect(host.querySelector('[data-testid="session-attention"]')).toBeNull();
	});
});
