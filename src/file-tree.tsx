/** Lazily expands folders without indexing source code. */
import { useQuery } from "@tanstack/react-query";
import {
	ChevronDown,
	ChevronRight,
	FileCode2,
	Folder,
	FolderGit2,
	FolderOpen,
	Images,
	Link,
	Pin,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { orderedEntries, toggleIncluded, useTreeOptions } from "./file-browser";
import { useImageLibrary, useLibraryFolder } from "./file-workspace";
import { selectedPath, visiblePath } from "./file-workspace-api";
import { useFileLabels } from "./file-workspace-labels";
import type { DirectoryEntry, RepoStatus } from "./models";

interface TreeProps {
	project: string;
	path?: string;
	onOpen: (path: string) => void;
	onKeepOpen?: (path: string) => void;
	selected?: string;
	repos: RepoStatus[];
	depth?: number;
}

function FileRow({
	entry,
	project,
	onOpen,
	onKeepOpen,
	selected,
	repos,
	depth = 0,
}: TreeProps & { entry: DirectoryEntry }) {
	const options = useTreeOptions();
	const openLibrary = useImageLibrary();
	const chooseFolder = useLibraryFolder();
	const l = useFileLabels();
	const [expanded, setExpanded] = useState(false);
	const activeRepo = repos
		.filter((repo) => `${project}/${entry.path}`.startsWith(`${repo.path}/`))
		.sort((a, b) => b.path.length - a.path.length)[0];
	const relative = activeRepo ? `${project}/${entry.path}`.slice(activeRepo.path.length + 1) : "";
	const change = activeRepo?.changes.find((item) => item.path === relative);
	const handleOpen = (): void => {
		if (entry.directory) {
			setExpanded(!expanded);
			chooseFolder?.(project, entry.path);
		} else onOpen(entry.path);
	};
	const Icon = entry.symlink
		? Link
		: entry.repository
			? FolderGit2
			: entry.directory
				? expanded
					? FolderOpen
					: Folder
				: FileCode2;
	return (
		<>
			<div className="tree-row-wrapper">
				{options.manage && (
					<input
						type="checkbox"
						aria-label={`${l.choose} ${entry.path}`}
						checked={selectedPath(entry.path, options.preferences)}
						disabled={
							options.busy ||
							(options.preferences.filtered &&
								options.preferences.included.some((p) => entry.path.startsWith(`${p}/`)))
						}
						onChange={(e) =>
							options.update(toggleIncluded(options.preferences, entry.path, e.target.checked))
						}
					/>
				)}
				<button
					type="button"
					data-testid={`file-${entry.path}`}
					className={`tree-row ${selected === entry.path ? "selected" : ""}`}
					style={{ paddingLeft: 12 + depth * 14 }}
					onClick={handleOpen}
					onDoubleClick={() => {
						if (!entry.directory) onKeepOpen?.(entry.path);
					}}
					title={entry.path}
					aria-expanded={entry.directory ? expanded : undefined}
				>
					{entry.directory ? (
						expanded ? (
							<ChevronDown size={12} />
						) : (
							<ChevronRight size={12} />
						)
					) : (
						<span className="tree-spacer" />
					)}
					<Icon size={14} />
					<span className="truncate">{entry.name}</span>
					{entry.repository && <span className="mini-tag">Git</span>}
					{change && (
						<span className="file-state">
							{change.conflict ? "!" : change.index !== "." ? change.index : change.worktree}
						</span>
					)}
				</button>
				{entry.directory && openLibrary && (
					<button
						type="button"
						className="tree-inline-pin icon-button"
						aria-label={`${l.folderImages} : ${entry.path}`}
						title={l.folderImages}
						onClick={() => openLibrary(project, entry.path)}
					>
						<Images size={13} />
					</button>
				)}
				<button
					type="button"
					disabled={options.busy}
					className={`tree-inline-pin icon-button ${options.preferences.pins.includes(entry.path) ? "pinned" : ""}`}
					title={l.pin}
					aria-label={`${l.pin} ${entry.path}`}
					onClick={() =>
						options.update({
							...options.preferences,
							pins: options.preferences.pins.includes(entry.path)
								? options.preferences.pins.filter((p) => p !== entry.path)
								: [...options.preferences.pins, entry.path],
						})
					}
				>
					<Pin size={12} />
				</button>
			</div>
			{expanded && (
				<FileTree
					project={project}
					path={entry.path}
					onOpen={onOpen}
					onKeepOpen={onKeepOpen}
					selected={selected}
					repos={repos}
					depth={depth + 1}
				/>
			)}
		</>
	);
}

export function FileTree({ project, path = "", onOpen, onKeepOpen, selected, repos, depth = 0 }: TreeProps) {
	const { t } = useTranslation("workspace");
	const options = useTreeOptions();
	const query = useQuery({
		queryKey: ["directory", project, path],
		queryFn: () => api.directory(project, path),
		staleTime: 15_000,
	});
	if (query.isPending)
		return (
			<p className="inline-status" data-testid="directory-loading">
				{t("tree.loading")}
			</p>
		);
	if (query.error)
		return (
			<p className="inline-error" data-testid="directory-error">
				{String(query.error)}
			</p>
		);
	return (
		<div data-testid={`directory-${path || "root"}`}>
			{query.data.length ? (
				orderedEntries(query.data, options.preferences)
					.filter((entry) => options.showAll || visiblePath(entry.path, options.preferences))
					.map((entry) => (
						<FileRow
							key={entry.path}
							entry={entry}
							project={project}
							onOpen={onOpen}
							onKeepOpen={onKeepOpen}
							selected={selected}
							repos={repos}
							depth={depth}
						/>
					))
			) : (
				<p className="inline-status">{t("tree.empty")}</p>
			)}
		</div>
	);
}
