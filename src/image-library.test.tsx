// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileBrowser } from "./file-browser";
import { FileWorkspace } from "./file-workspace";
import { matchesImage } from "./image-library";
import "./i18n";

const setPreferences = vi.hoisted(() => vi.fn());
const images = vi.hoisted(() => vi.fn());
const thumbnail = vi.hoisted(() => vi.fn());
const revealFile = vi.hoisted(() => vi.fn());
const previewImage = vi.hoisted(() => vi.fn());
vi.mock("./file-workspace-api", async (load) => ({
	...(await load<typeof import("./file-workspace-api")>()),
	fileWorkspace: {
		preferences: async () => ({ filtered: false, included: [], pins: [], sort: "name" }),
		setPreferences,
		images,
		thumbnail,
	},
}));
vi.mock("./api", () => ({
	api: {
		revealFile,
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
	setPreferences.mockReset().mockImplementation(async (_root, value) => value);
	images.mockReset().mockResolvedValue({
		images: [
			{ name: "one.png", path: "assets/one.png", format: "png", size: 100, modified: 1 },
			{ name: "logo.svg", path: "logo.svg", format: "svg", size: 100, modified: 1 },
		],
		limited: false,
	});
	revealFile.mockReset().mockResolvedValue(undefined);
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
	vi.restoreAllMocks();
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
	await act(async () => host.querySelector("textarea")!.focus());
	expect(host.querySelector('[data-testid="file-assets/one.png"]')?.classList.contains("selected")).toBe(
		true,
	);
	expect(host.querySelector('[data-testid="file-assets/one.png"]')?.getAttribute("aria-current")).toBe(
		"true",
	);
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
	const paths = [...host.querySelectorAll<HTMLButtonElement>(".library-image")].map(
		(tile) => tile.getAttribute("aria-label")!,
	);
	const tile = host.querySelector<HTMLButtonElement>(".library-image")!;
	await act(async () => tile.click());
	await flush();
	const dialog = document.querySelector<HTMLDialogElement>("dialog.library-lightbox")!;
	await act(async () => dialog.dispatchEvent(new Event("close")));
	expect(dialog.isConnected).toBe(true);
	expect(open).not.toHaveBeenCalled();
	await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="Plein écran"]')!.click());
	expect(dialog.classList.contains("fullscreen")).toBe(true);
	dialog.querySelector<HTMLButtonElement>('button[aria-label="Quitter le plein écran"]')!.focus();
	await act(async () =>
		dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
	);
	await flush();
	expect(document.activeElement).toBe(dialog.querySelector('button[aria-label="Fermer"]'));
	expect(previewImage).toHaveBeenLastCalledWith({ project: "/fixture", path: paths[1] });
	expect(dialog.querySelector("img")?.getAttribute("alt")).toBe(paths[1].split("/").pop());
	expect(dialog.classList.contains("fullscreen")).toBe(true);
	await act(async () =>
		dialog
			.querySelector('input[type="range"]')!
			.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
	);
	expect(dialog.querySelector("img")?.getAttribute("alt")).toBe(paths[1].split("/").pop());
	await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true })));
	await flush();
	expect(dialog.querySelector("img")?.getAttribute("alt")).toBe(paths[0].split("/").pop());
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
	const paths = [...host.querySelectorAll<HTMLButtonElement>(".library-image")].map(
		(tile) => tile.getAttribute("aria-label")!,
	);
	await act(async () => host.querySelector<HTMLButtonElement>(".library-image")!.click());
	await flush();
	const dialog = document.querySelector<HTMLDialogElement>("dialog.library-lightbox")!;
	expect(dialog.textContent).toContain("Cette image ne peut pas être affichée");
	await act(async () =>
		dialog.querySelector<HTMLButtonElement>('button[aria-label="Image suivante"]')!.click(),
	);
	await flush();
	expect(dialog.querySelector("img")?.getAttribute("alt")).toBe(paths[1].split("/").pop());
	expect(open).not.toHaveBeenCalled();
});

