// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileBrowser } from "./file-browser";
import { FileWorkspace } from "./file-workspace";
import "./i18n";

const images = vi.hoisted(() => vi.fn());
const thumbnail = vi.hoisted(() => vi.fn());
vi.mock("./file-workspace-api", async (load) => ({
	...(await load<typeof import("./file-workspace-api")>()),
	fileWorkspace: {
		preferences: async () => ({ filtered: false, included: [], pins: [], sort: "name" }),
		images,
		thumbnail,
	},
}));
vi.mock("./api", () => ({
	api: {
		directory: async (_root: string, path: string) =>
			path === "assets"
				? [{ name: "one.png", path: "assets/one.png", directory: false }]
				: [{ name: "assets", path: "assets", directory: true }],
	},
}));
let host: HTMLDivElement, root: Root, client: QueryClient;
let observers: ((entries: { isIntersecting: boolean }[]) => void)[];
beforeEach(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	observers = [];
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(callback: (typeof observers)[number]) {
				observers.push(callback);
			}
			observe() {}
			disconnect() {}
		},
	);
	images.mockReset().mockResolvedValue({
		images: [
			{ name: "one.png", path: "assets/one.png", format: "png", size: 100, modified: 1 },
			{ name: "logo.svg", path: "logo.svg", format: "svg", size: 100, modified: 1 },
		],
		limited: false,
	});
	thumbnail.mockReset().mockResolvedValue("data:image/png;base64,fixture");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	host.remove();
	vi.unstubAllGlobals();
});
async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}
async function render(open = vi.fn()) {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<FileWorkspace
					libraryRoot="/fixture"
					onOpen={open}
					tree={<FileBrowser root="/fixture" onOpen={open} />}
				>
					<textarea defaultValue="draft" />
				</FileWorkspace>
			</QueryClientProvider>,
		),
	);
	await flush();
	return open;
}
const button = (name: string) =>
	[...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name)!;
async function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
			"value",
		)!.set!.call(element, value);
		element.dispatchEvent(
			new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
		);
	});
}
it("loads images only on opening, lazily loads thumbnails, filters format/name and preserves reader and filters", async () => {
	const open = await render();
	const reader = host.querySelector("textarea")!;
	expect(images).not.toHaveBeenCalled();
	await act(async () => button("Bibliothèque").click());
	await flush();
	expect(images).toHaveBeenCalledWith("/fixture", "");
	expect(host.querySelectorAll(".library-card")).toHaveLength(2);
	expect(thumbnail).not.toHaveBeenCalled();
	await act(async () => {
		for (const callback of observers) callback([{ isIntersecting: true }]);
	});
	await flush();
	expect(thumbnail).toHaveBeenCalledTimes(2);
	await setValue(host.querySelector(".image-library select")!, "png");
	expect(host.querySelectorAll(".library-card")).toHaveLength(1);
	await setValue(host.querySelector(".image-library input")!, "ONE");
	await act(async () => host.querySelector<HTMLButtonElement>(".library-image")!.click());
	expect(open).toHaveBeenCalledWith({ project: "/fixture", path: "assets/one.png" });
	expect(host.querySelector(".workspace-reader")?.hasAttribute("hidden")).toBe(false);
	expect(host.querySelector("textarea")).toBe(reader);
	expect(reader.value).toBe("draft");
	await act(async () => button("Bibliothèque").click());
	expect(host.querySelector<HTMLInputElement>(".image-library input")?.value).toBe("ONE");
	expect(host.querySelectorAll(".library-card")).toHaveLength(1);
});
it("opens a folder-scoped library and reveals its image in the tree, reopening a collapsed sidebar", async () => {
	const open = await render();
	await act(async () =>
		host.querySelector<HTMLButtonElement>('button[aria-label="Images de ce dossier : assets"]')!.click(),
	);
	await flush();
	expect(images).toHaveBeenCalledWith("/fixture", "assets");
	await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="toggle-file-tree"]')!.click());
	await act(async () =>
		host
			.querySelector<HTMLButtonElement>(
				'button[aria-label="Retrouver dans l’arborescence : assets/one.png"]',
			)!
			.click(),
	);
	await flush();
	expect(open).toHaveBeenCalledWith({ project: "/fixture", path: "assets/one.png" });
	expect(host.querySelector('[data-testid="toggle-file-tree"]')?.getAttribute("aria-expanded")).toBe("true");
	expect(host.querySelector('[data-testid="file-assets/one.png"]')).toBe(document.activeElement);
});
it("keeps failed thumbnail cards actionable and displays a partial-list notice", async () => {
	images.mockResolvedValue({
		images: [{ name: "broken.png", path: "broken.png", format: "png", size: 10, modified: 1 }],
		limited: true,
	});
	thumbnail.mockRejectedValue("decode failed");
	const open = await render();
	await act(async () => button("Bibliothèque").click());
	await flush();
	await act(async () => {
		for (const callback of observers) callback([{ isIntersecting: true }]);
	});
	await flush();
	expect(host.textContent).toContain("Liste partielle");
	expect(host.textContent).toContain("Miniature indisponible");
	await act(async () => host.querySelector<HTMLButtonElement>(".library-image")!.click());
	expect(open).toHaveBeenCalledWith({ project: "/fixture", path: "broken.png" });
});
