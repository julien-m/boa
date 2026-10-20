/** Repository-scoped change trees and paginated history with a parent graph. */
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
	Check,
	ChevronDown,
	ExternalLink,
	FileCode2,
	FolderGit2,
	GitBranch,
	GitCommitHorizontal,
	GitFork,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { BranchComparison } from "./branch-comparison";
import { CodeViewer } from "./code-viewer";
import { commitGraph, type GraphRow } from "./commit-graph";
import { getLocale } from "./i18n";
import type { Change, Commit, Project, RepoStatus, Selection } from "./models";
import { PanelResizer } from "./panel-resizer";

interface GitPanelProps {
	project: Project;
	repos: RepoStatus[];
	expanded: boolean;
	selection: Selection | null;
	onSelect: (selection: Selection | null) => void;
}
export function GitPanel({ project, repos, expanded, selection, onSelect }: GitPanelProps) {
	const { t } = useTranslation("git");
	const [tab, setTab] = useState<"changes" | "history" | "compare">("changes");
	const [repoPath, setRepoPath] = useState("");
	const [branch, setBranch] = useState("");
	const [commitHash, setCommitHash] = useState("");
	const repo = repos.find((item) => item.path === repoPath) ?? repos[0];
	const [openError, setOpenError] = useState("");
	const remote = useQuery({
		queryKey: ["repository-url", project.path, repo?.path],
		queryFn: () => api.repositoryUrl(project.path, repo?.path ?? ""),
		enabled: Boolean(repo && !repo.error),
	});
	const detailRef = useRef<HTMLDivElement>(null);
	const changesSelection = useRef<Selection | null>(null);
	const selectTab = (next: "changes" | "history" | "compare"): void => {
		if (next === tab) return;
		if (tab === "changes") changesSelection.current = selection;
		onSelect(next === "changes" ? changesSelection.current : null);
		setTab(next);
	};
	useEffect(() => {
		if (!expanded || tab !== "changes" || !repo || repo.error) return;
		if (
			selection?.repo === repo.path &&
			!selection.hash &&
			!selection.base &&
			!selection.head &&
			repo.changes.some((change) => change.path === selection.path)
		)
			return;
		const staged = repo.changes.find((change) => change.index !== "." && change.index !== "?");
		const first = staged ?? repo.changes.find((change) => change.worktree !== "." || change.conflict);
		if (first)
			onSelect({
				project: project.path,
				repo: repo.path,
				path: first.path,
				oldPath: first.oldPath,
				side: staged ? "staged" : "working",
			});
	}, [expanded, tab, repo, selection, project.path, onSelect]);
	const handleRepository = (path: string): void => {
		setOpenError("");
		setRepoPath(path);
		changesSelection.current = null;
		onSelect(null);
		setBranch("");
		setCommitHash("");
	};
	return (
		<section className={`git-panel ${expanded ? "expanded" : ""}`} data-testid="git-panel">
			<div className="git-toolbar">
				<span className="git-label">
					<GitFork size={15} />
					Git
				</span>
				<button
					type="button"
					data-testid="git-changes-tab"
					className={`git-tab ${tab === "changes" ? "active" : ""}`}
					onClick={() => selectTab("changes")}
				>
					{t("changes")} <span>{repos.reduce((sum, item) => sum + item.changes.length, 0)}</span>
				</button>
				<button
					type="button"
					data-testid="git-history-tab"
					className={`git-tab ${tab === "history" ? "active" : ""}`}
					onClick={() => selectTab("history")}
				>
					{t("history")}
				</button>
				<button
					type="button"
					data-testid="git-compare-tab"
					className={`git-tab ${tab === "compare" ? "active" : ""}`}
					onClick={() => selectTab("compare")}
				>
					{t("compareBranches")}
				</button>
				<span className="muted small">{t("repositoryCount", { count: repos.length })}</span>
				{repo && (
					<button
						type="button"
						className="quiet-button git-remote-button"
						data-testid="open-repository"
						disabled={!remote.data}
						data-hint={
							remote.data
								? t("openRepositoryUrl", { url: remote.data })
								: remote.error
									? String(remote.error)
									: t("noRemote")
						}
						onClick={() => {
							setOpenError("");
							void api.openRepository(project.path, repo.path).catch((error) => setOpenError(String(error)));
						}}
					>
						<ExternalLink size={13} />
						<span>{t("openRepository")}</span>
					</button>
				)}
			</div>
			{openError && (
				<div className="operation-banner error" role="alert">
					{openError}
				</div>
			)}
			{!repo ? (
				<div className="empty-view" data-testid="git-empty">
					<FolderGit2 size={28} />
					<p>{t("noRepositories")}</p>
				</div>
			) : (
				<div className={`git-body ${expanded ? "with-preview" : ""}`}>
					<aside className="repo-list">
						<div className="pane-heading">{t("repositoriesHeading")}</div>
						{repos.map((item) => (
							<button
								type="button"
								key={item.path}
								data-testid={`repo-${item.path}`}
								className={`repo-button ${item.path === repo.path ? "selected" : ""}`}
								data-hint={item.path}
								onClick={() => handleRepository(item.path)}
							>
								<span>
									<FolderGit2 size={14} />
									<strong className="truncate">{item.name}</strong>
									<span className="file-state">{item.error ? "!" : item.changes.length || "✓"}</span>
								</span>
								<small>
									<GitBranch size={11} />
									{item.branch || t("noBranch")}
								</small>
							</button>
						))}
					</aside>
					<div
						ref={detailRef}
						className={`git-detail-workspace ${expanded ? "with-editor" : ""}`}
						data-testid="git-detail-workspace"
					>
						<div className="git-content">
							{repo.error ? (
								<p className="inline-error">{repo.error}</p>
							) : (
								<>
									{repo.operation && <div className="operation-banner">{repo.operation}</div>}
									{tab === "changes" ? (
										<ChangeList
											key={repo.path}
											project={project}
											repo={repo}
											onSelect={onSelect}
											selection={selection}
										/>
									) : tab === "compare" ? (
										<BranchComparison
											key={repo.path}
											project={project}
											repo={repo}
											onSelect={onSelect}
											selection={selection}
										/>
									) : (
										<History
											project={project}
											repo={repo}
											branch={branch}
											onBranch={(value) => {
												setBranch(value);
												setCommitHash("");
												onSelect(null);
											}}
											commitHash={commitHash}
											selection={selection}
											onCommit={(value) => {
												if (value !== commitHash) onSelect(null);
												setCommitHash(value);
											}}
											onSelect={onSelect}
										/>
									)}
								</>
							)}
						</div>
						{expanded && (
							<>
								<PanelResizer container={detailRef} vertical />
								<CodeViewer selection={selection} compact />
							</>
						)}
					</div>
				</div>
			)}
		</section>
	);
}

