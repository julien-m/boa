// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileSpaceAdd } from "./file-space-add";
import { fileWorkspace } from "./file-workspace-api";
import { i18n } from "./i18n";

vi.mock("./file-workspace-api", () => ({ fileWorkspace: { state: vi.fn(), addToSpace: vi.fn() } }));
let host: HTMLDivElement, root: Root, trigger: HTMLButtonElement, client: QueryClient;
const close = vi.fn();
const entry = {
	name: "logo.png",
	path: "images/logo.png",
	directory: false,
	symlink: false,
	repository: false,
	modified: 0,
};
beforeEach(async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	await i18n.changeLanguage("fr");
	vi.mocked(fileWorkspace.state).mockResolvedValue({
		spaces: [{ id: "design", name: "Design", roots: ["/assets"], files: [] }],
		shortcuts: { contextual: "Mod+F", global: "Mod+Shift+F" },
	});
	vi.mocked(fileWorkspace.addToSpace).mockResolvedValue({
		id: "created",
		name: "logo.png",
		roots: [],
		files: ["/project/images/logo.png"],
	});
	vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) {
		this.open = true;
	});
	vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) {
		this.open = false;
	});
	host = document.createElement("div");
	document.body.append(host);
	trigger = document.createElement("button");
	host.append(trigger);
	root = createRoot(host.appendChild(document.createElement("div")));
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	close.mockClear();
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	host.remove();
	vi.restoreAllMocks();
	vi.clearAllMocks();
	await i18n.changeLanguage("fr");
});
async function render() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<FileSpaceAdd
					project="/project"
					entry={entry}
					fullPath="/project/images/logo.png"
					trigger={trigger}
					onClose={close}
				/>
			</QueryClientProvider>,
		),
	);
	await act(async () => {
		await new Promise((r) => setTimeout(r, 20));
	});
}
async function submit() {
	await act(async () =>
		document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
	);
}
async function choose() {
	const select = document.querySelector("select")!;
	await act(async () => {
		select.value = "design";
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
}
it("creates with the proposed name and exact source without typing, then returns focus", async () => {
	await render();
	const inputs = document.querySelectorAll("input");
	expect(inputs[0].value).toBe("logo.png");
	expect(inputs[1].value).toBe("/project/images/logo.png");
	expect(inputs[1].readOnly).toBe(true);
	await submit();
	expect(fileWorkspace.addToSpace).toHaveBeenCalledWith({
		id: expect.any(String),
		name: "logo.png",
		root: "/project",
		path: "images/logo.png",
	});
	expect(close).toHaveBeenCalledOnce();
	await act(async () => root.render(null));
	expect(document.activeElement).toBe(trigger);
});
it("adds to an existing space and reports duplicates without replacing its contents", async () => {
	await render();
	await choose();
	await submit();
	expect(fileWorkspace.addToSpace).toHaveBeenCalledWith({
		id: "design",
		name: undefined,
		root: "/project",
		path: "images/logo.png",
	});
	client.setQueryData(["file-workspace"], {
		spaces: [{ id: "design", name: "Design", roots: ["/assets"], files: ["/project/images/logo.png"] }],
	});
	await act(async () => {
		await new Promise((r) => setTimeout(r, 20));
	});
	expect(document.querySelector('[role="status"]')?.textContent).toBe("Déjà ajouté à cet espace");
	expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
});
it("keeps a failed draft editable and translates the form to English", async () => {
	await i18n.changeLanguage("en");
	vi.mocked(fileWorkspace.addToSpace).mockRejectedValueOnce("Disk unavailable");
	await render();
	expect(document.querySelector("h2")?.textContent).toBe("Add to a file space…");
	await submit();
	expect(document.querySelector('[role="alert"]')?.textContent).toBe("Disk unavailable");
	expect(document.querySelector("input")?.value).toBe("logo.png");
	expect(close).not.toHaveBeenCalled();
	expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
});
