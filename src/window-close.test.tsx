// @vitest-environment happy-dom
/** Native close permissions and the combined unsaved-draft boundary. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import capability from "../src-tauri/capabilities/default.json";
import { api } from "./api";
import { ContextCollectionProvider, useContextCollection } from "./context-collection";
import { collectionApi } from "./context-collection-api";
import { FileEditingProvider, useFileEditing } from "./file-editing";
import { WindowCloseGuard } from "./window-close";
import "./i18n";

const native = vi.hoisted(() => ({
	listeners: new Set<(event: Event) => void | Promise<void>>(),
	destroy: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		onCloseRequested: async (handler: (event: Event) => void) => {
			native.listeners.add(handler);
			return () => native.listeners.delete(handler);
		},
	}),
}));
vi.mock("./api", () => ({ api: { saveFile: vi.fn() } }));
vi.mock("./context-collection-api", () => ({
	collectionApi: { load: vi.fn(), save: vi.fn(), export: vi.fn() },
}));
let collection: NonNullable<ReturnType<typeof useContextCollection>>;
let editing: ReturnType<typeof useFileEditing>;
function Probe() {
	collection = useContextCollection()!;
	editing = useFileEditing();
	return null;
}
let host: HTMLDivElement, root: Root;
beforeEach(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	native.listeners.clear();
	native.destroy.mockClear();
	vi.mocked(collectionApi.load).mockReset().mockResolvedValue(null);
	vi.mocked(collectionApi.save).mockReset().mockResolvedValue(undefined);
	vi.mocked(api.saveFile).mockReset().mockResolvedValue(undefined);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	expect(native.listeners.size).toBe(0);
	host.remove();
});
async function mount() {
	await act(async () =>
		root.render(
			<StrictMode>
				<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
					<FileEditingProvider>
						<ContextCollectionProvider>
							<Probe />
							<WindowCloseGuard />
						</ContextCollectionProvider>
					</FileEditingProvider>
				</QueryClientProvider>
			</StrictMode>,
		),
	);
	expect(native.listeners.size).toBe(1);
}
async function requestClose() {
	await act(async () => {
		// Match Tauri's independent per-listener default destruction, rather than sharing a veto.
		for (const listener of [...native.listeners]) {
			const event = new Event("native-close", { cancelable: true });
			await listener(event);
			if (!event.defaultPrevented) native.destroy();
		}
	});
}

it("allows Tauri's close-request handler to destroy the main window", () => {
	expect(capability.windows).toEqual(["main"]);
	expect(capability.permissions).toContain("core:window:allow-destroy");
});

it("lets each draft owner veto closure independently until both are safe", async () => {
	let release!: () => void;
	vi.mocked(collectionApi.save).mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	await mount();
	await act(async () => editing.start("/project", "note.txt", "original"));
	await act(async () => editing.change("/project", "note.txt", "unsaved"));
	await requestClose();
	expect(native.destroy).not.toHaveBeenCalled();
	expect(host.querySelector('[role="alert"]')).not.toBeNull();
	await act(async () =>
		collection.addText(
			{ project: "/project", path: "note.txt", code: "source", startLine: 1, endLine: 1, label: "source" },
			"Keep context",
			false,
		),
	);
	await requestClose();
	expect(native.destroy).not.toHaveBeenCalled();
	await act(async () => editing.cancel("/project", "note.txt"));
	await requestClose();
	expect(native.destroy).not.toHaveBeenCalled();
	expect(collection.draft.items).toHaveLength(1);
	await act(async () => release());
	await requestClose();
	expect(native.destroy).toHaveBeenCalledTimes(1);
});

it("allows clean closure but protects an in-flight file save", async () => {
	await mount();
	await requestClose();
	expect(native.destroy).toHaveBeenCalledTimes(1);
	native.destroy.mockClear();
	let release!: () => void;
	vi.mocked(api.saveFile).mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	await act(async () => editing.start("/project", "note.txt", "original"));
	await act(async () => editing.change("/project", "note.txt", "changed"));
	let saved!: Promise<void>;
	await act(async () => {
		saved = editing.save("/project", "note.txt");
	});
	await requestClose();
	expect(native.destroy).not.toHaveBeenCalled();
	await act(async () => {
		release();
		await saved;
	});
	await requestClose();
	expect(native.destroy).toHaveBeenCalledTimes(1);
});
