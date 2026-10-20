// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { ImageComparison } from "./image-comparison";
import "./i18n";

let root: Root, host: HTMLDivElement;
vi.mock("./api", () => ({ api: { chooseComparisonImage: vi.fn() } }));
beforeEach(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(400);
	vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(800);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.mocked(api.chooseComparisonImage)
		.mockReset()
		.mockResolvedValue({ dataUrl: "data:image/png;base64,second", name: "second.png", size: 3 });
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(832);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(464);
	vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) {
		this.open = true;
	});
	vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) {
		this.open = false;
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
async function render(onClose = vi.fn()) {
	await act(async () =>
		root.render(
			<ImageComparison
				src="data:image/png;base64,first"
				alt="First"
				onClose={onClose}
				location={{ project: "/project", path: "images/current.png" }}
			/>,
		),
	);
	await load(document.querySelector<HTMLImageElement>('img[alt="First"]')!, 800, 400);
}
async function load(image: HTMLImageElement, width: number, height: number) {
	Object.defineProperties(image, {
		naturalWidth: { value: width, configurable: true },
		naturalHeight: { value: height, configurable: true },
	});
	await act(async () => image.dispatchEvent(new Event("load")));
}
async function choose() {
	await act(async () =>
		[...document.querySelectorAll<HTMLButtonElement>("button")]
			.find((element) => element.textContent === "Choisir une deuxième image")!
			.click(),
	);
}
const button = (text: string) =>
	[...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(element) => element.textContent === text,
	)!;
it("compares different physical dimensions at one scale and keeps manual zoom across modes", async () => {
	await render();
	await choose();
	expect(api.chooseComparisonImage).toHaveBeenCalledWith("/project", "images");
	const images = [...document.querySelectorAll<HTMLImageElement>(".image-comparison-canvas img")];
	expect(images.map((image) => [image.style.width, image.style.height])).toEqual([
		["392px", "196px"],
		["196px", "392px"],
	]);
	await act(async () =>
		document.querySelector<HTMLButtonElement>('[aria-label="Taille réelle (100 %)"]')!.click(),
	);
	expect(images[0].style.width).toBe("800px");
	expect(images[1].style.width).toBe("400px");
	await act(async () => button("Superposition").click());
	expect(document.querySelector<HTMLImageElement>(".image-comparison-overlay img")!.style.height).toBe(
		"800px",
	);
	const slider = document.querySelector<HTMLInputElement>(
		'[aria-label="Part visible de la deuxième image"]',
	)!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "75");
		slider.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(document.querySelector<HTMLElement>(".image-comparison-overlay")!.style.clipPath).toBe(
		"inset(0 25% 0 0)",
	);
	expect(slider.min).toBe("0");
	expect(slider.max).toBe("100");
	const background = document.querySelector<HTMLSelectElement>('[aria-label="Fond"]')!;
	await act(async () => {
		background.value = "black";
		background.dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect(document.querySelector<HTMLElement>(".image-comparison-canvas")!.style.backgroundColor).toBe("#000");
	await act(async () => button("Côte à côte").click());
	expect(
		[...document.querySelectorAll<HTMLElement>(".image-comparison-canvas")].every(
			(canvas) => canvas.style.backgroundColor === "#000",
		),
	).toBe(true);
});
it("keeps both versions after native cancellation or failure", async () => {
	await render();
	await choose();
	vi.mocked(api.chooseComparisonImage).mockResolvedValueOnce(null);
	await choose();
	expect(document.querySelector('[role="alert"]')).toBeNull();
	vi.mocked(api.chooseComparisonImage).mockRejectedValueOnce("Image trop volumineuse (8 Mo maximum).");
	await choose();
	expect(document.querySelector('[role="alert"]')!.textContent).toContain("8 Mo");
	expect(document.querySelector('img[alt="First"]')).not.toBeNull();
	expect(document.querySelector('img[alt="second.png"]')).not.toBeNull();
});
it("requests the project root when the current image has no parent folder", async () => {
	await act(async () =>
		root.render(
			<ImageComparison
				src="data:image/png;base64,first"
				alt="First"
				onClose={() => {}}
				location={{ project: "/project", path: "current.png" }}
			/>,
		),
	);
	await choose();
	expect(api.chooseComparisonImage).toHaveBeenCalledWith("/project", "");
});

it("handles Escape, ignores queued stale close, and restores triggering focus", async () => {
	const trigger = document.createElement("button");
	document.body.append(trigger);
	trigger.focus();
	const onClose = vi.fn();
	await render(onClose);
	const dialog = document.querySelector("dialog")!;
	await act(async () => dialog.dispatchEvent(new Event("close")));
	expect(onClose).not.toHaveBeenCalled();
	await act(async () => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
	expect(onClose).toHaveBeenCalledOnce();
	await act(async () => root.render(null));
	expect(document.activeElement).toBe(trigger);
	trigger.remove();
});
