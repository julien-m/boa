import { describe, expect, it } from "vitest";
import { currentContextStep, resolveContextPassage } from "./context-anchors";
import type { ContextPassage, ContextView } from "./context-api";

function passage(text: string, startLine: number): ContextPassage {
	return {
		id: "selected",
		path: "src/reader.ts",
		startLine,
		endLine: startLine + text.split("\n").length - 1,
		text,
	};
}

describe("context source anchors", () => {
	it("retains exact text and relocates its entire range after lines are inserted", () => {
		const lines = ["export function selected() {", "  return input.value;", "}"];
		const anchor = lines.join("\n");
		const original = ["// header", ...lines, "// footer"].join("\n");
		const target = passage(anchor, original.split("\n").indexOf(lines[0]) + 1);
		expect(resolveContextPassage(original, target)).toEqual({
			line: target.startLine,
			endLine: target.endLine,
			status: "exact",
		});
		for (const count of [1, 4]) {
			const added = Array.from({ length: count }, (_, index) => `// new header ${index}`);
			const moved = [...added, original].join("\n");
			expect(resolveContextPassage(moved, target)).toEqual({
				line: target.startLine + added.length,
				endLine: target.endLine + added.length,
				status: "relocated",
			});
		}
	});
	it("does not accept missing or ambiguous text even if an old coordinate or symbol still matches", () => {
		const target = { ...passage("return oldValue;", 1), symbol: "handler" };
		for (const content of ["function handler() { return changedValue; }", `${target.text}\n${target.text}`])
			expect(resolveContextPassage(content, target).status).toBe("needs-review");
	});
	it("normalizes CRLF without extending the selection into the next line", () => {
		const sourceLines = ["header", "first anchor line", "last anchor line", "footer"];
		const target = passage(sourceLines.slice(1, -1).join("\n"), 2);
		expect(resolveContextPassage(sourceLines.join("\r\n"), { ...target, text: `${target.text}\n` })).toEqual({
			line: target.startLine,
			endLine: target.endLine,
			status: "exact",
		});
	});
	it("checks bare coordinates and treats moved or duplicated symbol-only anchors as uncertain", () => {
		const source = "first\nfunction target() {}\nlast";
		const target = { ...passage("", 2), symbol: "target" };
		expect(resolveContextPassage(source, target).status).toBe("exact");
		expect(resolveContextPassage(`new\n${source}`, target).status).toBe("needs-review");
		expect(resolveContextPassage(`${source}\ntarget`, target).status).toBe("needs-review");
		expect(resolveContextPassage(source.replace("target", "targeted"), target).status).toBe("needs-review");
		const count = source.split("\n").length;
		expect(
			resolveContextPassage(source, {
				...target,
				symbol: undefined,
				startLine: count + 1,
				endLine: count + 1,
			}).status,
		).toBe("needs-review");
	});
});

it("retains the selected step by ID across reorder and refuses a deleted step", () => {
	const steps = ["inputs", "write", "result"].map((id) => ({ id, title: id, description: "", passages: [] }));
	const view: ContextView = {
		id: "flow",
		project: "/fixture",
		title: "Flow",
		description: "",
		kind: "walkthrough",
		steps,
		revision: 1,
		updatedAt: 0,
	};
	const selected = steps[0];
	expect(currentContextStep({ ...view, steps: [...steps].reverse() }, selected.id)).toBe(selected);
	expect(
		currentContextStep({ ...view, steps: steps.filter((step) => step !== selected) }, selected.id),
	).toBeNull();
});
