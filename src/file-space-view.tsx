import { FileCode2, Folder, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CodeViewer, disposeReaderModel } from "./code-viewer";
import { FileBrowser } from "./file-browser";
import { useFileEditing } from "./file-editing";
import { FileWorkspace } from "./file-workspace";
import { type FileSpace } from "./file-workspace-api";
import { useFileLabels } from "./file-workspace-labels";
import type { Selection } from "./models";

const key = (s: Selection) => JSON.stringify([s.project, s.path]);
export function FileSpaceView({ space, navigation }: { space: FileSpace; navigation: Selection | null }) {
	const l = useFileLabels();
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
	const open = (value: Selection, keep = false) =>
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
	useEffect(() => {
		if (navigation) {
			if (navigation.path.endsWith("/")) {
				setFolders((p) => ({
					...p,
					[navigation.project]: {
						path: navigation.path.slice(0, -1),
						requestId: navigation.navigationId ?? crypto.randomUUID(),
					},
				}));
			} else open(navigation);
		}
	}, [navigation]);
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
					{space.roots.length} {l.roots.toLowerCase()}
				</span>
			</header>
			<FileWorkspace
				libraryRoot={space.roots[0]}
				onOpen={(value) => open(value)}
				navigationKey={navigation?.navigationId}
				tree={
					<>
						{space.roots.map((root) => (
							<FileBrowser
								key={root}
								root={root}
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
										onClick={() => setState((s) => ({ ...s, selected: tab }))}
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
					<CodeViewer selection={state.selected} />
				</div>
			</FileWorkspace>
		</div>
	);
}