function ChangeList({
	project,
	repo,
	onSelect,
	selection,
}: {
	project: Project;
	repo: RepoStatus;
	onSelect: (selection: Selection) => void;
	selection: Selection | null;
}) {
	const { t } = useTranslation("git");
	const [grouped, setGrouped] = useState(true);
	const staged = repo.changes.filter((item) => item.index !== "." && item.index !== "?");
	const working = repo.changes.filter((item) => item.worktree !== "." || item.conflict);
	const handleSelect = (change: Change, side: "working" | "staged"): void =>
		onSelect({ project: project.path, repo: repo.path, path: change.path, oldPath: change.oldPath, side });
	return (
		<>
			<div className="content-toolbar">
				<span>{t("filesToCommit", { count: repo.changes.length })}</span>
				<label>
					{t("view")}{" "}
					<select
						data-testid="change-grouping"
						value={grouped ? "folders" : "list"}
						onChange={(event) => setGrouped(event.target.value === "folders")}
					>
						<option value="folders">{t("byFolder")}</option>
						<option value="list">{t("list")}</option>
					</select>
				</label>
			</div>
			{repo.changes.length === 0 ? (
				<div className="empty-view" data-testid="git-clean">
					<Check size={25} />
					<p>{t("noLocalChanges")}</p>
				</div>
			) : (
				<div className="change-sections">
					{staged.length > 0 && (
						<section>
							<h3>
								{t("stagedFiles")} <span>{staged.length}</span>
							</h3>
							<ChangeTree
								changes={staged}
								grouped={grouped}
								onSelect={(change) => handleSelect(change, "staged")}
								selected={
									selection?.repo === repo.path && selection.side === "staged" ? selection.path : undefined
								}
							/>
						</section>
					)}
					{working.length > 0 && (
						<section>
							<h3>
								{t("workingFiles")} <span>{working.length}</span>
							</h3>
							<ChangeTree
								changes={working}
								grouped={grouped}
								onSelect={(change) => handleSelect(change, "working")}
								selected={
									selection?.repo === repo.path && selection.side === "working" ? selection.path : undefined
								}
							/>
						</section>
					)}
				</div>
			)}
			<div className="tracking-note">
				{repo.upstream ? (
					<>
						<span className="outgoing">↑ {t("toPush", { amount: repo.ahead ?? "?" })}</span>
						<span>↓ {t("toPull", { amount: repo.behind ?? "?" })}</span>
						<span>
							{repo.upstream} · {t("localReferences")}
						</span>
					</>
				) : (
					t("noUpstream")
				)}
			</div>
		</>
	);
}

