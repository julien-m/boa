import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { codexOpen, codexOpenArgs } from "./codex-open";
import { installedBoaApp } from "./mac-app";

describe("desktop Open in BOA", () => {
	it("preserves file paths as arguments and maps source coordinates", () => {
		const path = join(tmpdir(), 'file with spaces $(echo unsafe) "quote".md');
		for (const line of [7, 83]) {
			expect(codexOpenArgs(JSON.stringify({ path, location: { line, column: 4 } }))).toEqual([
				"open",
				path,
				"--line",
				String(line),
				"--source",
				"Codex",
			]);
		}
		expect(codexOpenArgs(JSON.stringify({ path, location: null }))[3]).toBe("1");
		expect(codexOpenArgs(JSON.stringify({ path }))[3]).toBe("1");
	});

	it("rejects invalid input and remote file requests", () => {
		const path = fileURLToPath(import.meta.url);
		for (const payload of [
			null,
			[],
			{ path: "relative.md" },
			{ path, remotePath: path },
			{ path, location: { line: 0 } },
			{ path, location: { line: 1.5 } },
			{ path, location: { line: "12" } },
			{ path, location: { line: 1_000_001 } },
		]) {
			expect(() => codexOpenArgs(JSON.stringify(payload))).toThrow();
		}
		expect(() => codexOpenArgs("not JSON")).toThrow();
	});

	it("launches before acknowledged navigation and propagates display failures", async () => {
		const path = fileURLToPath(import.meta.url);
		const launch = vi.fn();
		for (const status of [0, 2, 1]) {
			const navigate = vi.fn(async () => status);
			expect(await codexOpen([JSON.stringify({ path, location: { line: 16 } })], { launch, navigate })).toBe(
				status,
			);
			expect(navigate).toHaveBeenCalledWith([
				"open",
				path,
				"--line",
				"16",
				"--source",
				"Codex",
				"--wait",
				"--json",
			]);
			expect(launch.mock.invocationCallOrder.at(-1)).toBeLessThan(navigate.mock.invocationCallOrder[0]);
		}
	});

	it("resolves explicit installation candidates instead of the scheme's registered development copy", () => {
		const folder = mkdtempSync(join(tmpdir(), "boa-install-"));
		try {
			const missing = join(folder, "missing.app");
			const app = join(folder, "BOA.app");
			mkdirSync(app);
			expect(installedBoaApp([missing, app])).toBe(app);
			expect(() => installedBoaApp([missing])).toThrow("Install BOA.app");
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("runs the adapter without launching BOA in dry-run mode", () => {
		const folder = mkdtempSync(join(tmpdir(), "boa-handler-"));
		try {
			const path = join(folder, "a file.md");
			writeFileSync(path, "first\nsecond\nthird\n");
			const result = spawnSync(
				"bun",
				[
					fileURLToPath(new URL("./codex-open.ts", import.meta.url)),
					JSON.stringify({ target: "custom:boa", path, location: { line: 3, column: 1 } }),
					"--dry-run",
				],
				{ encoding: "utf8", timeout: 1500 },
			);
			expect(result.status, result.stderr).toBe(0);
			const url = new URL(result.stdout.trim());
			expect(url.protocol).toBe("boa:");
			expect(url.searchParams.get("file")).toBe(path);
			expect(url.searchParams.get("line")).toBe("3");
			expect(url.searchParams.get("source")).toBe("Codex");
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});
});
