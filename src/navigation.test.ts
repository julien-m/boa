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
	it("accepts local Finder document URLs and rejects network file URLs", () => {
		const file = "/tmp/été and spaces/page.html";
		expect(parseNavigation(`file://${encodeURI(file)}`)).toEqual({
			file,
			line: 1,
			endLine: 1,
			source: "CLI",
			document: true,
		});
		for (const raw of ["file://remote-host/share/page.html", "file:///tmp/bad%00.html"])
			expect(() => parseNavigation(raw)).toThrow();
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

it("round-trips dropped native paths without interpreting percent signs, hashes or Unicode as URL syntax", async () => {
	const { localFileUrl } = await import("./navigation");
	for (const file of ["/workspace/100%/image #1.png", "/workspace/été/captures", "/workspace/a?b.md"])
		expect(parseNavigation(localFileUrl(file))).toMatchObject({ file, document: true });
});
