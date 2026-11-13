// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContextCollectionProvider, useContextCollection } from "./context-collection";
import { collectionApi } from "./context-collection-api";
import { ControlHints } from "./control-hints";
import { useImageContext } from "./image-context";
import "./i18n";

vi.mock("./context-collection-api", () => ({
	collectionApi: { load: vi.fn(), save: vi.fn(), export: vi.fn() },
}));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ onCloseRequested: () => Promise.resolve(() => {}) }),
}));
vi.mock("./context-collection-images", () => ({
	imageSourceKey: async () => "snapshot-version",
	snapshotImage: () => ({ dataUrl: "data:image/png;base64,AAAA", width: 800, height: 400 }),
}));
let c: NonNullable<ReturnType<typeof useContextCollection>>;
function Surface() {
	c = useContextCollection()!;
	const image = useRef<HTMLImageElement>(null);
	const annotation = useImageContext({
		src: "local-image",
		location: { project: "/images", path: "screen.png" },
		image,
		ready: true,
	});
	return (
		<>
			<ControlHints />
			<div>{annotation.actions}</div>
			<div className="image-viewport" tabIndex={0}>
				<img ref={image} alt="Screenshot" src="local-image" onPointerDown={annotation.onPoint} />
				{annotation.overlay}
			</div>
			{annotation.form}
		</>
	);
}
let host: HTMLDivElement, root: Root;
beforeEach(() => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	vi.mocked(collectionApi.load).mockReset().mockResolvedValue(null);
	vi.mocked(collectionApi.save).mockReset().mockResolvedValue(undefined);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.restoreAllMocks();
});
async function writeComment(value: string) {
	await act(async () => {
		const field = document.querySelector<HTMLInputElement>('[data-testid="image-context-message"]')!;
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function start() {
	await act(async () =>
		root.render(
			<ContextCollectionProvider>
				<Surface />
			</ContextCollectionProvider>,
		),
	);
	await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="image-annotate"]')!.click());
	const img = host.querySelector("img")!;
	vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
		left: 20,
		top: 40,
		width: 200,
		height: 100,
	} as DOMRect);
	return img;
}
const done = () => document.querySelector<HTMLButtonElement>('[data-testid="image-context-add"]')!;
async function point(img: HTMLImageElement, clientX: number, clientY: number) {
	await act(async () =>
		img.dispatchEvent(new PointerEvent("pointerdown", { clientX, clientY, bubbles: true })),
	);
}
it("creates two compact comments, enables Done for nonempty text, and reopens a pin to edit or delete it", async () => {
	const img = await start();
	await point(img, 70, 115);
	expect(done().disabled).toBe(true);
	expect(host.querySelector('input[type="number"]')).toBeNull();
	await writeComment("First annotation");
	expect(done().disabled).toBe(false);
	await act(async () => done().click());
	expect(document.querySelector('[data-testid="image-context-form"]')).toBeNull();
	await point(img, 170, 65);
	await writeComment("Second annotation");
	await act(async () => done().click());
	const item = c.draft.items[0];
	if (item.kind !== "image") throw new Error("Expected image item");
	expect(
		item.annotations.map((a) => ({ message: a.message, point: a.point, confirmed: a.confirmed })),
	).toEqual([
		{ message: "First annotation", point: { x: 0.25, y: 0.75 }, confirmed: true },
		{ message: "Second annotation", point: { x: 0.75, y: 0.25 }, confirmed: true },
	]);
	expect(host.querySelectorAll("button.image-context-marker")).toHaveLength(2);
	const firstPin = host.querySelector<HTMLButtonElement>('button[aria-label="Annotation 1"]')!;
	await act(async () => firstPin.focus());
	expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("First annotation");
	expect(firstPin.hasAttribute("title")).toBe(false);
	await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Annotation 1"]')!.click());
	await writeComment("Edited first annotation");
	await act(async () => done().click());
	await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Annotation 2"]')!.click());
	await act(async () =>
		document.querySelector<HTMLButtonElement>('[data-testid="image-context-remove"]')!.click(),
	);
	const updated = c.draft.items[0];
	expect(updated.kind === "image" && updated.annotations.map((a) => a.message)).toEqual([
		"Edited first annotation",
	]);
	expect(document.activeElement).toBe(host.querySelector(".image-viewport"));
	expect(collectionApi.save).toHaveBeenLastCalledWith(c.draft);
});
it("restores an unconfirmed comment after restart and blocks copying until it is confirmed or deleted", async () => {
	const img = await start();
	await point(img, 70, 115);
	await writeComment("Retain this draft");
	const saved = structuredClone(c.draft);
	expect(saved.items[0].kind === "image" && saved.items[0].annotations[0].confirmed).toBe(false);
	await act(async () => root.unmount());
	root = createRoot(host);
	vi.mocked(collectionApi.load).mockResolvedValue(saved);
	await act(async () =>
		root.render(
			<ContextCollectionProvider>
				<Surface />
			</ContextCollectionProvider>,
		),
	);
	await act(async () => c.show());
	expect(document.querySelector<HTMLButtonElement>('[data-testid="collection-copy"]')!.disabled).toBe(true);
	expect(document.querySelector('[data-testid="collection-drafts-hint"]')).not.toBeNull();
	await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Terminé 1"]')!.click());
	expect(document.querySelector<HTMLButtonElement>('[data-testid="collection-copy"]')!.disabled).toBe(false);
	expect(c.draft.items[0].kind === "image" && c.draft.items[0].annotations[0].confirmed).toBe(true);
});

it("moves the single blank draft and lets a commented marker be dragged without losing its comment", async () => {
	const img = await start();
	await point(img, 70, 115);
	await point(img, 170, 65);
	let item = c.draft.items[0];
	if (item.kind !== "image") throw new Error("Expected image");
	expect(item.annotations).toHaveLength(1);
	expect(item.annotations[0].point).toEqual({ x: 0.75, y: 0.25 });
	await writeComment("Keep this comment");
	await act(async () => done().click());
	const marker = host.querySelector<HTMLButtonElement>(".image-context-marker")!;
	await act(async () => {
		marker.dispatchEvent(
			new PointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 170, clientY: 65, bubbles: true }),
		);
		marker.dispatchEvent(
			new PointerEvent("pointermove", { pointerId: 1, clientX: 120, clientY: 90, bubbles: true }),
		);
		marker.dispatchEvent(
			new PointerEvent("pointerup", { pointerId: 1, clientX: 120, clientY: 90, bubbles: true }),
		);
		marker.click();
	});
	item = c.draft.items[0];
	expect(item.kind === "image" && item.annotations[0]).toMatchObject({
		message: "Keep this comment",
		confirmed: true,
		point: { x: 0.5, y: 0.5 },
	});
	expect(document.querySelector('[data-testid="image-context-form"]')).toBeNull();
	await point(img, 50, 50);
	item = c.draft.items[0];
	expect(item.kind === "image" && item.annotations).toHaveLength(2);
});
