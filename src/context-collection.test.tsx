// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContextCollectionProvider, useContextCollection } from "./context-collection";
import { collectionApi } from "./context-collection-api";
import { emptyCollection } from "./context-collection-model";
import { WindowCloseGuard } from "./window-close";
import "./i18n";

vi.mock("./context-collection-api", () => ({
	collectionApi: { load: vi.fn(), save: vi.fn(), export: vi.fn() },
}));
const close = vi.hoisted(() => ({
	listener: null as null | ((event: { preventDefault: () => void }) => void),
}));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		onCloseRequested: (listener: typeof close.listener) => {
			close.listener = listener;
			return Promise.resolve(() => {});
		},
	}),
}));
let c: NonNullable<ReturnType<typeof useContextCollection>>;
function Probe() {
	c = useContextCollection()!;
	return null;
}
let host: HTMLDivElement, root: Root;
beforeEach(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	vi.mocked(collectionApi.load).mockReset().mockResolvedValue(null);
	vi.mocked(collectionApi.save).mockReset().mockResolvedValue(undefined);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.restoreAllMocks();
});
async function render() {
	await act(async () =>
		root.render(
			<ContextCollectionProvider>
				<Probe />
				<WindowCloseGuard />
			</ContextCollectionProvider>,
		),
	);
}
const context = (path: string) => ({
	project: "/project",
	path,
	code: "selected text",
	startLine: 2,
	endLine: 3,
	label: "Working tree",
});

it("serializes saves, coalesces edits and restores text and multiple image annotations after remount", async () => {
	let release!: () => void;
	vi.mocked(collectionApi.save).mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	await render();
	await act(async () => c.addText(context("a.ts"), "First", false));
	await act(async () => {
		c.addText(context("b.ts"), "Second", true);
		const image = {
			project: "/assets",
			path: "one.png",
			sourceKey: "one",
			dataUrl: "data:image/png;base64,AAAA",
			width: 800,
			height: 400,
		};
		c.addImage(image, { id: "pin-a", point: { x: 0.2, y: 0.3 }, message: "One" });
		c.addImage(image, { id: "pin-b", point: null, message: "Two" });
		c.addImage(
			{ ...image, path: "two.png", sourceKey: "two" },
			{ id: "pin-c", point: { x: 0.8, y: 0.7 }, message: "Three" },
		);
	});
	expect(collectionApi.save).toHaveBeenCalledTimes(1);
	expect(c.draft.items).toHaveLength(4);
	expect(c.draft.items[2].kind === "image" && c.draft.items[2].annotations).toHaveLength(2);
	const blocked = vi.fn();
	const unload = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(unload);
	expect(unload.defaultPrevented).toBe(true);
	// Native close also blocks when the current revision has not reached disk.
	await act(async () => close.listener?.({ preventDefault: blocked }));
	expect(blocked).toHaveBeenCalled();
	await act(async () => release());
	expect(collectionApi.save).toHaveBeenCalledTimes(2);
	expect(c.saving).toBe(false);
	const saved = structuredClone(c.draft);
	vi.mocked(collectionApi.load).mockResolvedValue(saved);
	await act(async () => root.unmount());
	root = createRoot(host);
	await render();
	expect(c.draft).toEqual(saved);
	expect(collectionApi.save).toHaveBeenCalledTimes(2);
});

it("retains the current draft on save failure, exposes retry and protects it until saved", async () => {
	await render();
	vi.mocked(collectionApi.save).mockRejectedValueOnce(new Error("Disk full"));
	await act(async () => c.addText(context("a.ts"), "Retain me", false));
	expect(c.error).toBe("Error: Disk full");
	expect(c.draft.items).toHaveLength(1);
	const blocked = vi.fn();
	await act(async () => close.listener?.({ preventDefault: blocked }));
	expect(blocked).toHaveBeenCalledOnce();
	await act(async () => c.retry());
	expect(c.error).toBe("");
	expect(c.draft.items).toHaveLength(1);
	const event = new Event("beforeunload", { cancelable: true });
	window.dispatchEvent(event);
	expect(event.defaultPrevented).toBe(false);
	blocked.mockClear();
	await act(async () => close.listener?.({ preventDefault: blocked }));
	expect(blocked).not.toHaveBeenCalled();
});

it("does not overwrite an invalid restored draft and can reload after repair", async () => {
	vi.mocked(collectionApi.load).mockResolvedValue({ ...emptyCollection(), items: [{ kind: "unknown" }] });
	await render();
	expect(c.ready).toBe(false);
	expect(c.loadError).toBe(true);
	expect(() => c.addText(context("a.ts"), "Blocked", false)).toThrow();
	expect(collectionApi.save).not.toHaveBeenCalled();
	vi.mocked(collectionApi.load).mockResolvedValue(emptyCollection());
	await act(async () => c.retry());
	expect(c.ready).toBe(true);
	expect(c.error).toBe("");
});
