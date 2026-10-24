import { expect, it } from "vitest";
import { type HistoryState, navigationVisit, visitLocation } from "./app-history";

it("retains file visits, avoids duplicate locations and discards forward history on a new visit", () => {
	let state: HistoryState = { entries: [{ view: "overview" }], index: 0 };
	state = visitLocation(state, { view: "project", root: "/fixture" });
	const file = {
		view: "project" as const,
		root: "/fixture",
		workspace: { selection: { project: "/fixture", path: "a.md", navigationId: "first" } },
	};
	state = visitLocation(state, file);
	expect(
		visitLocation(state, {
			...file,
			workspace: { selection: { ...file.workspace.selection, navigationId: "repeat" } },
		}),
	).toBe(state);
	state = visitLocation(state, { ...file, workspace: { selection: { project: "/fixture", path: "b.md" } } });
	expect(state.entries.map((entry) => entry.workspace?.selection?.path ?? entry.view)).toEqual([
		"overview",
		"project",
		"a.md",
		"b.md",
	]);
	state = visitLocation({ ...state, index: 2 }, { view: "settings" });
	expect(state.entries.map((entry) => entry.workspace?.selection?.path ?? entry.view)).toEqual([
		"overview",
		"project",
		"a.md",
		"settings",
	]);
	for (let i = 0; i < 150; i++) state = visitLocation(state, { view: "project", root: `/fixture/${i}` });
	expect(state.entries).toHaveLength(100);
	expect(state.index).toBe(99);
});

it("restores requested directories as folder scopes instead of files", () => {
	const selection = { project: "/fixture", path: "docs/" };
	expect(navigationVisit(selection)).toEqual({
		selection: null,
		folder: { root: selection.project, folder: "docs" },
		library: null,
		layout: "files",
	});
	expect(navigationVisit({ ...selection, path: "docs/a.md" }).selection?.path).toBe("docs/a.md");
});
