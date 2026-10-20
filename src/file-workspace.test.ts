import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orderedEntries, toggleIncluded } from "./file-browser";
import { defaultPreferences, fileWorkspace, selectedPath, visiblePath } from "./file-workspace-api";
import { i18n } from "./i18n";
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

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(async () => {
	await i18n.changeLanguage("fr");
	vi.clearAllMocks();
});
it("localizes command failures while preserving opaque paths and OS details", async () => {
	const payload = "/projects/été/Projet inaccessible : x\nPermission denied (os error 13)";
	await i18n.changeLanguage("en");
	vi.mocked(invoke).mockRejectedValueOnce(`Projet inaccessible : ${payload}`);
	await expect(fileWorkspace.preferences("/fixture")).rejects.toBe(`Project inaccessible: ${payload}`);
	vi.mocked(invoke).mockRejectedValueOnce("Préférences de fichiers invalides");
	await expect(fileWorkspace.setPreferences("/fixture", defaultPreferences)).rejects.toBe(
		"Invalid file preferences",
	);
	await i18n.changeLanguage("fr");
	vi.mocked(invoke).mockRejectedValueOnce(`Projet inaccessible : ${payload}`);
	await expect(fileWorkspace.preferences("/fixture")).rejects.toBe(`Projet inaccessible : ${payload}`);
});
