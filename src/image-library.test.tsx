// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileBrowser } from "./file-browser";
import { FileWorkspace } from "./file-workspace";
import { matchesImage } from "./image-library";
import "./i18n";

const images = vi.hoisted(() => vi.fn());
const thumbnail = vi.hoisted(() => vi.fn());
const previewImage = vi.hoisted(() => vi.fn());
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
		preview: previewImage,
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
	previewImage.mockReset().mockResolvedValue({
		kind: "image",
		dataUrl: "data:image/png;base64,preview",
		original: "",
		modified: "",
		label: "Image",
	});
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
	await flush();
	expect(open).not.toHaveBeenCalled();
	expect(document.querySelector("dialog.library-lightbox")?.hasAttribute("open")).toBe(true);
	await act(async () =>
		document.querySelector<HTMLButtonElement>('dialog button[aria-label="Ouvrir dans Fichiers"]')!.click(),
	);
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
	await flush();
	await act(async () =>
		document.querySelector<HTMLButtonElement>('dialog button[aria-label="Ouvrir dans Fichiers"]')!.click(),
	);
	expect(open).toHaveBeenCalledWith({ project: "/fixture", path: "broken.png" });
});

it("matches all search words separated by spaces or plus, ignoring accents and case", () => {
	expect(matchesImage("projects/ylune/assets/logo.png", "lune + LOGO")).toBe(true);
	expect(matchesImage("projects/ylune/assets/logo.png", "LÛNE logo")).toBe(true);
	expect(matchesImage("projects/ylune/assets/logo.png", "lune banner")).toBe(false);
	expect(matchesImage("projects/ylune/assets/logo.png", " +  ")).toBe(true);
});
it("follows folder selection and supports breadcrumb navigation without leaving the library", async () => {
	await render();
	await act(async () => button("Bibliothèque").click());
	await flush();
	await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="file-assets"]')!.click());
	await flush();
	expect(images).toHaveBeenLastCalledWith("/fixture", "assets");
	expect(host.querySelector(".workspace-library")?.hasAttribute("hidden")).toBe(false);
	await act(async () => host.querySelector<HTMLButtonElement>(".library-breadcrumbs button")!.click());
	await flush();
	expect(host.querySelector(".library-breadcrumbs")?.textContent).not.toContain("assets");
	expect(host.querySelector(".workspace-library")?.hasAttribute("hidden")).toBe(false);
});
it("browses filtered images with buttons and arrows, keeps fullscreen and restores the grid on Escape", async () => {
	const open = await render();
	await act(async () => button("Bibliothèque").click());
	await flush();
	const tile = host.querySelector<HTMLButtonElement>(".library-image")!;
	await act(async () => tile.click());
	await flush();
	const dialog = document.querySelector<HTMLDialogElement>("dialog.library-lightbox")!;
	await act(async () => dialog.dispatchEvent(new Event("close")));
	expect(dialog.isConnected).toBe(true);
	expect(open).not.toHaveBeenCalled();
	await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="Plein écran"]')!.click());
	expect(dialog.classList.contains("fullscreen")).toBe(true);
	await act(async () =>
		dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
	);
	await flush();
	expect(previewImage).toHaveBeenLastCalledWith({ project: "/fixture", path: "logo.svg" });
	expect(dialog.querySelector("img")?.getAttribute("alt")).toBe("logo.svg");
	expect(dialog.classList.contains("fullscreen")).toBe(true);
	await act(async () =>
		dialog
			.querySelector('input[type="range"]')!
			.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
	);
	expect(dialog.querySelector("img")?.getAttribute("alt")).toBe("logo.svg");
	await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true })));
	await flush();
	expect(dialog.querySelector("img")?.getAttribute("alt")).toBe("one.png");
	await act(async () => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
	expect(document.querySelector("dialog.library-lightbox")).toBeNull();
	expect(document.activeElement).toBe(tile);
	expect(host.querySelectorAll(".library-card")).toHaveLength(2);
});

it("keeps image navigation available after a preview failure", async () => {
	previewImage.mockRejectedValueOnce("read failed");
	const open = await render();
	await act(async () => button("Bibliothèque").click());
	await flush();
	await act(async () => host.querySelector<HTMLButtonElement>(".library-image")!.click());
	await flush();
	const dialog = document.querySelector<HTMLDialogElement>("dialog.library-lightbox")!;
	expect(dialog.textContent).toContain("Cette image ne peut pas être affichée");
	await act(async () =>
		dialog.querySelector<HTMLButtonElement>('button[aria-label="Image suivante"]')!.click(),
	);
	await flush();
	expect(dialog.querySelector("img")?.getAttribute("alt")).toBe("logo.svg");
	expect(open).not.toHaveBeenCalled();
});
