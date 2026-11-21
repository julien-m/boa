import { describe, expect, it } from "vitest";
import { cliLanguage, describeError, parseActions, parseSessions, sessionsHelp } from "./sessions-cli";

describe("sessions CLI", () => {
	it("maps every session command onto the shared sessions RPC", () => {
		expect(parseSessions(["list", "--all", "--search", "arrondi"]).request).toMatchObject({
			action: "list",
			query: { scope: "all", search: "arrondi" },
		});
		expect(parseSessions(["list"]).request).toMatchObject({ query: { scope: "pinned" } });
		expect(parseSessions(["rename", "codex:01a1-x", "--title", "Nouveau"]).request).toEqual({
			action: "rename",
			session: { provider: "codex", id: "01a1-x" },
			title: "Nouveau",
		});
		expect(parseSessions(["branch", "claude:abc", "--switch", "dev"]).request).toMatchObject({
			action: "requestBranch",
			target: "dev",
		});
		expect(parseSessions(["discovery", "on", "--providers", "codex", "--revision", "3"]).request).toEqual({
			action: "setDiscovery",
			enabled: true,
			providers: { codex: true, claude: false },
			revision: 3,
		});
		expect(parseSessions(["open", "codex:t1"]).request).toMatchObject({ action: "openInApp" });
	});

	it("rejects malformed session keys, unknown options and out-of-range limits", () => {
		expect(() => parseSessions(["show", "codex:../x"])).toThrow();
		expect(() => parseSessions(["show", "other:x"])).toThrow();
		expect(() => parseSessions(["list", "--nope"])).toThrow(/unknown option/);
		expect(() => parseSessions(["conversation", "codex:a", "--limit", "500"])).toThrow();
		expect(() => parseSessions(["autopin", "maybe"])).toThrow();
	});

	it("covers action CRUD, order, project overrides and reset", () => {
		const add = parseActions([
			"add",
			"--id",
			"lint",
			"--label",
			"Lint",
			"--template",
			"Lint {branche}",
			"--mode",
			"send",
			"--providers",
			"codex",
			"--project",
			"/tmp/p",
		]).request;
		expect(add).toMatchObject({
			action: "changeActions",
			change: {
				change: "add",
				project: "/tmp/p",
				action: { id: "lint", mode: "send", providers: ["codex"], enabled: true },
			},
		});
		expect(parseActions(["disable", "review"]).request).toMatchObject({
			change: { change: "update", id: "review", patch: { enabled: false } },
		});
		expect(parseActions(["reorder", "--ids", "b,a"]).request).toMatchObject({
			change: { change: "reorder", ids: ["b", "a"] },
		});
		expect(parseActions(["reset", "--project", "/tmp/p", "--id", "tests"]).request).toMatchObject({
			change: { change: "reset", project: "/tmp/p", id: "tests" },
		});
		expect(() => parseActions(["reset"])).toThrow();
		expect(() => parseActions(["update", "review"])).toThrow();
		expect(() =>
			parseActions(["add", "--id", "x", "--label", "X", "--template", "t", "--mode", "later"]),
		).toThrow();
	});

	it("speaks French by default and English on request, keeping error codes visible", () => {
		expect(cliLanguage([], {})).toBe("fr");
		expect(cliLanguage(["--lang", "en"], {})).toBe("en");
		expect(cliLanguage([], { LANG: "en_US.UTF-8" })).toBe("en");
		expect(sessionsHelp("en")).toContain("Send transmits immediately");
		expect(sessionsHelp("fr")).toContain("Envoyer transmet immédiatement");
		expect(sessionsHelp("fr")).not.toMatch(/Mettre en (file|attente)/);
		expect(describeError("result_unknown", "x", "fr")).toContain("[result_unknown]");
		expect(describeError("weird_code", "detail", "en")).toBe("weird_code: detail");
	});
});
