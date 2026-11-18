// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_SORT,
	nextSort,
	parseSort,
	readGrouping,
	readSort,
	sortSessions,
	writeGrouping,
	writeSort,
} from "./session-sort";
import type { SessionState, SessionSummary } from "./sessions-api";

function session(
	id: string,
	state: SessionState,
	updatedAt: number | null,
	project: string | null = null,
): SessionSummary {
	const no = { available: false };
	return {
		key: { provider: "codex", id },
		title: id,
		project,
		cwd: project ?? "/",
		recordedBranch: null,
		createdAt: null,
		updatedAt,
		state,
		evidence: "codexDaemon",
		capabilities: { rename: no, send: no, resume: no, openInApp: no, terminal: no },
		pinned: false,
	};
}
const ids = (list: SessionSummary[]) => list.map((item) => item.key.id);
const names: Record<string, string> = { "/a": "atlas", "/b": "Cedar", "/c": "nimbus" };
const projectName = (path: string | null) => (path ? (names[path] ?? null) : null);

afterEach(() => localStorage.clear());

describe("session table sort", () => {
	it("defaults to most recent activity, breaking equal dates by attention", () => {
		const input = [
			session("inactive", "inactive", 50),
			session("working", "working", 50),
			session("waiting", "awaitingInput", 50),
			session("failed", "failed", 50),
			session("idle", "idle", 50),
			session("unknown", "unknown", 50),
			session("newest", "inactive", 90),
			session("never", "awaitingInput", null),
		];
		expect(ids(sortSessions(input, DEFAULT_SORT, projectName))).toEqual([
			"newest",
			"waiting",
			"failed",
			"working",
			"idle",
			"inactive",
			"unknown",
			"never",
		]);
		expect(ids(input)).toEqual([
			"inactive",
			"working",
			"waiting",
			"failed",
			"idle",
			"unknown",
			"newest",
			"never",
		]);
		// Reversed: oldest first, sessions without activity still last.
		expect(
			ids(sortSessions(input, { column: "activity", direction: "asc" }, projectName)).slice(0, 2),
		).toEqual(["waiting", "failed"]);
		expect(ids(sortSessions(input, { column: "activity", direction: "asc" }, projectName)).at(-2)).toBe(
			"newest",
		);
		expect(ids(sortSessions(input, { column: "activity", direction: "asc" }, projectName)).at(-1)).toBe(
			"never",
		);
	});

	it("sorts state by attention then recent activity, and title or project alphabetically", () => {
		const input = [
			session("b-old-working", "working", 10, "/b"),
			session("a-waiting", "awaitingInput", 5, "/c"),
			session("c-new-working", "working", 20, "/a"),
			session("d-none", "idle", 30, null),
		];
		expect(ids(sortSessions(input, { column: "state", direction: "asc" }, projectName))).toEqual([
			"a-waiting",
			"c-new-working",
			"b-old-working",
			"d-none",
		]);
		expect(ids(sortSessions(input, { column: "state", direction: "desc" }, projectName))[0]).toBe("d-none");
		expect(ids(sortSessions(input, { column: "title", direction: "asc" }, projectName))).toEqual([
			"a-waiting",
			"b-old-working",
			"c-new-working",
			"d-none",
		]);
		// Case-insensitive names; a session outside every project stays last in both directions.
		expect(ids(sortSessions(input, { column: "project", direction: "asc" }, projectName))).toEqual([
			"c-new-working",
			"b-old-working",
			"a-waiting",
			"d-none",
		]);
		expect(ids(sortSessions(input, { column: "project", direction: "desc" }, projectName))).toEqual([
			"a-waiting",
			"b-old-working",
			"c-new-working",
			"d-none",
		]);
	});

	it("reverses on the second click and starts each column in its natural direction", () => {
		expect(nextSort(DEFAULT_SORT, "activity")).toEqual({ column: "activity", direction: "asc" });
		expect(nextSort(DEFAULT_SORT, "title")).toEqual({ column: "title", direction: "asc" });
		expect(nextSort({ column: "title", direction: "asc" }, "title")).toEqual({
			column: "title",
			direction: "desc",
		});
		expect(nextSort({ column: "title", direction: "desc" }, "activity")).toEqual(DEFAULT_SORT);
	});

	it("persists a valid choice, migrates the former select values and rejects invalid ones", () => {
		writeSort({ column: "state", direction: "desc" });
		expect(readSort()).toEqual({ column: "state", direction: "desc" });
		expect(parseSort("state")).toEqual({ column: "state", direction: "asc" });
		expect(parseSort("activity")).toEqual(DEFAULT_SORT);
		expect(parseSort('{"column":"evil","direction":"asc"}')).toEqual(DEFAULT_SORT);
		expect(parseSort("{not json")).toEqual(DEFAULT_SORT);
		expect(parseSort(null)).toEqual(DEFAULT_SORT);
		localStorage.setItem("boa-session-sort", "project");
		expect(readGrouping()).toBe(true);
		writeGrouping(false);
		expect(readGrouping()).toBe(false);
	});
});
