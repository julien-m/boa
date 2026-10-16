/** Shows a branch's contribution since its common ancestor with a chosen base. */
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, FileCode2, GitCompareArrows } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
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
			<option value="HEAD">{t("currentHead")}</option>
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
					{t("base")}
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
					{t("reviewBranch")}
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
			<p className="comparison-note">{t("comparisonNote")}</p>
			{branches.error && <p className="inline-error">{String(branches.error)}</p>}
			{comparison.error && (
				<p className="inline-error" data-testid="comparison-error">
					{String(comparison.error)}
				</p>
			)}
			{comparison.isFetching && <p className="inline-status">{t("comparingBranches")}</p>}
			{comparison.data && (
				<>
					<div className="content-toolbar">
						<span>{t("branchChangedFiles", { count: comparison.data.changes.length })}</span>
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
							<span className="file-state" title={changeLabels[change.index]}>
								{change.index}
							</span>
						</button>
					))}
					{comparison.data.changes.length === 0 && (
						<div className="empty-view">{t("noBranchDifference")}</div>
					)}
				</>
			)}
		</div>
	);
}
