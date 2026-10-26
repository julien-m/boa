/** One session-local return point, shared across projects and file spaces. */
import type { Selection } from "./models";

let saved: Selection | null = null;
export function rememberReadingReturn(selection: Selection | null): boolean {
	if (saved || !selection || selection.contextRef) return false;
	saved = selection;
	return true;
}
export function takeReadingReturn(): Selection | null {
	const result = saved;
	saved = null;
	return result;
}
