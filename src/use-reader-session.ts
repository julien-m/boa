/** Keep lightweight tab lists across workspace navigation; inactive readers remain unmounted. */
import { type SetStateAction, useCallback, useLayoutEffect, useRef, useState } from "react";
import { captureReaderSelection } from "./code-viewer";
import type { Selection } from "./models";

interface ReaderSession {
	tabs: Selection[];
	preview: string | null;
	selection: Selection | null;
}
const sessions = new Map<string, ReaderSession>();

export function useReaderSession(id: string) {
	const [state, setState] = useState<ReaderSession>(
		() => sessions.get(id) ?? { tabs: [], preview: null, selection: null },
	);
	const latest = useRef(state);
	latest.current = state;
	useLayoutEffect(() => {
		// Capture before the reader DOM and Monaco editors are removed, then release their models normally.
		return () => {
			const state = latest.current;
			const tabs = state.tabs.map(captureReaderSelection);
			const selection = state.selection ? captureReaderSelection(state.selection) : null;
			sessions.set(id, { tabs, preview: state.preview, selection });
		};
	}, [id]);
	const update = useCallback((action: SetStateAction<ReaderSession>) => {
		const selected = latest.current.selection;
		const captured = selected ? captureReaderSelection(selected) : null;
		setState((current) => {
			const next = typeof action === "function" ? action(current) : action;
			if (
				!captured?.markdownRestore ||
				(next.selection?.project === captured.project && next.selection.path === captured.path)
			)
				return next;
			return {
				...next,
				tabs: next.tabs.map((tab) =>
					tab.project === captured.project && tab.path === captured.path ? captured : tab,
				),
			};
		});
	}, []);
	return [state, update] as const;
}
