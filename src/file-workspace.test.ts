import { describe, expect, it } from "vitest";
import { orderedEntries, toggleIncluded } from "./file-browser";
import { defaultPreferences, selectedPath, visiblePath } from "./file-workspace-api";
import { shortcutMatches, validSearchShortcuts } from "./search-shortcuts";

describe("file space visibility and pins", () => {
	it("keeps ancestors traversable without including their siblings", () => {
		const pref = { ...defaultPreferences, filtered: true, included: [".codex/skills"] };
		expect(visiblePath(".codex", pref)).toBe(true);
		expect(selectedPath(".codex", pref)).toBe(false);
		expect(visiblePath(".codex/skills/test.md", pref)).toBe(true);
		expect(visiblePath(".codex/sessions", pref)).toBe(false);
		expect(toggleIncluded(pref, ".codex", true).included).toEqual([".codex"]);
		expect(toggleIncluded(pref, ".codex/skills", false).included).toEqual([]);
		expect(visiblePath("notes/file.md", { ...defaultPreferences, filtered: true, pins: ["notes"] })).toBe(
			true,
		);
	});
	it("sorts modified entries while preserving deterministic ties", () => {
		const entries = [
			{ name: "b", path: "b", directory: true, modified: 1, symlink: false, repository: false },
			{ name: "a", path: "a", directory: false, modified: 5, symlink: false, repository: false },
		];
		expect(orderedEntries(entries, defaultPreferences)[0].name).toBe("b");
		expect(orderedEntries(entries, { ...defaultPreferences, sort: "modified" })[0].name).toBe("a");
	});
});
describe("search shortcut routing", () => {
	it("matches exact modifiers and rejects duplicate bindings", () => {
		const event = { key: "f", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false };
		expect(shortcutMatches(event, "Mod+F")).toBe(false);
		expect(shortcutMatches(event, "Mod+Shift+F")).toBe(true);
		expect(validSearchShortcuts({ contextual: "Mod+G", global: "Mod+Shift+F" })).toBe(true);
		expect(validSearchShortcuts({ contextual: "Mod+G", global: "Mod+G" })).toBe(false);
	});
});