function ChangeTree({
	changes,
	grouped,
	onSelect,
	selected,
}: {
	changes: Change[];
	grouped: boolean;
	onSelect: (change: Change) => void;
	selected?: string;
}) {
	const { t } = useTranslation("git");
	const changeLabels: Record<string, string> = {
		M: t("modifiedFile"),
		A: t("addedFile"),
		D: t("deletedFile"),
		R: t("renamedFile"),
		C: t("copiedFile"),
		T: t("typeChangedFile"),
		U: t("unmergedFile"),
		"?": t("newFile"),
	};
	const groups = new Map<string, Change[]>();
	for (const change of changes) {
		const directory = grouped ? change.path.slice(0, change.path.lastIndexOf("/") + 1) || t("root") : "";
		const group = groups.get(directory) ?? [];
		group.push(change);
		groups.set(directory, group);
	}
	const rows = (items: Change[]) =>
		items.map((change) => (
			<button
				type="button"
				key={change.path}
				data-testid={`change-${change.path}`}
				className={`change-row ${selected === change.path ? "selected" : ""}`}
				aria-pressed={selected === change.path}
				data-hint={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
				onClick={() => onSelect(change)}
			>
				<FileCode2 size={13} />
				<span>{grouped ? change.path.split("/").pop() : change.path}</span>
				<span
					className={`file-state ${change.conflict ? "error" : ""}`}
					title={
						change.conflict
							? t("conflict")
							: [...new Set(`${change.index}${change.worktree}`)]
									.map((code) => changeLabels[code])
									.filter(Boolean)
									.join(" · ")
					}
				>
					{change.conflict
						? t("conflict")
						: change.index === "?"
							? t("newFile")
							: `${change.index}${change.worktree}`.replaceAll(".", "")}
				</span>
			</button>
		));
	return (
		<div>
			{[...groups].map(([folder, items]) =>
				grouped ? (
					<details open key={folder}>
						<summary data-testid={`change-folder-${folder}`}>
							<ChevronDown size={12} />
							{folder}
							<span>{items.length}</span>
						</summary>
						{rows(items)}
					</details>
				) : (
					<div key="flat">{rows(items)}</div>
				),
			)}
		</div>
	);
}

function History({
	project,
	repo,
	branch,
	onBranch,
	commitHash,
	onCommit,
	onSelect,
	selection,
}: {
	selection: Selection | null;
	project: Project;
	repo: RepoStatus;
	branch: string;
	onBranch: (branch: string) => void;
	commitHash: string;
	onCommit: (hash: string) => void;
	onSelect: (selection: Selection) => void;
}) {
	const { t } = useTranslation("git");
	const branches = useQuery({
		queryKey: ["branches", project.path, repo.path],
		queryFn: () => api.branches(project.path, repo.path),
		staleTime: 15_000,
	});
	const history = useInfiniteQuery({
		queryKey: ["history", project.path, repo.path, branch],
		initialPageParam: 0,
		queryFn: ({ pageParam }) => api.history(project.path, repo.path, pageParam, branch),
		getNextPageParam: (last, pages) => (last.length === 100 ? pages.length * 100 : undefined),
	});
	const commits = history.data?.pages.flat() ?? [];
	const selected = commits.find((item) => item.hash === commitHash) ?? commits[0];
	const commitFiles = useQuery({
		queryKey: ["commit-files", project.path, repo.path, selected?.hash],
		queryFn: () => api.commitFiles(project.path, repo.path, selected?.hash ?? ""),
		enabled: Boolean(selected),
	});
	const graph = commitGraph(commits);
	const graphWidth = Math.max(24, ...graph.map((row) => row.lanes * 14 + 10));
	return (
		<>
			<div className="content-toolbar">
				<label>
					<GitBranch size={13} />
					<select
						data-testid="history-branch"
						aria-label={t("filterHistoryByBranch")}
						value={branch}
						onChange={(event) => onBranch(event.target.value)}
					>
						<option value="">{t("allBranches")}</option>
						<optgroup label={t("localBranches")}>
							{branches.data
								?.filter((item) => !item.remote)
								.map((item) => (
									<option key={item.name} value={item.name}>
										{item.current ? "● " : ""}
										{item.name}
									</option>
								))}
						</optgroup>
						<optgroup label={t("remoteBranches")}>
							{branches.data
								?.filter((item) => item.remote)
								.map((item) => (
									<option key={item.name} value={item.name}>
										{item.name}
									</option>
								))}
						</optgroup>
					</select>
				</label>
				<span className="small">{t("commitCount", { count: commits.length })}</span>
			</div>
			{branches.error && (
				<p className="inline-error">{t("branchesError", { error: String(branches.error) })}</p>
			)}
			{history.error && <p className="inline-error">{String(history.error)}</p>}
			{history.isPending && <p className="inline-status">{t("loadingHistory")}</p>}
			<div className="history-columns">
				<div className="commit-list" data-testid="commit-list">
					{commits.map((commit, index) => (
						<button
							type="button"
							data-testid={`commit-${commit.hash}`}
							key={commit.hash}
							className={`commit-row ${commit.hash === selected?.hash ? "selected" : ""}`}
							onClick={() => {
								if (commit.hash !== selected?.hash) onCommit(commit.hash);
							}}
						>
							<Graph row={graph[index]} width={graphWidth} />
							<span className="commit-copy">
								<strong>{commit.subject}</strong>
								<small>
									{commit.author} · {commit.hash.slice(0, 7)}{" "}
									{commit.refs && <span className="ref-label">{commit.refs}</span>}
								</small>
							</span>
							<time title={commit.date}>
								{new Date(commit.date).toLocaleDateString(getLocale(), { day: "numeric", month: "short" })}
							</time>
						</button>
					))}
					{!history.isPending && !commits.length && !history.error && (
						<p className="inline-status">{t("noCommits")}</p>
					)}
					{history.hasNextPage && (
						<button
							type="button"
							className="quiet-button"
							data-testid="history-more"
							disabled={history.isFetchingNextPage}
							onClick={() => {
								void history.fetchNextPage();
							}}
						>
							{history.isFetchingNextPage ? t("loading") : t("loadMoreCommits")}
						</button>
					)}
				</div>
				{selected && (
					<aside className="commit-details" data-testid="commit-details">
						<CommitDetails commit={selected} />
						{commitFiles.error && <p className="inline-error">{String(commitFiles.error)}</p>}
						<ChangeTree
							changes={commitFiles.data ?? []}
							selected={
								selection?.repo === repo.path && selection.hash === selected.hash ? selection.path : undefined
							}
							grouped
							onSelect={(change) =>
								onSelect({
									project: project.path,
									repo: repo.path,
									path: change.path,
									oldPath: change.oldPath,
									hash: selected.hash,
								})
							}
						/>
					</aside>
				)}
			</div>
		</>
	);
}

function CommitDetails({ commit }: { commit: Commit }) {
	const { t } = useTranslation("git");
	return (
		<>
			<GitCommitHorizontal size={18} />
			<h3>{commit.subject}</h3>
			<p>
				{commit.author}
				<br />
				{new Date(commit.date).toLocaleString(getLocale())}
			</p>
			<code>{commit.hash.slice(0, 12)}</code>
			<h4>{t("commitFiles")}</h4>
		</>
	);
}
function Graph({ row, width }: { row: GraphRow; width: number }) {
	const { t } = useTranslation("git");
	return (
		<svg width={width} height="52" className="commit-graph" aria-label={t("commitRelations")} role="img">
			{row.edges.map((edge) => (
				<path
					key={`${edge.from}-${edge.to}`}
					d={
						edge.parent
							? `M ${edge.from * 14 + 10} 26 C ${edge.from * 14 + 10} 40 ${edge.to * 14 + 10} 40 ${edge.to * 14 + 10} 52`
							: `M ${edge.from * 14 + 10} 0 C ${edge.from * 14 + 10} 26 ${edge.to * 14 + 10} 26 ${edge.to * 14 + 10} 52`
					}
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					opacity=".55"
				/>
			))}
			<path d={`M ${row.lane * 14 + 10} 0 V 26`} stroke="currentColor" opacity=".55" />
			<circle cx={row.lane * 14 + 10} cy="26" r="3" fill="currentColor" />
		</svg>
	);
}
