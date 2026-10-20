// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImageViewer, imageByteSize } from "./image-viewer";
import "./i18n";

const clipboard = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: clipboard }));
let host: HTMLDivElement, root: Root;
let resize: () => void;
let bounds: { width: number; height: number };
beforeEach(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	bounds = { width: 432, height: 232 };
	clipboard.mockReset().mockResolvedValue(undefined);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				resize = callback;
			}
			observe() {}
			disconnect() {}
		},
	);
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => bounds.width);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => bounds.height);
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
async function render(src = "data:image/png;base64,fixture") {
	await act(async () => root.render(<ImageViewer src={src} alt="Diagram" onError={() => {}} />));
}
async function loadImage() {
	const img = host.querySelector("img")!;
	Object.defineProperties(img, {
		naturalWidth: { value: 800, configurable: true },
		naturalHeight: { value: 400, configurable: true },
	});
	await act(async () => img.dispatchEvent(new Event("load")));
	return img;
}
const button = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
it("fits at first, zooms from 25 to 1600% using intrinsic size, resets to 100%, and follows resize only in Fit", async () => {
	await render();
	expect(button("Agrandir l’image").disabled).toBe(true);
	const img = await loadImage();
	expect(img.style.width).toBe("400px");
	expect(img.style.height).toBe("200px");
	await act(async () => button("Taille réelle (100 %)").click());
	expect(img.style.width).toBe("800px");
	const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "150");
		slider.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(img.style.width).toBe("1200px");
	await act(async () => button("Taille réelle (100 %)").click());
	for (let i = 0; i < 4; i++) await act(async () => button("Agrandir l’image").click());
	expect(img.style.width).toBe("1600px");
	expect(button("Agrandir l’image").disabled).toBe(false);
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "1600");
		slider.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(img.style.width).toBe("12800px");
	expect(button("Agrandir l’image").disabled).toBe(true);
	await act(async () => button("Taille réelle (100 %)").click());
	for (let i = 0; i < 4; i++) await act(async () => button("Agrandir l’image").click());
	for (let i = 0; i < 7; i++) await act(async () => button("Réduire").click());
	expect(img.style.width).toBe("200px");
	expect(button("Réduire").disabled).toBe(true);
	bounds = { width: 232, height: 132 };
	await act(async () => resize());
	expect(img.style.width).toBe("200px");
	await act(async () => button("Taille réelle (100 %)").click());
	expect(img.style.width).toBe("800px");
	await act(async () =>
		[...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Adapter")!.click(),
	);
	expect(img.style.width).toBe("200px");
	bounds = { width: 832, height: 432 };
	await act(async () => resize());
	expect(img.style.width).toBe("800px");
	expect(host.querySelector<HTMLInputElement>('input[type="range"]')?.getAttribute("min")).toBe("25");
	expect(host.querySelector<HTMLInputElement>('input[type="range"]')?.getAttribute("max")).toBe("1600");
});
it("Fit enlarges small images to the available viewport, above intrinsic size", async () => {
	bounds = { width: 1832, height: 932 };
	await render();
	const img = await loadImage();
	expect(img.style.width).toBe("1800px");
	expect(img.style.height).toBe("900px");
	expect(button("Taille réelle (100 %)").textContent).toBe("225 %");
	bounds = { width: 1232, height: 1032 };
	await act(async () => resize());
	expect(img.style.width).toBe("1200px");
	expect(img.style.height).toBe("600px");
	await act(async () => button("Taille réelle (100 %)").click());
	expect(img.style.width).toBe("800px");
});
it("resets for a different image and shows a readable decoding failure instead of broken zoom", async () => {
	await render();
	await loadImage();
	await act(async () => button("Taille réelle (100 %)").click());
	await render("data:image/svg+xml;base64,different");
	expect(button("Agrandir l’image").disabled).toBe(true);
	const img = await loadImage();
	expect(img.style.width).toBe("400px");
	await act(async () => img.dispatchEvent(new Event("error")));
	expect(host.querySelector('[role="status"]')?.textContent).toContain(
		"Cette image ne peut pas être affichée",
	);
	expect(host.querySelector(".visual-zoom")).toBeNull();
});

it("changes the image background, resets it and aligns a pixel grid to intrinsic pixels", async () => {
	await render("data:image/png;base64,AAAA");
	await loadImage();
	expect(host.querySelector(".image-facts")?.textContent).toBe("800 × 400 px · 3 o");
	const select = host.querySelector<HTMLSelectElement>(".image-background-select")!;
	await act(async () => {
		select.value = "white";
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect(host.querySelector<HTMLElement>(".image-canvas")!.style.backgroundColor).toBe("#fff");
	await act(async () => {
		select.value = "checkerboard";
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect(host.querySelector<HTMLElement>(".image-canvas")!.style.backgroundImage).toContain("conic-gradient");
	await act(async () => {
		select.value = "custom";
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
	const color = host.querySelector<HTMLInputElement>('input[type="color"]')!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(color, "#123456");
		color.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(host.querySelector<HTMLElement>(".image-canvas")!.style.backgroundColor).toBe("#123456");
	await act(async () => button("Réinitialiser le fond").click());
	expect(host.querySelector<HTMLElement>(".image-canvas")!.style.backgroundColor).toBe("");
	expect(button("Grille de pixels").disabled).toBe(true);
	const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider, "800");
		slider.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => button("Grille de pixels").click());
	expect(host.querySelector<HTMLElement>(".image-pixel-grid")?.style.backgroundSize).toBe("8px 8px");
	expect(host.querySelector("img")?.style.imageRendering).toBe("pixelated");
	expect(imageByteSize("https://example.test/image.png")).toBeUndefined();
});
it("samples one intrinsic pixel, copies HEX with alpha and reports inaccessible pixels clearly", async () => {
	await render();
	const img = await loadImage();
	vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
		left: 0,
		top: 0,
		width: 400,
		height: 200,
	} as DOMRect);
	const draw = vi.fn();
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		drawImage: draw,
		getImageData: () => ({ data: new Uint8ClampedArray([255, 128, 0, 128]) }),
	} as unknown as CanvasRenderingContext2D);
	await act(async () => button("Pipette · copier une couleur").click());
	await act(async () =>
		img.dispatchEvent(new MouseEvent("pointerdown", { clientX: 200, clientY: 100, bubbles: true })),
	);
	expect(draw).toHaveBeenCalledWith(img, 400, 200, 1, 1, 0, 0, 1, 1);
	expect(clipboard).toHaveBeenCalledWith("#FF800080");
	expect(host.querySelector('[role="status"]')?.textContent).toContain("rgba(255, 128, 0, 0.502)");
	draw.mockImplementation(() => {
		throw new DOMException("Tainted canvas", "SecurityError");
	});
	await act(async () => button("Pipette · copier une couleur").click());
	await act(async () =>
		img.dispatchEvent(new MouseEvent("pointerdown", { clientX: 200, clientY: 100, bubbles: true })),
	);
	expect(clipboard).toHaveBeenCalledTimes(1);
	expect(host.querySelector('[role="status"]')?.textContent).toContain("Pipette indisponible");
});

it("opens image comparison above the reader and restores its trigger on closing", async () => {
	await render();
	await loadImage();
	const compare = button("Comparer deux images");
	await act(async () => {
		compare.focus();
		compare.click();
	});
	const dialog = document.querySelector<HTMLDialogElement>("dialog.image-comparison")!;
	expect(dialog.hasAttribute("open")).toBe(true);
	await act(async () => dialog.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true })));
	expect(document.querySelector("dialog.image-comparison")).toBeNull();
	expect(document.activeElement).toBe(compare);
});
