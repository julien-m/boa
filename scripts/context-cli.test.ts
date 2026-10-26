import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseContexts } from "./boa";

describe("persistent context CLI", () => {
	it("addresses a project explicitly and keeps updates revision guarded", () => {
		expect(parseContexts(["list", "--project", "/tmp/sample", "--json"])).toEqual({
			command: "contexts",
			request: { action: "list", project: "/tmp/sample" },
		});
		expect(
			parseContexts([
				"reorder",
				"guide",
				"--project",
				"/tmp/sample",
				"--revision",
				"4",
				"--steps",
				"last,first",
			]),
		).toMatchObject({
			request: { action: "reorder", id: "guide", expectedRevision: 4, stepIds: ["last", "first"] },
		});
		expect(() => parseContexts(["list"])).toThrow("--project");
		expect(() =>
			parseContexts(["reorder", "guide", "--project", "/tmp/sample", "--steps", "last,first"]),
		).toThrow();
		expect(() => parseContexts(["remove", "guide", "--project", "/tmp/sample", "--wait"])).toThrow();
	});
	it("reads only caller-provided view and patch JSON; supports open and receipt queries", () => {
		const root = mkdtempSync(join(tmpdir(), "boa-context-cli-"));
		try {
			const path = join(root, "input.json");
			writeFileSync(path, JSON.stringify({ title: "A caller's guide", kind: "findings", steps: [] }));
			expect(
				parseContexts(["save", "custom", "--project", root, "--file", path, "--revision", "0"]),
			).toMatchObject({
				request: {
					action: "save",
					view: { id: "custom", project: root, title: "A caller's guide" },
					expectedRevision: 0,
				},
			});
			expect(
				parseContexts(["update", "custom", "--project", root, "--file", path, "--revision", "2"]),
			).toMatchObject({
				request: { action: "update", expectedRevision: 2, patch: { kind: "findings" } },
			});
			expect(
				parseContexts([
					"open",
					"custom",
					"--project",
					root,
					"--step",
					"entry",
					"--passage",
					"evidence",
					"--wait",
				]),
			).toMatchObject({
				request: { action: "open", stepId: "entry", passageId: "evidence" },
			});
			expect(parseContexts(["status", "receipt-id", "--json"])).toEqual({
				command: "reader-status",
				requestId: "receipt-id",
			});
			expect(() =>
				parseContexts(["save", "custom", "--project", root, "--file", path, "--revision", "-1"]),
			).toThrow("revision");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