it("keeps a clicked folder visibly selected after focus leaves the tree", async () => {
	await render();
	const folder = host.querySelector<HTMLButtonElement>('[data-testid="file-assets"]')!;
	await act(async () => folder.click());
	await flush();
	await act(async () => host.querySelector("textarea")!.focus());
	expect(folder.classList.contains("selected")).toBe(true);
	const file = host.querySelector<HTMLButtonElement>('[data-testid="file-assets/one.png"]')!;
	await act(async () => file.click());
	expect(file.classList.contains("selected")).toBe(true);
	expect(folder.classList.contains("selected")).toBe(false);
});
it("preserves numeric zoom and the ratio computed by Fit across next and previous images", async () => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1632);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(832);
	await render();
	await act(async () => button("Bibliothèque").click());
	await flush();
	await act(async () => host.querySelector<HTMLButtonElement>(".library-image")!.click());
	await flush();
	const dialog = document.querySelector<HTMLDialogElement>("dialog.library-lightbox")!;
	const load = async (width: number, height: number) => {
		const img = dialog.querySelector("img")!;
		Object.defineProperties(img, {
			naturalWidth: { value: width, configurable: true },
			naturalHeight: { value: height, configurable: true },
		});
		await act(async () => img.dispatchEvent(new Event("load")));
		return img;
	};
	await load(800, 400);
	await setValue(dialog.querySelector<HTMLInputElement>('input[type="range"]')!, "50");
	await setValue(dialog.querySelector<HTMLSelectElement>(".image-background-select")!, "checkerboard");
	await act(async () =>
		dialog.querySelector<HTMLButtonElement>('button[aria-label="Image suivante"]')!.click(),
	);
	await flush();
	expect((await load(1000, 500)).style.width).toBe("500px");
	expect(dialog.querySelector<HTMLSelectElement>(".image-background-select")?.value).toBe("checkerboard");
	await act(async () =>
		[...dialog.querySelectorAll<HTMLButtonElement>("button")]
			.find((b) => b.textContent === "Adapter")!
			.click(),
	);
	expect(dialog.querySelector("img")?.style.width).toBe("1600px");
	await act(async () =>
		dialog.querySelector<HTMLButtonElement>('button[aria-label="Image précédente"]')!.click(),
	);
	await flush();
	expect((await load(800, 400)).style.width).toBe("1280px");
	expect(dialog.querySelector(".visual-zoom-value")?.textContent).toBe("160 %");
});

it("revealing an already open file clears a selection in another root", async () => {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<FileBrowser root="/first" onOpen={() => {}} />
				<FileBrowser root="/second" selected="assets/one.png" onOpen={() => {}} />
			</QueryClientProvider>,
		),
	);
	await flush();
	await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="file-assets"]')!.click());
	await flush();
	await act(async () =>
		window.dispatchEvent(
			new CustomEvent("boa:reveal-file", { detail: { root: "/second", path: "assets/one.png" } }),
		),
	);
	await flush();
	expect(host.querySelectorAll(".tree-row.selected")).toHaveLength(1);
	expect(host.querySelector(".tree-row.selected")?.getAttribute("data-testid")).toBe("file-assets/one.png");
});

it("loads batches or all metadata and preserves all after refresh", async () => {
	const entries = Array.from({ length: 97 }, (_, index) => ({
		name: `image-${index}.png`,
		path: `assets/image-${index}.png`,
		format: "png",
		size: 10,
		modified: 1,
	}));
	images.mockResolvedValue({ images: entries, limited: false });
	await render();
	await act(async () => button("Bibliothèque").click());
	await flush();
	const cards = () => host.querySelectorAll(".library-card").length;
	const more = () => host.querySelector<HTMLButtonElement>(".library-more")!;
	expect(cards()).toBe(48);
	await act(async () => more().click());
	expect(cards()).toBe(96);
	await act(async () => button("Tout charger").click());
	expect(cards()).toBe(entries.length);
	expect(more()).toBeNull();
	const added = { ...entries[0], name: "added.png", path: "assets/added.png" };
	images.mockResolvedValue({ images: [...entries, added], limited: false });
	await act(async () =>
		host.querySelector<HTMLButtonElement>('button[aria-label="Actualiser les images"]')!.click(),
	);
	await flush();
	expect(cards()).toBe(entries.length + 1);
	expect(thumbnail).not.toHaveBeenCalled();
}, 2000);

it("resets all-image pagination on filters and scope changes", async () => {
	const entries = Array.from({ length: 49 }, (_, index) => ({
		name: `image-${index}.png`,
		path: `assets/image-${index}.png`,
		format: "png",
		size: 10,
		modified: 1,
	}));
	images.mockResolvedValue({ images: entries, limited: false });
	await render();
	await act(async () => button("Bibliothèque").click());
	await flush();
	const cards = () => host.querySelectorAll(".library-card").length;
	await act(async () => button("Tout charger").click());
	await setValue(host.querySelector(".image-library input")!, "image");
	expect(cards()).toBe(48);
	await act(async () => button("Tout charger").click());
	await setValue(host.querySelector(".image-library select")!, "png");
	expect(cards()).toBe(48);
	await act(async () => button("Tout charger").click());
	await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="file-assets"]')!.click());
	await flush();
	expect(images).toHaveBeenLastCalledWith("/fixture", "assets");
	expect(cards()).toBe(48);
}, 2000);

it("clears the library search with its button or Escape while retaining focus and resetting pagination", async () => {
	const entries = Array.from({ length: 49 }, (_, index) => ({
		name: `image-${index}.png`,
		path: `image-${index}.png`,
		format: "png",
		size: 10,
		modified: 1,
	}));
	images.mockResolvedValue({ images: entries, limited: false });
	await render();
	await act(async () => button("Bibliothèque").click());
	await flush();
	const input = host.querySelector<HTMLInputElement>(".image-library input")!;
	await setValue(input, "image");
	await act(async () => button("Tout charger").click());
	await act(async () => host.querySelector<HTMLButtonElement>(".image-library .search-clear")!.click());
	expect(input.value).toBe("");
	expect(document.activeElement).toBe(input);
	expect(host.querySelectorAll(".library-card")).toHaveLength(48);
	await setValue(input, "missing");
	expect(host.querySelectorAll(".library-card")).toHaveLength(0);
	const escaped = vi.fn();
	document.body.addEventListener("keydown", escaped);
	await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
	expect(input.value).toBe("");
	expect(document.activeElement).toBe(input);
	expect(escaped).not.toHaveBeenCalled();
	document.body.removeEventListener("keydown", escaped);
	expect(host.querySelectorAll(".library-card")).toHaveLength(48);
}, 2000);

