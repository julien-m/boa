/** WebStorm-inspired workspace with persisted Files/Git/combined layouts. */
import {
	Columns2,
	FileCode2,
	FolderOpen,
	GitBranch,
	GitFork,
	PanelLeftClose,
	PanelLeftOpen,
	RefreshCw,
	Search,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { CodeViewer } from "./code-viewer";
import { FileTree } from "./file-tree";
import { GitPanel } from "./git-panel";
import type { Layout, Project, Selection, Summary } from "./models";
import { PanelResizer } from "./panel-resizer";
import { ProjectSearch } from "./project-search";

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
	const [layout, setLayout] = useState<Layout>(() => {
		const stored = localStorage.getItem("boa-layout");
		return stored === "git" || stored === "files" ? stored : "split";
	});
	const [showTree, setShowTree] = useState(true);
	const [searching, setSearching] = useState(false);
	const [folderError, setFolderError] = useState("");
	const containerRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const shortcut = (event: KeyboardEvent): void => {
			if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
			event.preventDefault();
			if (event.shiftKey) {
				setSearching(true);
				setShowTree(true);
				setLayout("files");
			} else window.dispatchEvent(new Event("boa:find"));
		};
		window.addEventListener("keydown", shortcut);
		return () => window.removeEventListener("keydown", shortcut);
	}, []);
	const [selection, setSelection] = useState<Selection | null>(null);
	useEffect(() => {
		if (navigation) {
			setSelection(navigation);
			setLayout("files");
		}
	}, [navigation]);
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
						title={t("project.openFolder")}
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
						title={t("project.filesAndGit")}
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
						title={t("project.refresh")}
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
				<div className={`file-workspace ${showTree ? "" : "no-tree"}`}>
					<aside className={`file-sidebar ${showTree ? "" : "collapsed"}`}>
						<div className="pane-heading">
							<span>
								{showTree ? (searching ? t("project.searchHeading") : t("project.filesHeading")) : ""}
							</span>
							<button
								type="button"
								className="icon-button"
								data-testid="toggle-project-search"
								title={t("project.search")}
								onClick={() => {
									setSearching(!searching);
									setShowTree(true);
								}}
							>
								<Search size={14} />
							</button>
							<button
								type="button"
								className="icon-button"
								data-testid="toggle-file-tree"
								title={showTree ? t("project.hideTree") : t("project.showTree")}
								onClick={() => setShowTree(!showTree)}
							>
								{showTree ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
							</button>
						</div>
						{showTree && (
							<div className="tree-scroll">
								{searching ? (
									<ProjectSearch project={project.path} onOpen={setSelection} />
								) : (
									<FileTree
										project={project.path}
										repos={repos}
										selected={!selection?.repo ? selection?.path : undefined}
										onOpen={(path) => setSelection({ project: project.path, path })}
									/>
								)}
							</div>
						)}
					</aside>
					<CodeViewer selection={selection} />
				</div>
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
