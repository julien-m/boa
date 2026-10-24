import { useCallback, useRef, useState } from "react";
import type { Layout, Selection } from "./models";

export interface WorkspaceVisit {
	selection?: Selection | null;
	layout?: Layout;
	folder?: { root: string; folder: string };
	library?: { root: string; folder: string } | null;
}
export interface AppLocation {
	view: "overview" | "project" | "space" | "settings" | "archives";
	root?: string;
	space?: string;
	workspace?: WorkspaceVisit;
	request?: Selection;
}
export interface HistoryRestoration {
	id: number;
	workspace: WorkspaceVisit;
}
export function navigationVisit(selection: Selection): WorkspaceVisit {
	return selection.path.endsWith("/")
		? {
				selection: null,
				folder: { root: selection.project, folder: selection.path.slice(0, -1) },
				library: null,
				layout: "files",
			}
		: { selection, library: null, layout: "files" };
}
export type RecordVisit = (visit: WorkspaceVisit, replace?: boolean) => void;
export interface HistoryState {
	entries: AppLocation[];
	index: number;
}
const identity = (value: AppLocation) =>
	JSON.stringify(value, (key, item) => (key === "navigationId" || key === "request" ? undefined : item));
export function visitLocation(state: HistoryState, location: AppLocation): HistoryState {
	if (identity(state.entries[state.index]) === identity(location)) return state;
	const entries = [...state.entries.slice(0, state.index + 1), location].slice(-100);
	return { entries, index: entries.length - 1 };
}
export function useAppHistory() {
	const [state, setState] = useState<HistoryState>({ entries: [{ view: "overview" }], index: 0 });
	const current = useRef(state);
	const [restoration, setRestoration] = useState<HistoryRestoration | null>(null);
	const revision = useRef(0);
	const visit = useCallback((location: AppLocation) => {
		const next = visitLocation(current.current, location);
		if (next === current.current) {
			if (!location.request || location.request === current.current.entries[current.current.index].request)
				return;
			const updated = {
				...next,
				entries: next.entries.map((entry, index) => (index === next.index ? location : entry)),
			};
			current.current = updated;
			setState(updated);
			setRestoration(null);
			return;
		}
		current.current = next;
		setState(next);
		setRestoration(null);
	}, []);
	const record = useCallback<RecordVisit>(
		(workspace, replace = false) => {
			const location = current.current.entries[current.current.index];
			if (location.view !== "project" && location.view !== "space") return;
			const updated = { ...location, workspace: { ...location.workspace, ...workspace } };
			if (replace) {
				const next = {
					...current.current,
					entries: current.current.entries.map((entry, index) =>
						index === current.current.index ? updated : entry,
					),
				};
				current.current = next;
				setState(next);
			} else visit(updated);
		},
		[visit],
	);
	const go = useCallback((direction: -1 | 1) => {
		const next = current.current.index + direction;
		if (next < 0 || next >= current.current.entries.length) return;
		const value = { ...current.current, index: next };
		current.current = value;
		setState(value);
		setRestoration({
			id: ++revision.current,
			workspace: value.entries[next].workspace ?? { selection: null, library: null },
		});
	}, []);
	return {
		location: state.entries[state.index],
		visit,
		record,
		go,
		restoration,
	};
}
