import { FileCode2, Folder, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { HistoryRestoration, RecordVisit } from "./app-history";
import { CodeViewer, disposeReaderModel } from "./code-viewer";
import { FileBrowser } from "./file-browser";
import { useFileEditing } from "./file-editing";
import { FileWorkspace } from "./file-workspace";
import { type FileSpace, spaceEntries } from "./file-workspace-api";
import { useFileLabels } from "./file-workspace-labels";
import type { Selection } from "./models";

const key = (s: Selection) => JSON.stringify([s.project, s.path]);
export function FileSpaceView({
	space,
	navigation,
	onVisit,
	restoration,
}: {
	space: FileSpace;
	navigation: Selection | null;
	onVisit?: RecordVisit;
	restoration?: HistoryRestoration | null;
}) {
	const l = useFileLabels();
	const entries = spaceEntries(space);
	const editing = useFileEditing();
	const [state, setState] = useState<{
		tabs: Selection[];
		preview: string | null;
		selected: Selection | null;
	}>({ tabs: [], preview: null, selected: null });
	const opened = useRef<Selection[]>([]);
	useEffect(() => {
		const previous = opened.current;
		opened.current = state.tabs;
		queueMicrotask(() => {
			for (const tab of previous)
				if (!state.tabs.some((t) => key(t) === key(tab))) disposeReaderModel(tab.project, tab.path);
		});
	}, [state.tabs]);
	const [folders, setFolders] = useState<Record<string, { path: string; requestId: string }>>({});
	const open = (selection: Selection, keep = false, record = true) => {
		const value = space.files?.includes(selection.project)
			? { ...selection, absolutePath: selection.project }
			: selection;
		if (record) onVisit?.({ selection: value, library: null });
		setState((current) => {
			const id = key(value);
			const exists = current.tabs.some((t) => key(t) === id);
			return {
				tabs: exists
					? current.tabs.map((t) => (key(t) === id ? value : t))
					: [
							...current.tabs.filter((t) => key(t) !== current.preview || !!editing.draft(t.project, t.path)),
							value,
						],
				preview: keep || editing.draft(value.project, value.path) ? null : exists ? current.preview : id,
				selected: value,
			};
		});
	};
	useEffect(() => {
		if (navigation && !restoration) {
			if (navigation.path.endsWith("/")) {
				setFolders((p) => ({
					...p,
					[navigation.project]: {
						path: navigation.path.slice(0, -1),
						requestId: navigation.navigationId ?? crypto.randomUUID(),
					},
				}));
			} else open(navigation, false, false);
		}
	}, [navigation]);
	useEffect(() => {
		if (!restoration) return;
		const visit = restoration.workspace;
		if (visit.selection) open(visit.selection, true, false);
		else setState((current) => ({ ...current, selected: null }));
		setFolders(
			Object.fromEntries(
				entries.map((root) => [
					root,
					{
						path: visit.folder?.root === root ? visit.folder.folder : "",
						requestId: String(restoration.id),
					},
				]),
			),
		);
	}, [restoration]);
	useEffect(
		() => () => {
			for (const tab of opened.current) disposeReaderModel(tab.project, tab.path);
		},
		[],
	);
	const close = (value: Selection) => {
		const draft = editing.draft(value.project, value.path);
		if (draft && draft.content !== draft.original && !window.confirm(l.discardChanges)) return;
		editing.cancel(value.project, value.path);
		const id = key(value);
		if (state.selected && key(state.selected) === id)
			onVisit?.({ selection: state.tabs.filter((tab) => key(tab) !== id).at(-1) ?? null, library: null });
		setState((current) => {
			const tabs = current.tabs.filter((t) => key(t) !== id);
			return {
				...current,
				tabs,
				selected: current.selected && key(current.selected) === id ? (tabs.at(-1) ?? null) : current.selected,
				preview: current.preview === id ? null : current.preview,
			};
		});
		disposeReaderModel(value.project, value.path);
	};
	return (
		<div className="project-view layout-files file-space-view" data-testid="file-space-view">
			<header className="project-header">
				<strong>
					<Folder size={16} /> {space.name}
				</strong>
				<span className="muted">
					{entries.length} {l.entries.toLowerCase()}
				</span>
			</header>
			<FileWorkspace
				libraryRoot={entries[0]}
				onVisit={onVisit}
				restoration={restoration}
				onOpen={(value) => open(value)}
				navigationKey={navigation?.navigationId}
				tree={
					<>
						{entries.map((root) => (
							<FileBrowser
								key={root}
								root={root}
								singleFile={space.files?.includes(root)}
								folder={folders[root]?.path ?? ""}
								folderRequestId={folders[root]?.requestId}
								selected={state.selected?.project === root ? state.selected.path : undefined}
								onOpen={(value) => open(value)}
								onKeepOpen={(value) => open(value, true)}
							/>
						))}
					</>
				}
			>
				<div className="file-editor">
					{!!state.tabs.length && (
						<div className="file-tabs" role="tablist" aria-label={l.files}>
							{state.tabs.map((tab) => (
								<div
									className={`file-tab ${state.selected && key(state.selected) === key(tab) ? "active" : ""}`}
									key={key(tab)}
								>
									<button
										type="button"
										role="tab"
										aria-selected={!!state.selected && key(state.selected) === key(tab)}
										data-hint={`${tab.project}/${tab.path}`}
										className={state.preview === key(tab) ? "preview-tab" : ""}
										onClick={() => {
											setState((s) => ({ ...s, selected: tab }));
											onVisit?.({ selection: tab, library: null });
										}}
										onDoubleClick={() => open(tab, true)}
									>
										<FileCode2 size={13} />
										{tab.path.split("/").pop()}
										{editing.draft(tab.project, tab.path)?.content !== undefined &&
										editing.draft(tab.project, tab.path)?.content !==
											editing.draft(tab.project, tab.path)?.original
											? " •"
											: ""}
									</button>
									<button type="button" className="tab-close" aria-label={l.close} onClick={() => close(tab)}>
										<X size={12} />
									</button>
								</div>
							))}
						</div>
					)}
					<CodeViewer
						selection={state.selected}
						onOpen={(value) => {
							if (entries.includes(value.project)) open(value, true);
							else window.dispatchEvent(new CustomEvent("boa:open-file", { detail: value }));
						}}
					/>
				</div>
			</FileWorkspace>
		</div>
	);
}
