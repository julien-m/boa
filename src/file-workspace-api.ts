import { invoke } from "@tauri-apps/api/core";
import { localizeNativeText } from "./native-text";
export interface FileSpace {
	id: string;
	name: string;
	roots: string[];
}
export interface FilePreferences {
	filtered: boolean;
	included: string[];
	pins: string[];
	sort: string;
}
export interface SearchShortcuts {
	contextual: string;
	global: string;
}
export interface WorkspaceState {
	spaces: FileSpace[];
	shortcuts: SearchShortcuts;
}
export interface FileHit {
	project: string;
	path: string;
	line: number;
	text: string;
	directory: boolean;
	kind: "path" | "content";
}
export interface LibraryImage {
	path: string;
	name: string;
	format: string;
	size: number;
	modified: number;
}
export const defaultPreferences: FilePreferences = { filtered: false, included: [], pins: [], sort: "name" };
export const defaultShortcuts: SearchShortcuts = { contextual: "Mod+F", global: "Mod+Shift+F" };
export function fileCommand<T>(request: Record<string, unknown>): Promise<T> {
	return invoke<T>("file_workspace", { request }).catch((error: unknown) => {
		throw localizeNativeText(String(error));
	});
}
export const fileWorkspace = {
	images: (root: string, folder: string): Promise<{ images: LibraryImage[]; limited: boolean }> =>
		fileCommand({ action: "images", root, folder }),
	thumbnail: (root: string, path: string): Promise<string> =>
		fileCommand({ action: "thumbnail", root, path }),
	state: (): Promise<WorkspaceState> => fileCommand({ action: "list" }),
	save: (space: FileSpace): Promise<FileSpace> => fileCommand({ action: "save-space", ...space }),
	remove: (id: string): Promise<boolean> => fileCommand({ action: "remove-space", id }),
	preferences: (root: string): Promise<FilePreferences> => fileCommand({ action: "preferences", root }),
	setPreferences: (root: string, preferences: FilePreferences): Promise<FilePreferences> =>
		fileCommand({ action: "set-preferences", root, preferences }),
	shortcuts: (shortcuts: SearchShortcuts): Promise<SearchShortcuts> =>
		fileCommand({ action: "set-shortcuts", shortcuts }),
	search: (
		roots: string[],
		query: string,
		mode: "paths" | "content" | "all",
	): Promise<{ matches: FileHit[]; limited: boolean; warning: string }> =>
		fileCommand({ action: "search", roots, query, mode }),
};
export function visiblePath(path: string, preferences: FilePreferences): boolean {
	return (
		!preferences.filtered ||
		[...preferences.included, ...preferences.pins].some(
			(p) => path === p || path.startsWith(`${p}/`) || p.startsWith(`${path}/`),
		)
	);
}
export function selectedPath(path: string, preferences: FilePreferences): boolean {
	return !preferences.filtered || preferences.included.some((p) => path === p || path.startsWith(`${p}/`));
}
