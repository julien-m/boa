import { defaultShortcuts, type SearchShortcuts } from "./file-workspace-api";
export function shortcutMatches(
	event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
	shortcut: string,
) {
	const parts = shortcut.split("+");
	return (
		(event.metaKey || event.ctrlKey) &&
		event.shiftKey === parts.includes("Shift") &&
		event.altKey === parts.includes("Alt") &&
		event.key.toUpperCase() === parts.at(-1)?.toUpperCase()
	);
}
export function validSearchShortcuts(value: SearchShortcuts) {
	const valid = (s: string) => /^Mod\+(?:Shift\+)?(?:Alt\+)?[A-Z]$/.test(s);
	return valid(value.contextual) && valid(value.global) && value.contextual !== value.global;
}
export function installSearchShortcuts(shortcuts = defaultShortcuts) {
	const listener = (event: KeyboardEvent) => {
		if ((event.target as HTMLElement | null)?.closest(".shortcut-field")) return;
		if (event.defaultPrevented) return;
		if (shortcutMatches(event, shortcuts.global)) {
			event.preventDefault();
			event.stopImmediatePropagation();
			window.dispatchEvent(new CustomEvent("boa:global-search"));
		} else if (shortcutMatches(event, shortcuts.contextual)) {
			const target = event.target as HTMLElement | null;
			if (target?.closest(".file-search-panel, .shortcut-field")) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (target?.closest("[data-file-browser]"))
				window.dispatchEvent(
					new CustomEvent("boa:tree-search", {
						detail: { root: target.closest<HTMLElement>("[data-file-browser]")?.dataset.fileBrowser },
					}),
				);
			else window.dispatchEvent(new CustomEvent("boa:find", { detail: { target } }));
		}
	};
	window.addEventListener("keydown", listener, true);
	return () => window.removeEventListener("keydown", listener, true);
}
