import { expect, it, vi } from "vitest";
import { annotationColors } from "./annotation-style";
import { annotatedImage } from "./context-collection-images";
import {
	collectionPrompt,
	emptyCollection,
	hasUnconfirmedAnnotations,
	type ImageItem,
	isCollectionDraft,
	pointInImage,
} from "./context-collection-model";

it("keeps independent source snapshots, version labels and numbered image references in one portable prompt", () => {
	const draft = emptyCollection();
	draft.instruction = "Review both implementations";
	draft.items.push({
		id: "selected",
		kind: "text",
		message: "Check this branch",
		wholeFile: false,
		context: {
			project: "/work",
			path: "/work/a.ts",
			startLine: 3,
			endLine: 5,
			code: "const fenced = ` ``` `;",
			label: "Before",
		},
	});
	draft.items.push({
		id: "reference",
		kind: "text",
		message: "Related file",
		wholeFile: true,
		context: {
			project: "/work",
			path: "/work/b.ts",
			startLine: null,
			endLine: null,
			code: "",
			label: "Working tree",
		},
	});
	draft.items.push({
		id: "image",
		kind: "image",
		project: "/assets",
		path: "screen.png",
		dataUrl: "data:image/png;base64,AAAA",
		sourceKey: "version",
		width: 800,
		height: 600,
		annotations: [
			{ id: "pin", point: { x: 0.25, y: 0.8 }, message: "Move this button" },
			{ id: "whole", point: null, message: "Lighten the background" },
		],
	});
	expect(isCollectionDraft(draft)).toBe(true);
	const prompt = collectionPrompt(draft, true);
	expect(prompt).toContain("Review both implementations");
	expect(prompt).toContain("Lines: 3–5");
	expect(prompt).toContain("Before");
	expect(prompt).toContain("````\nconst fenced = ` ``` `;\n````");
	expect(prompt).toContain("Path: /work/b.ts");
	expect(prompt).toContain("contents are not included");
	expect(prompt).toContain("![image-3.png](image-3.png)");
	expect(prompt).toContain("1. (25%, 80%) — Move this button");
	expect(prompt).toContain("2. Whole image — Lighten the background");
	expect(prompt).toContain("separate attachments");
	expect(collectionPrompt(draft, false)).toContain("Contexte collecté");
});

it("normalizes image coordinates regardless of zoom, offset or viewport scrolling", () => {
	for (const scale of [0.25, 1, 3.5]) {
		const bounds = { left: -140, top: 80, width: 800 * scale, height: 600 * scale };
		expect(pointInImage(bounds.left + bounds.width * 0.7, bounds.top + bounds.height * 0.2, bounds)).toEqual({
			x: 0.7,
			y: 0.2,
		});
	}
	expect(pointInImage(-10, 300, { left: 0, top: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 1 });
	expect(pointInImage(0, 0, { left: 0, top: 0, width: 0, height: 10 })).toBeNull();
});

it("rejects malformed restored drafts without treating them as empty collections", () => {
	const image: ImageItem = {
		id: "image",
		kind: "image",
		project: "root",
		path: "a.png",
		sourceKey: "hash",
		dataUrl: "data:image/png;base64,AAAA",
		width: 40,
		height: 20,
		annotations: [{ id: "a", point: { x: 0.5, y: 0.2 }, message: "Note" }],
	};
	const draft = { ...emptyCollection(), items: [image] };
	expect(isCollectionDraft({ ...draft, version: 2 })).toBe(false);
	expect(isCollectionDraft({ ...draft, items: [image, image] })).toBe(false);
	expect(
		isCollectionDraft({ ...draft, items: [{ ...image, dataUrl: "https://example.com/private.png" }] }),
	).toBe(false);
	expect(
		isCollectionDraft({
			...draft,
			items: [{ ...image, annotations: [{ id: "a", point: { x: Number.NaN, y: 2 }, message: "Note" }] }],
		}),
	).toBe(false);
	expect(
		isCollectionDraft({
			...draft,
			items: [{ ...image, annotations: [image.annotations[0], image.annotations[0]] }],
		}),
	).toBe(false);
});

it("restores legacy and explicit confirmation states without rewriting existing annotations", () => {
	const image: ImageItem = {
		id: "image",
		kind: "image",
		project: "/assets",
		path: "screen.png",
		sourceKey: "version",
		dataUrl: "data:image/png;base64,AAAA",
		width: 800,
		height: 600,
		annotations: [
			{ id: "legacy", point: null, message: "" },
			{ id: "confirmed", point: { x: 0.2, y: 0.3 }, message: "Saved", confirmed: true },
			{ id: "draft", point: { x: 0.7, y: 0.8 }, message: "Still editing", confirmed: false },
		],
	};
	const draft = { ...emptyCollection(), items: [image] };
	const restored = JSON.parse(JSON.stringify(draft));
	expect(isCollectionDraft(restored)).toBe(true);
	expect(restored).toEqual(draft);
	expect(hasUnconfirmedAnnotations(restored)).toBe(true);
	const confirmed = {
		...draft,
		items: [{ ...image, annotations: image.annotations.filter((a) => a.id !== "draft") }],
	};
	expect(hasUnconfirmedAnnotations(confirmed)).toBe(true);
	expect(
		hasUnconfirmedAnnotations({ ...confirmed, items: [{ ...image, annotations: [image.annotations[1]] }] }),
	).toBe(false);
	expect(isCollectionDraft(confirmed)).toBe(true);
	for (const value of [null, "false", 0, {}, []]) {
		expect(
			isCollectionDraft({
				...draft,
				items: [{ ...image, annotations: [{ ...image.annotations[0], confirmed: value }] }],
			}),
		).toBe(false);
	}
});

it("exports confirmed blue markers with their original numbers and omits unconfirmed drafts", async () => {
	const fillColors: string[] = [];
	const context = {
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 0,
		font: "",
		textAlign: "",
		textBaseline: "",
		drawImage: vi.fn(),
		beginPath: vi.fn(),
		arc: vi.fn(),
		stroke: vi.fn(),
		fill: () => fillColors.push(context.fillStyle),
		fillText: vi.fn(),
	};
	const canvas = {
		width: 0,
		height: 0,
		getContext: () => context,
		toDataURL: () => "data:image/png;base64,AAAA",
	};
	vi.stubGlobal("document", { createElement: () => canvas });
	vi.stubGlobal(
		"Image",
		class {
			onload: (() => void) | null = null;
			set src(_value: string) {
				queueMicrotask(() => this.onload?.());
			}
		},
	);
	try {
		await annotatedImage({
			id: "image",
			kind: "image",
			project: "/assets",
			path: "screen.png",
			sourceKey: "version",
			dataUrl: "data:image/png;base64,AAAA",
			width: 800,
			height: 600,
			annotations: [
				{ id: "draft", point: { x: 0.1, y: 0.1 }, message: "Editing", confirmed: false },
				{ id: "confirmed", point: { x: 0.4, y: 0.5 }, message: "Saved", confirmed: true },
				{ id: "legacy", point: { x: 0.8, y: 0.9 }, message: "Legacy" },
			],
		});
		expect(fillColors).toEqual([annotationColors.pin, annotationColors.pin]);
		expect(context.fillText.mock.calls.map((call) => call[0])).toEqual(["2", "3"]);
		expect(canvas.width).toBe(0);
		expect(canvas.height).toBe(0);
	} finally {
		vi.unstubAllGlobals();
	}
});
