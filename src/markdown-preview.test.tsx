// @vitest-environment happy-dom
/** CLI-only regression coverage: simulated DOM, no browser or installed app. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeViewer } from "./code-viewer";
import "./i18n";
import { MarkdownPreview } from "./markdown-preview";
import type { Selection } from "./models";

const receiptState = vi.hoisted(() => ({ acknowledge: vi.fn(async () => ({})) }));
vi.mock("./context-api", () => ({ contextApi: receiptState }));
const editingState = vi.hoisted(() => ({ active: false }));
const assetState = vi.hoisted(() => ({
	kind: "text" as "text" | "image" | "unsupported",
	dataUrl: undefined as string | undefined,
	open: vi.fn(),
}));
const content =
	"# Intro\n\nFirst paragraph.\n\n## Purchase\n\n| Field | Type |\n| --- | --- |\n| id | UUID |\n| price | number |\n\nLast paragraph.\n\n```ts\nconst total = 1;\n```";
vi.mock("./api", () => ({
	api: {
		preview: async (selection: Selection) => ({
			original: "",
			modified: content,
			path: selection.path,
			label: "File",
			kind: assetState.kind,
			dataUrl: assetState.dataUrl,
		}),
		openFile: assetState.open,
	},
}));
vi.mock("./file-editing", () => ({
	useFileEditing: () => ({
		draft: () => (editingState.active ? { original: content, content, saving: false } : undefined),
	}),
}));
vi.mock("./context-bubbles", () => ({ ContextBubbles: () => null }));
vi.mock("./syntax-highlighting", () => ({}));
vi.mock("monaco-editor/basic-languages/monaco.contribution.js", () => ({}));
vi.mock("monaco-editor/editor/contrib/find/browser/findController.js", () => ({}));
vi.mock("monaco-editor/editor/editor.api.js", () => ({
	Uri: { from: () => ({ toString: () => "boa-file:/demo.md" }) },
}));
vi.mock("@monaco-editor/react", () => ({
	loader: { config: () => {} },
	Editor: ({ language }: { language: string }) => <div data-testid="mock-source" data-language={language} />,
	DiffEditor: ({ language }: { language: string }) => (
		<div data-testid="mock-diff" data-language={language} />
	),
}));

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
	editingState.active = false;
	receiptState.acknowledge.mockClear();
	assetState.kind = "text";
	assetState.dataUrl = undefined;
	assetState.open.mockReset().mockResolvedValue(undefined);
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	// A deterministic layout model lets us check scrolling without a browser.
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		const container = this.closest(".markdown-scroll");
		const top = this.dataset.sourceLine
			? Number(this.dataset.sourceLine) * 20 - (container?.scrollTop ?? 0)
			: 0;
		const height = this.classList.contains("markdown-scroll") ? 400 : 20;
		return {
			top,
			bottom: top + height,
			left: 0,
			right: 600,
			width: 600,
			height,
			x: 0,
			y: top,
			toJSON: () => ({}),
		};
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	host.remove();
	vi.restoreAllMocks();
});
async function render(element: React.ReactNode) {
	await act(async () => root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>));
	await act(async () => {
		await new Promise((done) => setTimeout(done, 10));
	});
}
const selected = () => [...host.querySelectorAll("[data-navigation-target]")];

describe("Markdown preview navigation", () => {
	it("opens manual and CLI Markdown in preview, preserving explicit Source and Git diffs", async () => {
		const selection: Selection = { project: "/fixture", path: "demo.MD" };
		await render(<CodeViewer selection={selection} />);
		expect(host.querySelector(".markdown-preview h1")?.textContent).toBe("Intro");
		await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="markdown-toggle"]')?.click());
		expect(host.querySelector('[data-testid="mock-source"]')).not.toBeNull();
		await render(<CodeViewer selection={{ ...selection, path: "other.markdown" }} />);
		await render(<CodeViewer selection={selection} />);
		expect(host.querySelector(".markdown-preview")).not.toBeNull();
		await render(<CodeViewer selection={{ ...selection, line: 9, endLine: 10, navigationId: "cli-1" }} />);
		expect(host.querySelector(".markdown-preview")).not.toBeNull();
		expect(selected().map((node) => node.textContent)).toEqual(["idUUID", "pricenumber"]);
		expect(host.querySelector(".markdown-scroll")?.scrollTop).toBeGreaterThan(0);
		editingState.active = true;
		await render(<CodeViewer selection={{ ...selection, line: 5, navigationId: "draft-navigation" }} />);
		expect(host.querySelector('[data-testid="mock-source"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="read-only-toggle"]')?.getAttribute("aria-pressed")).toBe("true");
		editingState.active = false;
		await render(<CodeViewer selection={{ ...selection, repo: "/fixture" }} />);
		expect(host.querySelector('[data-testid="mock-diff"]')).not.toBeNull();
	});

	it("keeps acknowledged Markdown in preview and confirms only a revealed highlighted block", async () => {
		const lines = content.split("\n");
		const line = lines.findIndex((text) => text.startsWith("| id")) + 1;
		const endLine = lines.findIndex((text) => text.startsWith("| price")) + 1;
		const receiptId = "markdown-receipt";
		await render(
			<CodeViewer
				selection={{
					project: "/fixture",
					path: "demo.md",
					line,
					endLine,
					receiptId,
					navigationId: receiptId,
				}}
			/>,
		);
		expect(host.querySelector('[data-testid="mock-source"]')).toBeNull();
		expect(selected().map((node) => node.textContent)).toEqual(["idUUID", "pricenumber"]);
		await act(async () => {
			await new Promise((done) => requestAnimationFrame(done));
		});
		expect(receiptState.acknowledge).toHaveBeenCalledWith(receiptId, "displayed");
		const nextReceipt = "single-line-receipt";
		const paragraphLine = lines.findIndex((text) => text === "First paragraph.") + 1;
		await render(
			<CodeViewer
				selection={{
					project: "/fixture",
					path: "demo.md",
					line: paragraphLine,
					endLine: paragraphLine,
					receiptId: nextReceipt,
					navigationId: nextReceipt,
				}}
			/>,
		);
		await act(async () => {
			await new Promise((done) => requestAnimationFrame(done));
		});
		expect(selected().map((node) => node.textContent)).toEqual(["First paragraph."]);
		expect(receiptState.acknowledge).toHaveBeenCalledWith(nextReceipt, "displayed");
	});

	it("moves from a front-matter separator to the requested source block in the same preview", async () => {
		const target = "Identify the available native tool before continuing.";
		const document = [
			"---",
			"name: sample",
			"description: A sample document",
			"---",
			"",
			"# Title",
			"",
			"## Prepare",
			"",
			`1. ${target}`,
			"2. Continue after inspection.",
		].join("\n");
		const line = document.split("\n").findIndex((text) => text.includes(target)) + 1;
		const preview = (line: number, navigationId: string) => (
			<MarkdownPreview
				content={document}
				project="/fixture"
				path="skill.md"
				onCopyLink={() => {}}
				navigation={{ line, endLine: line, navigationId }}
			/>
		);
		await render(preview(1, "without-coordinates"));
		expect(selected().map((node) => node.tagName)).toEqual(["HR"]);
		await render(preview(line, "with-coordinates"));
		expect(selected().map((node) => node.textContent)).toEqual([target]);
		expect(host.querySelector("hr")?.hasAttribute("data-navigation-target")).toBe(false);
	});

	it("reveals table rows, replaces highlights, handles repeat requests and falls back on invisible lines", async () => {
		const preview = (line: number, endLine: number, navigationId: string) => (
			<MarkdownPreview
				content={content}
				project="/fixture"
				path="demo.md"
				onCopyLink={() => {}}
				navigation={{ line, endLine, navigationId }}
			/>
		);
		await render(preview(9, 10, "one"));
		expect(selected().map((node) => node.tagName)).toEqual(["TR", "TR"]);
		const table = host.querySelector("table");
		expect(table?.parentElement?.className).toBe("markdown-table-scroll");
		expect(table?.parentElement?.getAttribute("tabindex")).toBe("0");
		expect(table?.getAttribute("data-source-line")).toBe("7");
		const scroll = host.querySelector<HTMLElement>(".markdown-scroll") as HTMLElement;
		expect(scroll.scrollTop).toBe(156);
		scroll.scrollTop = 0;
		await render(preview(9, 10, "two"));
		expect(scroll.scrollTop).toBe(156);
		await render(preview(5, 5, "three"));
		expect(selected().map((node) => node.textContent)).toEqual(["Purchase"]);
		await render(preview(8, 8, "separator"));
		expect(selected().map((node) => node.tagName)).toEqual(["TABLE"]);
		await render(preview(11, 11, "blank"));
		expect(selected().length).toBeGreaterThan(0);
		await render(preview(999, 999, "beyond-eof"));
		expect(selected().map((node) => node.tagName)).toEqual(["PRE"]);
		await render(
			<MarkdownPreview content={content} project="/fixture" path="demo.md" onCopyLink={() => {}} />,
		);
		expect(selected()).toEqual([]);
	});
	it("expands tables, code, diagram images and the whole document, then restores the reader and focus", async () => {
		const source =
			content + "\n\n```mermaid\ngraph TD; A-->B;\n```\n\n![Diagram](https://example.com/diagram.svg)";
		await render(
			<MarkdownPreview content={source} project="/fixture" path="demo.md" onCopyLink={() => {}} />,
		);
		const reader = host.querySelector<HTMLElement>(".markdown-scroll")!;
		reader.scrollTop = 160;
		const scroller = host.querySelector<HTMLElement>(".markdown-table-scroll")!;
		scroller.scrollLeft = 120;
		const table = scroller.querySelector("table");
		const buttons = [...host.querySelectorAll<HTMLButtonElement>(".markdown-expand-button")];
		expect(buttons).toHaveLength(5);
		for (const button of buttons) {
			await act(async () => button.click());
			const dialog = document.querySelector<HTMLDialogElement>("dialog.markdown-expanded")!;
			expect(dialog).not.toBeNull();
			expect(dialog.open).toBe(true);
			expect(dialog.querySelector(".markdown-expand-button")).toBeNull();
			if (button.getAttribute("aria-label") === "Agrandir : Diagram")
				expect(dialog.querySelector(".image-viewer .visual-zoom")).not.toBeNull();
			expect(dialog.contains(document.activeElement)).toBe(true);
			if (button.classList.contains("markdown-expand-document")) {
				expect(dialog.querySelector(".markdown-expanded-scroll")?.scrollTop).toBe(160);
				expect(dialog.querySelector("h1")?.textContent).toBe("Intro");
			}
			await act(async () => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
			expect(document.querySelector("dialog.markdown-expanded")).toBeNull();
			expect(document.activeElement).toBe(button);
			expect(reader.scrollTop).toBe(160);
			expect(scroller.scrollLeft).toBe(120);
			expect(scroller.querySelector("table")).toBe(table);
		}
	});
});

it("selects the JavaScript grammar for MJS in the reader and Git diff", async () => {
	const selection = { project: "/fixture", path: "module.MJS" };
	await render(<CodeViewer selection={selection} />);
	expect(host.querySelector('[data-testid="mock-source"]')?.getAttribute("data-language")).toBe("javascript");
	await render(<CodeViewer selection={{ ...selection, repo: "/fixture" }} />);
	expect(host.querySelector('[data-testid="mock-diff"]')?.getAttribute("data-language")).toBe("javascript");
});

describe("file image and unsupported previews", () => {
	it("expands a file image after Fit, keeps zoom controls and restores the original image and focus", async () => {
		assetState.kind = "image";
		assetState.dataUrl = "data:image/png;base64,fixture";
		await render(<CodeViewer selection={{ project: "/fixture", path: "plan.png" }} />);
		const original = host.querySelector<HTMLImageElement>("img")!;
		Object.defineProperties(original, { naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
		await act(async () => original.dispatchEvent(new Event("load")));
		await act(async () =>
			host.querySelector<HTMLButtonElement>('button[aria-label="Taille réelle (100 %)"]')!.click(),
		);
		for (let i = 0; i < 2; i++)
			await act(async () =>
				host.querySelector<HTMLButtonElement>('button[aria-label="Agrandir l’image"]')!.click(),
			);
		expect(original.style.width).toBe("1200px");
		const expand = host.querySelector<HTMLButtonElement>('button[aria-label="Agrandir : plan.png"]')!;
		expect(expand.previousElementSibling?.textContent).toBe("Adapter");
		await act(async () => expand.click());
		const dialog = document.querySelector<HTMLDialogElement>("dialog.markdown-expanded")!;
		expect(dialog.open).toBe(true);
		expect(dialog.querySelector('input[type="range"]')).not.toBeNull();
		// StrictMode can queue a close event during cleanup, then immediately reopen the same dialog.
		await act(async () => dialog.dispatchEvent(new Event("close")));
		expect(dialog.isConnected).toBe(true);
		const image = dialog.querySelector("img")!;
		Object.defineProperties(image, { naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
		await act(async () => image.dispatchEvent(new Event("load")));
		expect(image.style.width).toBe("1200px");
		await act(async () =>
			dialog.querySelector<HTMLButtonElement>('button[aria-label="Agrandir l’image"]')!.click(),
		);
		expect(image.style.width).toBe("1400px");
		expect(original.style.width).toBe("1400px");
		expect(dialog.querySelector("[aria-pressed]")?.textContent).toBe("Adapter");
		await act(async () => dialog.querySelector<HTMLButtonElement>("[aria-pressed]")!.click());
		expect(dialog.querySelector('[aria-pressed="true"]')?.textContent).toBe("Adapter");
		await act(async () => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
		expect(document.querySelector("dialog.markdown-expanded")).toBeNull();
		expect(host.querySelector("img")).toBe(original);
		expect(original.style.width).toBe("800px");
		expect(document.activeElement).toBe(expand);
	});
	it("renders PNG instead of the editor, recovers from decoding failure, and opens externally only on request", async () => {
		assetState.kind = "image";
		assetState.dataUrl = "data:image/png;base64,iVBORw0KGgo=";
		const selection: Selection = { project: "/fixture", path: "images/plan.PNG" };
		await render(<CodeViewer selection={selection} />);
		expect(host.querySelector(".file-image-stage img")?.getAttribute("src")).toBe(assetState.dataUrl);
		expect(host.querySelector('[data-testid="mock-source"]')).toBeNull();
		expect(host.querySelector('[data-testid="read-only-toggle"]')).toBeNull();
		expect(assetState.open).not.toHaveBeenCalled();
		await act(async () => host.querySelector("img")?.dispatchEvent(new Event("error")));
		expect(host.querySelector('[role="status"]')?.textContent).toContain(
			"Cette image ne peut pas être affichée",
		);
		await act(async () =>
			host.querySelector<HTMLButtonElement>('[data-testid="open-external-file"]')?.click(),
		);
		expect(assetState.open).toHaveBeenCalledWith("/fixture", "images/plan.PNG");
	});
	it("shows an actionable fallback for a video and surfaces macOS opening errors", async () => {
		assetState.kind = "unsupported";
		assetState.open.mockRejectedValueOnce("Ouverture impossible");
		await render(<CodeViewer selection={{ project: "/fixture", path: "video.mov" }} />);
		expect(host.querySelector('[role="status"]')?.textContent).toContain("Aperçu indisponible");
		expect(assetState.open).not.toHaveBeenCalled();
		await act(async () =>
			host.querySelector<HTMLButtonElement>('[data-testid="open-external-file"]')?.click(),
		);
		expect(assetState.open).toHaveBeenCalledWith("/fixture", "video.mov");
		expect(host.querySelector('[role="alert"]')?.textContent).toBe("Ouverture impossible");
	});
	it("retains the explicit SVG source view", async () => {
		assetState.kind = "image";
		assetState.dataUrl = "data:image/svg+xml;base64,PHN2Zy8+";
		await render(<CodeViewer selection={{ project: "/fixture", path: "plan.svg" }} />);
		expect(host.querySelector(".file-image-stage img")).not.toBeNull();
		await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="markdown-toggle"]')?.click());
		expect(host.querySelector('[data-testid="mock-source"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="read-only-toggle"]')).not.toBeNull();
	});
});

it("assigns stable heading anchors to rich text, accents and duplicate headings", async () => {
	await render(
		<MarkdownPreview
			content={"## Une **étape**\n\n## Une étape"}
			project="/fixture"
			path="demo.md"
			onCopyLink={() => {}}
		/>,
	);
	expect([...host.querySelectorAll("h2")].map((heading) => heading.id)).toEqual(["une-étape", "une-étape-1"]);
});

it("follows same-document anchors and routes relative links without copying them", async () => {
	const open = vi.fn(),
		copy = vi.fn();
	await render(
		<MarkdownPreview
			content={`${content}\n\n[Go](#purchase)\n\n[File](nested/next.md#section)`}
			project="/fixture"
			path="demo.md"
			onCopyLink={copy}
			onOpenLink={open}
		/>,
	);
	const container = host.querySelector<HTMLElement>(".markdown-scroll")!;
	await act(async () => host.querySelector<HTMLAnchorElement>('a[href="#purchase"]')!.click());
	expect(container.scrollTop).toBeGreaterThan(0);
	expect(open).not.toHaveBeenCalled();
	expect(copy).not.toHaveBeenCalled();
	await act(async () => host.querySelector<HTMLAnchorElement>('a[href="nested/next.md#section"]')!.click());
	expect(open).toHaveBeenCalledWith("nested/next.md#section");
	expect(copy).not.toHaveBeenCalled();
});
it("repeats anchor requests even after manually scrolling away", async () => {
	const view = (navigationId: string) => (
		<MarkdownPreview
			content={content}
			project="/fixture"
			path="demo.md"
			navigation={{ anchor: "purchase", navigationId }}
			onCopyLink={() => {}}
		/>
	);
	await render(view("first"));
	const container = host.querySelector<HTMLElement>(".markdown-scroll")!;
	const destination = container.scrollTop;
	expect(destination).toBeGreaterThan(0);
	container.scrollTop = 0;
	await render(view("second"));
	expect(container.scrollTop).toBe(destination);
});

it("preserves manual reading position on content refresh after anchor navigation", async () => {
	const view = (source: string) => (
		<MarkdownPreview
			content={source}
			project="/fixture"
			path="demo.md"
			navigation={{ anchor: "purchase", navigationId: "same-request" }}
			onCopyLink={() => {}}
		/>
	);
	await render(view(content));
	const container = host.querySelector<HTMLElement>(".markdown-scroll")!;
	const manualPosition = container.scrollTop + 40;
	await act(async () => {
		container.scrollTop = manualPosition;
		container.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	await render(view(`${content}\n\nUpdated footer.`));
	expect(container.scrollTop).toBe(manualPosition);
});
