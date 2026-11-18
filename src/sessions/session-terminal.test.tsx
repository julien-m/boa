// @vitest-environment happy-dom
/** Terminal view wiring: snapshot attached to the offset stream, live output, clean target switch. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTerminal } from "./session-terminal";
import { type SessionKey, sessionsApi } from "./sessions-api";
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

// xterm needs a real canvas/layout; the fake records what the view writes to the screen.
const screens = vi.hoisted(() => [] as { text: string; disposed: boolean }[]);
vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		cols = 80;
		rows = 24;
		private screen = { text: "", disposed: false };
		constructor() {
			screens.push(this.screen);
		}
		loadAddon() {}
		open() {}
		focus() {}
		onData() {
			return { dispose() {} };
		}
		write(data: Uint8Array | string) {
			this.screen.text += typeof data === "string" ? data : new TextDecoder().decode(data);
		}
		dispose() {
			this.screen.disposed = true;
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
	return {
		...actual,
		sessionsApi: {
			openTerminal: vi.fn(),
			terminalWrite: vi.fn(),
			terminalResize: vi.fn(),
			closeTerminal: vi.fn(),
		},
	};
});

const base64 = (text: string) => btoa(text);
const encodedLength = (text: string) => new TextEncoder().encode(text).length;
function output(key: SessionKey, terminalId: string, offset: number, text: string) {
	return {
		event: "output",
		terminalId,
		provider: key.provider,
		sessionId: key.id,
		offset,
		data: base64(text),
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
type Opened = { terminalId: string; running: boolean; snapshot: string; snapshotEnd: number };

let host: HTMLDivElement;
let root: Root;
const claude: SessionKey = { provider: "claude", id: "c1" };
const codex: SessionKey = { provider: "codex", id: "x1" };
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

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
	screens.length = 0;
	events.clear();
	vi.mocked(sessionsApi.openTerminal).mockReset();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
});

describe("session terminal view", () => {
	it("shows the snapshot, output racing the open request, and live output afterwards", async () => {
		const snapshot = "claude> ready\r\n";
		const end = encodedLength(snapshot);
		const opened = deferred<Opened>();
		vi.mocked(sessionsApi.openTerminal).mockReturnValue(opened.promise);
		await act(async () => root.render(<SessionTerminal sessionKey={claude} />));
		await settle();
		// Emitted while the open request is in flight: half inside the snapshot, half after it.
		await act(async () => emit("boa:terminal", output(claude, "t1", end - 2, "\r\nracing ")));
		await act(async () =>
			opened.resolve({ terminalId: "t1", running: true, snapshot: base64(snapshot), snapshotEnd: end }),
		);
		await settle();
		await act(async () => emit("boa:terminal", output(claude, "t1", end + 8, "live")));
		expect(screens[0]?.text).toBe(`${snapshot}racing live`);
		expect(host.textContent).not.toMatch(/terminé|ended|exited/i);
	});

	it("keeps an exit that happened while opening", async () => {
		const opened = deferred<Opened>();
		vi.mocked(sessionsApi.openTerminal).mockReturnValue(opened.promise);
		await act(async () => root.render(<SessionTerminal sessionKey={claude} />));
		await settle();
		await act(async () =>
			emit("boa:terminal", { event: "exit", terminalId: "t1", provider: "claude", sessionId: "c1", end: 3 }),
		);
		await act(async () =>
			opened.resolve({ terminalId: "t1", running: true, snapshot: base64("bye"), snapshotEnd: 3 }),
		);
		await settle();
		expect(screens[0]?.text).toBe("bye");
		expect(host.querySelector(".session-actions-row")).toBeNull();
	});

	it("does not leak the previous target's terminal, output or exit after switching", async () => {
		vi.mocked(sessionsApi.openTerminal)
			.mockResolvedValueOnce({ terminalId: "t1", running: false, snapshot: base64("old"), snapshotEnd: 3 })
			.mockReturnValueOnce(new Promise(() => undefined));
		await act(async () => root.render(<SessionTerminal sessionKey={claude} />));
		await settle();
		expect(host.querySelector(".session-feedback")).not.toBeNull();
		await act(async () => root.render(<SessionTerminal sessionKey={codex} />));
		await settle();
		await act(async () => emit("boa:terminal", output(claude, "t1", 3, "stale")));
		expect(screens[0]?.disposed).toBe(true);
		expect(screens[1]?.text).toBe("");
		expect(host.querySelector(".session-feedback")).toBeNull();
		expect(host.querySelector(".session-actions-row")).toBeNull();
		expect(sessionsApi.openTerminal).toHaveBeenLastCalledWith(codex, 80, 24, false);
	});
});
