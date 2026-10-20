// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileBrowser } from "./file-browser";
import { ProjectView } from "./project-view";
import "./i18n";

const search = vi.hoisted(() => vi.fn());
const readerRender = vi.hoisted(() => vi.fn());
vi.mock("./file-workspace-api", async (original) => ({
	...(await original<typeof import("./file-workspace-api")>()),
	fileWorkspace: {
		preferences: async () => ({ filtered: false, included: [], pins: [], sort: "name" }),
		search,
	},
}));
vi.mock("./file-tree", () => ({
	FileTree: () => (
		<button type="button" data-testid="tree-row">
			demo.md
		</button>
	),
}));
vi.mock("./code-viewer", () => ({
	CodeViewer: () => {
		readerRender();
		return <textarea aria-label="editor" />;
	},
	disposeReaderModel: () => {},
}));
vi.mock("./file-editing", () => ({ useFileEditing: () => ({ drafts: {}, draft: () => undefined }) }));
vi.mock("./git-panel", () => ({ GitPanel: () => null }));
let host: HTMLDivElement, root: Root, client: QueryClient;
beforeEach(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	localStorage.clear();
	readerRender.mockClear();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	search.mockReset().mockResolvedValue({
		matches: [{ project: "/fixture", path: "demo.md", line: 0, directory: false, text: "" }],
		limited: false,
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	host.remove();
});
async function render(element: React.ReactNode) {
	await act(async () => {
		root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
	});
	await act(async () => {
		await new Promise((r) => setTimeout(r, 20));
	});
}
it("opens a live path filter on typing, preserves the first character and returns to the same tree on Escape", async () => {
	const open = vi.fn();
	await render(<FileBrowser root="/fixture" onOpen={open} />);
	const row = host.querySelector<HTMLElement>('[data-testid="tree-row"]')!;
	await act(async () => row.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true })));
	const input = host.querySelector<HTMLInputElement>(".file-search-panel input");
	expect(input).not.toBeNull();
	expect(input?.value).toBe("d");
	await act(async () => {
		await new Promise((r) => setTimeout(r, 250));
	});
	expect(search).toHaveBeenCalledWith(["/fixture"], "d", "paths");
	expect(host.querySelector('[data-testid="tree-row"]')).toBe(row);
	await act(async () => input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
	expect(host.querySelector(".file-search-panel")).toBeNull();
	expect(host.querySelector("[data-file-browser]")).toBe(document.activeElement);
	expect(host.querySelector('[data-testid="tree-row"]')).toBe(row);
});
it("keeps reopening available after collapse and removes the project search icon", async () => {
	await render(
		<ProjectView
			project={{ path: "/fixture", name: "Fixture" } as never}
			pending={false}
			onRefresh={() => {}}
			navigation={null}
		/>,
	);
	expect(host.querySelector('[data-testid="toggle-project-search"]')).toBeNull();
	const toggle = host.querySelector<HTMLButtonElement>('[data-testid="toggle-file-tree"]')!;
	const row = host.querySelector('[data-testid="tree-row"]');
	const readerRenders = readerRender.mock.calls.length;
	await act(async () => toggle.click());
	expect(readerRender.mock.calls.length).toBe(readerRenders);
	expect(host.querySelector('[data-testid="tree-row"]')).toBe(row);
	expect(host.querySelector(".collapsed .pane-heading")?.children.length).toBe(1);
	expect(host.querySelector('[data-testid="toggle-file-tree"]')).toBe(toggle);
	expect(toggle.getAttribute("aria-expanded")).toBe("false");
	await act(async () => toggle.click());
	expect(host.querySelector("[data-file-browser]")).not.toBeNull();
	expect(host.querySelector('[data-testid="tree-row"]')).toBe(row);
	expect(readerRender.mock.calls.length).toBe(readerRenders);
	const editor = host.querySelector("textarea")!;
	await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true })));
	expect(host.querySelector(".file-search-panel")).toBeNull();
});