it("reveals the gallery image in Finder through mouse and keyboard context menus", async () => {
	const open = await render();
	await act(async () => button("Bibliothèque").click());
	await flush();
	const tile = host.querySelector<HTMLButtonElement>(".library-image")!;
	const path = tile.getAttribute("aria-label")!;
	const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
	await act(async () => tile.dispatchEvent(event));
	expect(event.defaultPrevented).toBe(true);
	const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
	const reveal = menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
	expect(reveal.textContent).toBe("Afficher dans Finder");
	await act(async () => reveal.click());
	expect(revealFile).toHaveBeenCalledWith("/fixture", path);
	expect(open).not.toHaveBeenCalled();
	expect(document.activeElement).toBe(tile);
	await act(async () =>
		tile.dispatchEvent(
			new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }),
		),
	);
	expect(document.querySelector('[role="menu"]')).not.toBeNull();
	await act(async () =>
		document.activeElement!.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
		),
	);
	expect(document.querySelector('[role="menu"]')).toBeNull();
	expect(document.activeElement).toBe(tile);
	await act(async () => tile.click());
	await flush();
	const dialog = document.querySelector<HTMLDialogElement>("dialog.library-lightbox")!;
	const viewport = dialog.querySelector<HTMLElement>(".image-viewport")!;
	await act(async () =>
		viewport.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
	);
	expect(dialog.querySelector('[role="menu"]')).not.toBeNull();
	await act(async () => dialog.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
	expect(revealFile).toHaveBeenLastCalledWith("/fixture", path);
	expect(dialog.isConnected).toBe(true);
});

it("shares persisted sorting with the tree, keeps filters and reports save failures", async () => {
	images.mockResolvedValue({
		images: [
			{ name: "a.png", path: "a.png", format: "png", size: 2, modified: 10, added: 20 },
			{ name: "z.png", path: "z.png", format: "png", size: 1, modified: 20, added: 10 },
		],
		limited: false,
	});
	await render();
	await act(async () => button("Bibliothèque").click());
	await flush();
	const select = host.querySelector<HTMLSelectElement>('.image-library select[aria-label="Trier par"]')!;
	const grid = () =>
		[...host.querySelectorAll(".library-image")].map((node) => node.getAttribute("aria-label"));
	await setValue(host.querySelector(".image-library input")!, "png");
	await setValue(select, "added-asc");
	await flush();
	expect(grid()).toEqual(["z.png", "a.png"]);
	expect(client.getQueryData(["file-preferences", "/fixture"])).toMatchObject({ sort: "added-asc" });
	await act(async () => button("Bibliothèque").click());
	await act(async () => button("Bibliothèque").click());
	expect(select.value).toBe("added-asc");
	expect(host.querySelector<HTMLInputElement>(".image-library input")!.value).toBe("png");
	setPreferences.mockRejectedValueOnce(new Error("save failed"));
	await setValue(select, "size");
	await flush();
	expect(grid()).toEqual(["z.png", "a.png"]);
	expect(host.querySelector('[role="alert"]')?.textContent).toContain("save failed");
});

it("prevents tree and library preferences from overwriting each other during saves", async () => {
	let finish!: () => void;
	setPreferences.mockImplementation(
		(_root, value) =>
			new Promise((resolve) => {
				finish = () => resolve(value);
			}),
	);
	await render();
	await act(async () =>
		host.querySelector<HTMLButtonElement>('button[aria-label="Visibilité et tri"]')!.click(),
	);
	await act(async () => button("Bibliothèque").click());
	await flush();
	const treeSort = host.querySelector<HTMLSelectElement>(".file-browser-options select")!;
	const librarySort = host.querySelector<HTMLSelectElement>('.image-library select[aria-label="Trier par"]')!;
	await setValue(librarySort, "added");
	await flush();
	expect(treeSort.disabled).toBe(true);
	await setValue(treeSort, "created");
	expect(setPreferences).toHaveBeenCalledTimes(1);
	await act(async () => finish());
	await flush();
	expect(treeSort.value).toBe("added");
	await setValue(treeSort, "size");
	await flush();
	expect(librarySort.disabled).toBe(true);
	await setValue(librarySort, "name");
	expect(setPreferences).toHaveBeenCalledTimes(2);
	await act(async () => finish());
	await flush();
	expect(librarySort.value).toBe("size");
	expect(client.getQueryData(["file-preferences", "/fixture"])).toMatchObject({ sort: "size" });
});
