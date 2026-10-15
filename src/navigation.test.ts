/** Navigation must remain a read-only, bounded path-and-line protocol. */
import { describe, expect, it } from "vitest";
import { parseNavigation } from "./navigation";

describe("BOA navigation", () => {
	it("preserves Unicode paths and selected line ranges", () => {
		const url = new URL("boa://open");
		url.search = new URLSearchParams({
			file: "/Users/example/Projects/été/a b.ts",
			line: "42",
			endLine: "51",
			source: "Codex",
		}).toString();
		expect(parseNavigation(url.href)).toEqual({
			file: "/Users/example/Projects/été/a b.ts",
			line: 42,
			endLine: 51,
			source: "Codex",
		});
	});
	it("rejects unrelated protocols, commands and invalid ranges", () => {
		for (const url of [
			"https://open?file=/a",
			"boa://commit?file=/a",
			"boa://open?file=relative",
			"boa://open?file=/a&line=-1",
			"boa://open?file=/a&line=5&endLine=2",
		])
			expect(() => parseNavigation(url)).toThrow();
	});
});
