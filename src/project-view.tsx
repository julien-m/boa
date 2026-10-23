/** WebStorm-inspired workspace with persisted Files/Git/combined layouts. */
import { Columns2, FileCode2, FolderOpen, GitBranch, GitFork, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { CodeViewer, disposeReaderModel } from "./code-viewer";
import { FileBrowser } from "./file-browser";
import { useFileEditing } from "./file-editing";
import { FileWorkspace } from "./file-workspace";
import { GitPanel } from "./git-panel";
import type { Layout, Project, Selection, Summary } from "./models";
import { PanelResizer } from "./panel-resizer";

export function ProjectView({
	project,
	summary,
	error,
	pending,
	onRefresh,
	navigation,
}: {
	navigation: Selection | null;
	project: Project;
	summary?: Summary;
	error?: string;
	pending: boolean;
	onRefresh: () => void;
}) {
	const { t } = useTranslation("workspace");
	const editing = useFileEditing();
	const [layout, setLayout] = useState<Layout>(() => {
		const stored = localStorage.getItem("boa-layout");
		return stored === "git" || stored === "files" ? stored : "split";
	});
	const [treeFolder, setTreeFolder] = useState({ path: "", requestId: "" });
	const [folderError, setFolderError] = useState("");
	const containerRef = useRef<HTMLDivElement>(null);
	const [files, setFiles] = useState<{
		tabs: Selection[];
		preview: string | null;
		selection: Selection | null;
	}>({ tabs: [], preview: null, selection: null });
	const { tabs, preview, selection } = files;
	const openPaths = useRef(new Set<string>());
	useEffect(() => {
		const previous = openPaths.current;
		const next = new Set(tabs.map((tab) => tab.path));
		openPaths.current = next;
		queueMicrotask(() => {
			for (const path of previous) if (!next.has(path)) disposeReaderModel(project.path, path);
		});
	}, [tabs, project.path]);
	useEffect(
		() => () => {
			const paths = openPaths.current;
			queueMicrotask(() => {
				for (const path of paths) disposeReaderModel(project.path, path);
			});
		},
		[project.path],
	);
	useEffect(() => {
		if (preview && editing.drafts[JSON.stringify([project.path, preview])])
			setFiles((current) => ({ ...current, preview: null }));
	}, [editing.drafts, preview, project.path]);
	const setSelection = useCallback((value: Selection | null): void => {
		setFiles((current) => ({ ...current, selection: value }));
	}, []);
	const openFile = useCallback((value: Selection, keep = false): void => {
		setFiles((current) => {
			const existing = current.tabs.some((tab) => tab.path === value.path);
			const next = existing
				? current.tabs.map((tab) => (tab.path === value.path ? value : tab))
				: [...current.tabs.filter((tab) => tab.path !== current.preview), value];
			return {
				tabs: next,
				selection: value,
				preview: keep
					? current.preview === value.path || !existing
						? null
						: current.preview
					: existing
						? current.preview
						: value.path,
			};
		});
	}, []);
	const closeFile = (path: string): void => {
		setFiles((current) => {
			const index = current.tabs.findIndex((tab) => tab.path === path);
			const next = current.tabs.filter((tab) => tab.path !== path);
			return {
				tabs: next,
				preview: current.preview === path ? null : current.preview,
				selection:
					!current.selection?.repo && current.selection?.path === path
						? (next[Math.min(index, next.length - 1)] ?? null)
						: current.selection,
			};
		});
	};

	useEffect(() => {
		if (navigation) {
			if (navigation.path.endsWith("/"))
				setTreeFolder({
					path: navigation.path.slice(0, -1),
					requestId: navigation.navigationId ?? crypto.randomUUID(),
				});
			else openFile(navigation);
			setLayout("files");
		}
	}, [navigation, openFile]);
	const repos = summary?.repos ?? [];
	const root = repos.find((repo) => repo.path === project.path) ?? repos[0];
	const handleLayout = (value: Layout): void => {
		setLayout(value);
		localStorage.setItem("boa-layout", value);
	};
	return (
		<div ref={containerRef} className={`project-view layout-${layout}`} data-testid="project-view">
			<header className="project-header">
				<div className="project-identity">
					<strong>{project.name}</strong>
					{root && (
						<span className="branch">
							<GitBranch size={13} />
							{root.branch}
						</span>
					)}
					<span className="project-path" title={project.path}>
						{project.path.replace(/^\/Users\/[^/]+/, "~")}
					</span>
				</div>
				<div className="view-switcher" role="group" aria-label={t("project.layout")}>
					<button
						type="button"
						data-testid="open-project-folder"
						data-hint={t("project.openFolder")}
						aria-label={t("project.openFolder")}
						onClick={() => {
							setFolderError("");
							void api.openProjectFolder(project.path).catch((error) => setFolderError(String(error)));
						}}
					>
						<FolderOpen size={14} />
						<span>Finder</span>
					</button>
					<button
						type="button"
						data-testid="layout-split"
						className={layout === "split" ? "active" : ""}
						aria-pressed={layout === "split"}
						onClick={() => handleLayout("split")}
						data-hint={t("project.filesAndGit")}
					>
						<Columns2 size={14} />
						<span>{t("project.mixed")}</span>
					</button>
					<button
						type="button"
						data-testid="layout-files"
						className={layout === "files" ? "active" : ""}
						aria-pressed={layout === "files"}
						onClick={() => handleLayout("files")}
					>
						<FileCode2 size={14} />
						<span>{t("project.files")}</span>
					</button>
					<button
						type="button"
						data-testid="layout-git"
						className={layout === "git" ? "active" : ""}
						aria-pressed={layout === "git"}
						onClick={() => handleLayout("git")}
					>
						<GitFork size={14} />
						<span>{t("project.git")}</span>
					</button>
					<button
						type="button"
						className="icon-button"
						data-testid="project-refresh"
						onClick={onRefresh}
						data-hint={t("project.refresh")}
						aria-label={t("project.refresh")}
					>
						<RefreshCw size={14} className={pending ? "spin" : ""} />
					</button>
				</div>
			</header>
			{folderError && (
				<div className="operation-banner error" role="alert">
					{folderError}
				</div>
			)}
			{error && (
				<div className="operation-banner error" data-testid="project-error">
					{error}
				</div>
			)}
			{summary?.scanLimited && <div className="scan-note">{t("project.scanLimited")}</div>}
			{layout !== "git" && (
				<FileWorkspace
					libraryRoot={project.path}
					onOpen={openFile}
					navigationKey={navigation?.navigationId}
					tree={
						<FileBrowser
							root={project.path}
							folder={treeFolder.path}
							folderRequestId={treeFolder.requestId}
							repos={repos}
							selected={!selection?.repo ? selection?.path : undefined}
							onOpen={openFile}
							onKeepOpen={(value) => openFile(value, true)}
						/>
					}
				>
					<div className="file-editor">
						{tabs.length > 0 && (
							<div className="file-tabs" role="tablist" aria-label={t("tabs.label")}>
								{tabs.map((tab) => (
									<div
										key={tab.path}
										className={`file-tab ${!selection?.repo && selection?.path === tab.path ? "active" : ""}`}
									>
										<button
											type="button"
											role="tab"
											aria-selected={!selection?.repo && selection?.path === tab.path}
											className={preview === tab.path ? "preview-tab" : ""}
											data-hint={tab.path}
											data-testid={`tab-${tab.path}`}
											onClick={() => setSelection(tab)}
											onDoubleClick={() => openFile(tab, true)}
										>
											<FileCode2 size={13} />
											{tab.path.split("/").pop()}
											{editing.draft(tab.project, tab.path)?.content !== undefined &&
												editing.draft(tab.project, tab.path)?.content !==
													editing.draft(tab.project, tab.path)?.original &&
												" •"}
										</button>
										<button
											type="button"
											className="tab-close"
											data-testid={`close-tab-${tab.path}`}
											aria-label={t("tabs.close", { path: tab.path })}
											data-hint={t("tabs.close", { path: tab.path })}
											onClick={() => closeFile(tab.path)}
										>
											<X size={12} />
										</button>
									</div>
								))}
							</div>
						)}
						<CodeViewer
							selection={selection}
							onOpen={(value) => {
								if (value.project === project.path) openFile(value, true);
								else window.dispatchEvent(new CustomEvent("boa:open-file", { detail: value }));
							}}
						/>
					</div>
				</FileWorkspace>
			)}
			{layout === "split" && <PanelResizer container={containerRef} />}
			{layout !== "files" && (
				<GitPanel
					project={project}
					repos={repos}
					expanded={layout === "git"}
					selection={selection}
					onSelect={setSelection}
				/>
			)}
		</div>
	);
}
