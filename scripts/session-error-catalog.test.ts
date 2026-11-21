import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionsEn, sessionsFr } from "../src/locales/sessions";

/** Codes that reach the UI: typed errors and capability reasons emitted by the Rust domain. */
function backendCodes(): string[] {
	const directory = join(import.meta.dirname, "../src-tauri/src/sessions");
	const codes = new Set<string>();
	for (const file of readdirSync(directory).filter(
		(name) => name.endsWith(".rs") && name !== "live-tests.rs",
	)) {
		const source = readFileSync(join(directory, file), "utf8").split("#[cfg(test)]")[0];
		for (const match of source.matchAll(/(?:SessionError::new|Capability::no)\(\s*"([a-z_]+)"/g))
			codes.add(match[1]);
	}
	return [...codes].sort();
}

describe("session error catalog", () => {
	it("localizes every backend error and capability code in French and English", () => {
		const codes = backendCodes();
		expect(codes.length).toBeGreaterThan(20);
		// Internal-only diagnostics that the UI maps to the generic message on purpose.
		const internal = new Set([
			"codex_protocol",
			"codex_transport",
			"codex_rejected",
			"codex_timeout",
			"claude_protocol",
			"claude_transport",
			"claude_failed",
			"io_error",
			"state_poisoned",
			"store_poisoned",
			"task_failed",
			"tool_unavailable",
			"timeout",
			"unsupported",
			"unexpected",
			"codex_daemon_start_failed",
			"open_failed",
			"store_unreadable",
			"unsupported_store_version",
			"git_failed",
			"cwd_missing",
			"permission_not_pending",
			"unknown_op",
		]);
		const missing = codes.filter((code) => !internal.has(code) && !(code in sessionsFr.errors));
		expect(missing).toEqual([]);
		expect(Object.keys(sessionsEn.errors).sort()).toEqual(Object.keys(sessionsFr.errors).sort());
	});
});
