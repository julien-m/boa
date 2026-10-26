/** Persistent context selection and a collapsible explanation beside the source reader. */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import {
	ArrowLeft,
	ArrowRight,
	ChevronDown,
	ChevronLeft,
	ChevronUp,
	FileCode2,
	Flag,
	GitBranch,
	Link2,
	Pencil,
	RefreshCw,
	Trash2,
	Undo2,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { type ContextPassage, type ContextStep, type ContextView, contextApi } from "./context-api";
import { useContextLabels } from "./context-labels";
import "./context-views.css";

export interface ActiveContext {
	viewId: string;
	stepId: string;
	passageId?: string;
}
export type OpenContextPassage = (view: ContextView, step: ContextStep, passage: ContextPassage) => void;

export function useContextViews(project: string) {
	const client = useQueryClient();
	const queryKey = ["context-views", project];
	const query = useQuery({
		queryKey,
		queryFn: () => contextApi.list(project),
		enabled: Boolean(project),
		refetchOnWindowFocus: false,
	});
	useEffect(() => {
		let disposed = false;
		let cleanup: (() => void) | undefined;
		void listen("boa:contexts-changed", () => {
			void client.invalidateQueries({ queryKey: ["context-views", project] });
		}).then(
			(unlisten) => {
				if (disposed) unlisten();
				else cleanup = unlisten;
			},
			() => {},
		);
		return () => {
			disposed = true;
			cleanup?.();
		};
	}, [client, project]);
	return {
		views: query.data ?? [],
		error: query.error ? String(query.error) : null,
		loading: query.isPending,
		refresh: () => client.invalidateQueries({ queryKey }),
	};
}

export function ContextSidebar({
	project,
	active,
	onOpen,
	onSelectView,
	selectedViewId,
}: {
	project: string;
	active: ActiveContext | null;
	onOpen: OpenContextPassage;
	onSelectView?: (view: ContextView | null) => void;
	selectedViewId?: string;
}) {
	const l = useContextLabels();
	const { views, error, loading, refresh } = useContextViews(project);
	const [selected, setSelected] = useState<string | null>(null);
	const [renaming, setRenaming] = useState<{ id: string; title: string; revision: number } | null>(null);
	const [removing, setRemoving] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	useEffect(() => {
		setSelected(null);
		setRenaming(null);
		setRemoving(null);
		setFailure(null);
	}, [project]);
	useEffect(() => {
		if (active?.viewId) setSelected(active.viewId);
	}, [active?.viewId, project]);
	useEffect(() => {
		if (selectedViewId) setSelected(selectedViewId);
	}, [selectedViewId, project]);
	const view = views.find((item) => item.id === selected);
	const choose = (next: ContextView | null) => {
		setSelected(next?.id ?? null);
		setRenaming(null);
		setRemoving(null);
		setFailure(null);
		onSelectView?.(next);
	};
	const mutate = async (operation: () => Promise<unknown>) => {
		setPending(true);
		setFailure(null);
		try {
			await operation();
			setRenaming(null);
			setRemoving(null);
			await refresh();
		} catch (error) {
			setFailure(String(error));
		} finally {
			setPending(false);
		}
	};
	return (
		<section className="context-sidebar" aria-label={l.views} data-testid="context-sidebar">
			<div className="context-sidebar-heading">
				{view ? (
					<button type="button" className="quiet-button" onClick={() => choose(null)}>
						<ChevronLeft size={13} /> {l.allViews}
					</button>
				) : (
					<span>{l.views}</span>
				)}
				<button
					type="button"
					className="icon-button"
					title={l.refresh}
					aria-label={l.refresh}
					onClick={() => void refresh()}
				>
					<RefreshCw size={13} />
				</button>
			</div>
			{(failure || error) && <p className="inline-error">{failure || error}</p>}
			{loading ? (
				<p className="context-empty">{l.loading}</p>
			) : view ? (
				<>
					<div className="context-view-introduction">
						{renaming?.id === view.id ? (
							<form
								className="context-rename"
								onSubmit={(event) => {
									event.preventDefault();
									if (renaming.title.trim())
										void mutate(() =>
											contextApi.save({ ...view, title: renaming.title.trim() }, renaming.revision),
										);
								}}
							>
								<label>
									{l.title}
									<input
										value={renaming.title}
										disabled={pending}
										onChange={(event) => setRenaming({ ...renaming, title: event.target.value })}
										maxLength={500}
									/>
								</label>
								<div className="context-inline-actions">
									<button type="submit" className="quiet-button" disabled={pending || !renaming.title.trim()}>
										{l.save}
									</button>
									<button
										type="button"
										className="quiet-button"
										disabled={pending}
										onClick={() => setRenaming(null)}
									>
										{l.cancel}
									</button>
								</div>
							</form>
						) : (
							<>
								<strong>{view.title}</strong>
								<div className="context-view-meta">
									<span>
										{view.kind === "findings" ? l.findings : l.walkthrough} · {l.steps(view.steps.length)}
									</span>
									<div className="context-inline-actions">
										<button
											type="button"
											className="icon-button"
											title={l.rename}
											aria-label={l.rename}
											onClick={() => setRenaming({ id: view.id, title: view.title, revision: view.revision })}
										>
											<Pencil size={12} />
										</button>
										<button
											type="button"
											className="icon-button"
											title={l.remove}
											aria-label={l.remove}
											onClick={() => setRemoving(view.id)}
										>
											<Trash2 size={12} />
										</button>
									</div>
								</div>
							</>
						)}
						{view.description && <p>{view.description}</p>}
						{removing === view.id && (
							<div className="context-remove-confirm">
								<p>{l.confirmRemove}</p>
								<div className="context-inline-actions">
									<button
										type="button"
										className="quiet-button"
										disabled={pending}
										onClick={() => void mutate(() => contextApi.remove(project, view.id))}
									>
										{l.remove}
									</button>
									<button
										type="button"
										className="quiet-button"
										disabled={pending}
										onClick={() => setRemoving(null)}
									>
										{l.cancel}
									</button>
								</div>
							</div>
						)}
					</div>
					<div className="context-step-list">
						{!view.steps.length && <p className="context-empty">{l.emptySteps}</p>}
						{view.steps.map((step, index) => (
							<Fragment key={step.id}>
								{step.group && step.group !== view.steps[index - 1]?.group && (
									<div className="context-step-group">{step.group}</div>
								)}
								<button
									type="button"
									className={`context-step ${active?.viewId === view.id && active.stepId === step.id ? "active" : ""}`}
									disabled={!step.passages.length}
									onClick={() => step.passages[0] && onOpen(view, step, step.passages[0])}
									data-testid="context-step"
								>
									<span className="context-step-number">
										{view.kind === "findings" ? <Flag size={12} /> : index + 1}
									</span>
									<span>
										<strong>{step.title}</strong>
										{step.passages[0] && <small>{passageLocation(step.passages[0])}</small>}
									</span>
								</button>
							</Fragment>
						))}
					</div>
				</>
			) : (
				<div className="context-view-list">
					{!views.length && <p className="context-empty">{l.empty}</p>}
					{views.map((item) => (
						<div className="context-view-card" key={item.id}>
							<button type="button" className="context-view-select" onClick={() => choose(item)}>
								{item.kind === "findings" ? <Flag size={14} /> : <GitBranch size={14} />}
								<span>
									<strong>{item.title}</strong>
									<small>
										{item.kind === "findings" ? l.findings : l.walkthrough} · {l.steps(item.steps.length)}
									</small>
								</span>
							</button>
							{item.description && <p>{item.description}</p>}
							{item.steps[0]?.passages[0] && (
								<button
									type="button"
									className="quiet-button context-open-first"
									onClick={() => {
										choose(item);
										onOpen(item, item.steps[0], item.steps[0].passages[0]);
									}}
								>
									{l.open} <ArrowRight size={12} />
								</button>
							)}
						</div>
					))}
				</div>
			)}
		</section>
	);
}

export const passageLocation = (passage: ContextPassage): string =>
	`${passage.path}:${passage.startLine}${passage.endLine === passage.startLine ? "" : `–${passage.endLine}`}`;

export function ContextExplanation({
	view,
	step,
	passageId,
	onOpen,
	onPrevious,
	onNext,
	onReturn,
	onRevealFiles,
	status,
}: {
	view: ContextView;
	step: ContextStep;
	passageId?: string;
	onOpen: OpenContextPassage;
	onPrevious?: () => void;
	onNext?: () => void;
	onReturn: () => void;
	onRevealFiles?: () => void;
	status?: "exact" | "relocated" | "needs-review";
}) {
	const l = useContextLabels();
	const [collapsed, setCollapsed] = useState(false);
	const index = view.steps.findIndex((item) => item.id === step.id);
	const role = (value: string | undefined) => {
		if (value === "cause") return l.cause;
		if (value === "consequence") return l.consequence;
		if (value === "guard") return l.guard;
		return value;
	};
	return (
		<section
			className={`context-explanation ${collapsed ? "collapsed" : ""}`}
			data-testid="context-explanation"
			aria-label={step.title}
		>
			<div className="context-explanation-toolbar">
				<span className="context-step-position">
					{view.kind === "findings"
						? l.finding(index + 1, view.steps.length)
						: l.step(index + 1, view.steps.length)}
					{step.group && <span> · {step.group}</span>}
				</span>
				<div className="context-inline-actions">
					<button
						type="button"
						className="quiet-button"
						onClick={onPrevious}
						disabled={!onPrevious}
						title={l.previous}
					>
						<ArrowLeft size={12} /> {l.previous}
					</button>
					<button type="button" className="quiet-button" onClick={onNext} disabled={!onNext} title={l.next}>
						{l.next} <ArrowRight size={12} />
					</button>
					<button type="button" className="quiet-button context-return" onClick={onReturn}>
						<Undo2 size={12} /> {l.return}
					</button>
					<button
						type="button"
						className="icon-button"
						aria-label={collapsed ? l.showExplanation : l.hideExplanation}
						title={collapsed ? l.showExplanation : l.hideExplanation}
						aria-expanded={!collapsed}
						onClick={() => setCollapsed(!collapsed)}
					>
						{collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
					</button>
				</div>
			</div>
			{!collapsed && (
				<div className="context-explanation-body">
					<div className="context-explanation-title">
						<strong>{step.title}</strong>
						{status === "needs-review" && <span className="context-anchor-notice">{l.needsReview}</span>}
						{status === "relocated" && <span className="context-anchor-relocated">{l.relocated}</span>}
					</div>
					{step.description && <p>{step.description}</p>}
					{!step.passages.length && <p className="context-empty">{l.emptyPassages}</p>}
					<div className={`context-passages ${view.kind === "findings" ? "finding-passages" : ""}`}>
						{step.passages.map((passage) => (
							<button
								type="button"
								key={passage.id}
								className={`context-passage ${passageId === passage.id ? "active" : ""}`}
								title={passageLocation(passage)}
								onClick={() => onOpen(view, step, passage)}
							>
								{role(passage.role) && <span className="context-passage-role">{role(passage.role)}</span>}
								<span className="context-passage-file">
									<Link2 size={12} /> <span>{passage.label || passageLocation(passage)}</span>
								</span>
								{passage.label && <small>{passageLocation(passage)}</small>}
								{passage.symbol && <small className="context-passage-symbol">{passage.symbol}</small>}
							</button>
						))}
					</div>
					{onRevealFiles && (
						<button type="button" className="quiet-button context-reveal" onClick={onRevealFiles}>
							<FileCode2 size={12} /> {l.revealFiles}
						</button>
					)}
				</div>
			)}
		</section>
	);
}
