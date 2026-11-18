/** File-tree options supplied by the browser container and shared by its rows. */
import { createContext, useContext } from "react";
import type { FileMenuEvent } from "./file-context-menu";
import { sortFiles } from "./file-sort";
import { defaultPreferences, type FilePreferences } from "./file-workspace-api";
import type { DirectoryEntry } from "./models";

interface TreeOptions {
	preferences: FilePreferences;
	manage: boolean;
	busy: boolean;
	showAll: boolean;
	reveal: string;
	select?: (path: string) => void;
	contextMenu?: (event: FileMenuEvent, entry: DirectoryEntry, open: () => void, keep?: () => void) => void;
	update: (prefs: FilePreferences) => void;
}

export const TreeOptionsContext = createContext<TreeOptions>({
	preferences: defaultPreferences,
	manage: false,
	busy: false,
	showAll: false,
	reveal: "",
	update: () => {},
});

/** Reads display and editing options for the current file tree. */
export const useTreeOptions = (): TreeOptions => useContext(TreeOptionsContext);

/** Update an explicit folder selection and remove redundant descendant entries. */
export function toggleIncluded(prefs: FilePreferences, path: string, checked: boolean): FilePreferences {
	// Unchecking an inherited inclusion requires first splitting the ancestor selection in the chooser.
	return {
		...prefs,
		filtered: true,
		included: checked
			? [...prefs.included.filter((p) => !p.startsWith(`${path}/`) && p !== path), path]
			: prefs.included.filter((p) => p !== path && !p.startsWith(`${path}/`)),
	};
}

/** Apply the ordering configured for this tree. */
export function orderedEntries(entries: DirectoryEntry[], prefs: FilePreferences): DirectoryEntry[] {
	return sortFiles(entries, prefs.sort);
}
