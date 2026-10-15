/** Shows a branch's contribution since its common ancestor with a chosen base. */
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, FileCode2, GitCompareArrows } from "lucide-react";
import { useState } from "react";
import { api } from "./api";
import type { Project, RepoStatus, Selection } from "./models";

export function BranchComparison({
	project,
	repo,
	onSelect,
	selection,
}: {
	project: Project;
	repo: RepoStatus;
	onSelect: (selection: Selection | null) => void;
	selection: Selection | null;
}) {
	const branches = useQuery({
		queryKey: ["branches", repo.path],
		queryFn: () => api.branches(project.path, repo.path),
		staleTime: 15_000,
	});
	const [baseChoice, setBase] = useState("");
	const [head, setHead] = useState("HEAD");
	const names = branches.data?.map((branch) => branch.name) ?? [];
	const base =
		baseChoice ||
		(names.includes("main") ? "main" : names.includes("master") ? "master" : (repo.upstream ?? "HEAD"));
	const comparison = useQuery({
		queryKey: ["comparison", repo.path, base, head],
		queryFn: () => api.compare(project.path, repo.path, base, head),
		enabled: Boolean(branches.data),
	});
	const options = (
		<>
			<option value="HEAD">HEAD (branche courante)</option>
			{branches.data?.map((branch) => (
				<option key={branch.name} value={branch.name}>
					{branch.name}
				</option>
			))}
		</>
	);
	return (
		<div className="branch-comparison" data-testid="branch-comparison">
			<div className="comparison-controls">
				<GitCompareArrows size={16} />
				<label>
					Base
					<select
						data-testid="compare-base"
						value={base}
						onChange={(event) => {
							setBase(event.target.value);
							onSelect(null);
						}}
					>
						{options}
					</select>
				</label>
				<ArrowRight size={14} />
				<label>
					Branche à relire
					<select
						data-testid="compare-head"
						value={head}
						onChange={(event) => {
							setHead(event.target.value);
							onSelect(null);
						}}
					>
						{options}
					</select>
				</label>
			</div>
			<p className="comparison-note">
				Impact depuis l’ancêtre commun · aucun changement de branche sur disque.
			</p>
			{branches.error && <p className="inline-error">{String(branches.error)}</p>}
			{comparison.error && (
				<p className="inline-error" data-testid="comparison-error">
					{String(comparison.error)}
				</p>
			)}
			{comparison.isFetching && <p className="inline-status">Comparaison des branches…</p>}
			{comparison.data && (
				<>
					<div className="content-toolbar">
						<span>{comparison.data.changes.length} fichiers modifiés par cette branche</span>
						<code className="small">
							{comparison.data.mergeBase.slice(0, 7)} → {comparison.data.head.slice(0, 7)}
						</code>
					</div>
					{comparison.data.changes.map((change) => (
						<button
							type="button"
							key={change.path}
							className={`change-row ${selection?.repo === repo.path && selection.path === change.path && selection.base === comparison.data?.mergeBase && selection.head === comparison.data?.head ? "selected" : ""}`}
							data-testid={`branch-change-${change.path}`}
							onClick={() => {
								if (comparison.data)
									onSelect({
										project: project.path,
										repo: repo.path,
										path: change.path,
										oldPath: change.oldPath,
										base: comparison.data.mergeBase,
										head: comparison.data.head,
									});
							}}
						>
							<FileCode2 size={13} />
							<span>{change.path}</span>
							<span className="file-state">{change.index}</span>
						</button>
					))}
					{comparison.data.changes.length === 0 && (
						<div className="empty-view">Aucune différence depuis l’ancêtre commun.</div>
					)}
				</>
			)}
		</div>
	);
}
