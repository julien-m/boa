import { expect, it } from "vitest";
import { localMarkdownLink } from "./markdown-links";

it("resolves relative files and encoded anchors from the document, preserving literal percent paths", () => {
	const document = "/workspace/100%/docs/nested/plan.md";
	expect(localMarkdownLink("../../decision.md#une-%C3%A9tape", document)).toEqual({
		file: "/workspace/100%/decision.md",
		anchor: "une-étape",
	});
	expect(localMarkdownLink("../a%20b.md", document)?.file).toBe("/workspace/100%/docs/a b.md");
	expect(localMarkdownLink("#purchase", document)).toEqual({ file: document, anchor: "purchase" });
});
it("keeps external protocols and invalid destinations out of local navigation", () => {
	for (const href of [
		"https://example.com",
		"//example.com/file",
		"mailto:x@example.com",
		"file://server/file",
		"bad%ZZ.md",
	])
		expect(localMarkdownLink(href, "/workspace/plan.md")).toBeNull();
});
