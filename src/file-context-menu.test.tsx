// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { FileBrowser } from "./file-browser";
import { FileContextMenu, type FileMenuTarget } from "./file-context-menu";
import { defaultPreferences, fileWorkspace } from "./file-workspace-api";
import { consumeImageAction, requestImageAction } from "./image-actions";
import "./i18n";

vi.mock("./api", () => ({ api: { directory: vi.fn(), revealFile: vi.fn(), openFile: vi.fn() } }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("./file-workspace-api", async (original) => ({
	...(await original<typeof import("./file-workspace-api")>()),
	fileWorkspace: { preferences: vi.fn(), setPreferences: vi.fn() },
}));
const image = {
	name: "image.png",
	path: "images/image.png",
	directory: false,
	symlink: false,
	repository: false,
};
const folder = { ...image, name: "images", path: "images", directory: true };
let host: HTMLDivElement, root: Root, client: QueryClient;
beforeEach(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	vi.mocked(api.directory).mockResolvedValue([image, folder]);
	vi.mocked(fileWorkspace.preferences).mockResolvedValue(defaultPreferences);
	vi.mocked(api.revealFile).mockResolvedValue();
	vi.mocked(writeText).mockResolvedValue();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	host.remove();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});
const item = (name: string) =>
	[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
		(button) => button.textContent === name,
	)!;
async function browser() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<FileBrowser root="/project" onOpen={() => {}} />
			</QueryClientProvider>,
		),
	);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}
it("replaces the native row menu, selects the row, calls Finder and restores keyboard focus", async () => {
	await browser();
	const row = host.querySelector<HTMLButtonElement>('[data-testid="file-images/image.png"]')!;
	const context = new MouseEvent("contextmenu", {
		bubbles: true,
		cancelable: true,
		clientX: 9999,
		clientY: 9999,
	});
	await act(async () => row.dispatchEvent(context));
	expect(context.defaultPrevented).toBe(true);
	expect(row.classList.contains("selected")).toBe(true);
	expect(item("Comparer deux images")).toBeDefined();
	expect(item("Images de ce dossier")).toBeUndefined();
	const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
	expect(Number.parseFloat(menu.style.left)).toBeLessThan(window.innerWidth);
	await act(async () =>
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
	);
	expect(document.activeElement).toBe(item("Ouvrir avec l’application par défaut"));
	await act(async () =>
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })),
	);
	await act(async () =>
		document.activeElement!.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
		),
	);
	expect(api.revealFile).toHaveBeenCalledWith("/project", image.path);
	expect(document.querySelector('[role="menu"]')).toBeNull();
	expect(document.activeElement).toBe(row);
	await act(async () =>
		row.dispatchEvent(
			new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }),
		),
	);
	expect(document.activeElement).toBe(item("Afficher dans Finder"));
	await act(async () =>
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
	);
	expect(document.activeElement).toBe(item("Partager le contexte"));
	await act(async () =>
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
	);
	expect(document.querySelector('[role="menu"]')).toBeNull();
	expect(document.activeElement).toBe(row);
});
it("copies exact paths, distinguishes folder actions, and closes on outside pointer", async () => {
	await browser();
	const row = host.querySelector<HTMLButtonElement>('[data-testid="file-images"]')!;
	await act(async () =>
		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
	);
	expect(item("Rechercher dans ce dossier")).toBeDefined();
	expect(item("Ouvrir avec l’application par défaut")).toBeUndefined();
	await act(async () => item("Copier le chemin complet").click());
	expect(writeText).toHaveBeenCalledWith("/project/images");
	await act(async () =>
		row.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true })),
	);
	await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
	expect(document.querySelector('[role="menu"]')).toBeNull();
});
it("shares a path-only context through the existing composer without copying before confirmation", async () => {
	await browser();
	const row = host.querySelector<HTMLButtonElement>('[data-testid="file-images/image.png"]')!;
	await act(async () =>
		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
	);
	await act(async () => item("Partager le contexte").click());
	expect(document.querySelector('[data-testid="context-popover"]')).not.toBeNull();
	expect(document.querySelector('[data-testid="context-popover"]')!.textContent).toContain(image.path);
	expect(writeText).not.toHaveBeenCalled();
});
it("requests image actions before opening their target", async () => {
	const trigger = document.createElement("button");
	host.append(trigger);
	let action: string | null = null;
	const open = () => {
		action = consumeImageAction("/project", image.path);
	};
	const target: FileMenuTarget = { entry: image, trigger, x: 20, y: 20, open };
	await act(async () =>
		root.render(
			<FileContextMenu
				project="/project"
				target={target}
				pinned={false}
				busy={false}
				onPin={() => {}}
				onSearch={() => {}}
				onShare={() => {}}
				onClose={() => {}}
				onError={() => {}}
			/>,
		),
	);
	await act(async () => item("Plein écran").click());
	expect(action).toBe("fullscreen");
	await act(async () => item("Comparer deux images").click());
	expect(action).toBe("compare");
});
it("bounds image requests to one matching target and expires them after ten seconds", () => {
	const now = vi.spyOn(Date, "now").mockReturnValue(1000);
	requestImageAction("project", "one.png", "compare");
	expect(consumeImageAction("project", "other.png")).toBeNull();
	expect(consumeImageAction("project", "one.png")).toBe("compare");
	expect(consumeImageAction("project", "one.png")).toBeNull();
	requestImageAction("project", "one.png", "fullscreen");
	now.mockReturnValue(11_000);
	expect(consumeImageAction("project", "one.png")).toBeNull();
});

it("ignores a delayed pinned menu when another row was selected", async () => {
	vi.mocked(fileWorkspace.preferences).mockResolvedValue({ ...defaultPreferences, pins: [image.path] });
	await browser();
	let resolve!: (entries: (typeof image)[]) => void;
	vi.mocked(api.directory).mockReturnValueOnce(
		new Promise((r) => {
			resolve = r;
		}),
	);
	await act(async () =>
		host
			.querySelector(".tree-pin-open")!
			.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
	);
	const row = host.querySelector('[data-testid="file-images"]')!;
	await act(async () =>
		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
	);
	expect(item("Rechercher dans ce dossier")).toBeDefined();
	await act(async () => resolve([image]));
	expect(item("Rechercher dans ce dossier")).toBeDefined();
	expect(item("Désépingler")).toBeUndefined();
	await act(async () =>
		document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
	);
	vi.mocked(api.directory).mockReturnValueOnce(
		new Promise((r) => {
			resolve = r;
		}),
	);
	await act(async () =>
		host
			.querySelector(".tree-pin-open")!
			.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
	);
	await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
	await act(async () => resolve([image]));
	expect(document.querySelector('[role="menu"]')).toBeNull();
});
