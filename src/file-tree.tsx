/** Lazily expands folders without indexing source code. */
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FileCode2, Folder, FolderGit2, FolderOpen, Link } from "lucide-react";
import { useState } from "react";
import { api } from "./api";
import type { DirectoryEntry, RepoStatus } from "./models";

interface TreeProps {
	project: string;
	path?: string;
	onOpen: (path: string) => void;
	selected?: string;
	repos: RepoStatus[];
	depth?: number;
}

function FileRow({
	entry,
	project,
	onOpen,
	selected,
	repos,
	depth = 0,
}: TreeProps & { entry: DirectoryEntry }) {
	const [expanded, setExpanded] = useState(false);
	const activeRepo = repos
		.filter((repo) => `${project}/${entry.path}`.startsWith(`${repo.path}/`))
		.sort((a, b) => b.path.length - a.path.length)[0];
	const relative = activeRepo ? `${project}/${entry.path}`.slice(activeRepo.path.length + 1) : "";
	const change = activeRepo?.changes.find((item) => item.path === relative);
	const handleOpen = (): void => (entry.directory ? setExpanded(!expanded) : onOpen(entry.path));
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
			<button
				type="button"
				data-testid={`file-${entry.path}`}
				className={`tree-row ${selected === entry.path ? "selected" : ""}`}
				style={{ paddingLeft: 12 + depth * 14 }}
				onClick={handleOpen}
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
			{expanded && (
				<FileTree
					project={project}
					path={entry.path}
					onOpen={onOpen}
					selected={selected}
					repos={repos}
					depth={depth + 1}
				/>
			)}
		</>
	);
}

export function FileTree({ project, path = "", onOpen, selected, repos, depth = 0 }: TreeProps) {
	const query = useQuery({
		queryKey: ["directory", project, path],
		queryFn: () => api.directory(project, path),
		staleTime: 15_000,
	});
	if (query.isPending)
		return (
			<p className="inline-status" data-testid="directory-loading">
				Chargement…
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
				query.data.map((entry) => (
					<FileRow
						key={entry.path}
						entry={entry}
						project={project}
						onOpen={onOpen}
						selected={selected}
						repos={repos}
						depth={depth}
					/>
				))
			) : (
				<p className="inline-status">Dossier vide</p>
			)}
		</div>
	);
}
