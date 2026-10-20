// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImageViewer } from "./image-viewer";
import "./i18n";

let host: HTMLDivElement, root: Root;
let resize: () => void;
let bounds: { width: number; height: number };
beforeEach(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	bounds = { width: 432, height: 232 };
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
it("fits at first, zooms from 25 to 200% using intrinsic size, resets to 100%, and follows resize only in Fit", async () => {
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
	expect(button("Agrandir l’image").disabled).toBe(true);
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
	expect(host.querySelector<HTMLInputElement>('input[type="range"]')?.getAttribute("max")).toBe("200");
});
it("Fit enlarges small images to the available viewport, including beyond the manual zoom limit", async () => {
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
