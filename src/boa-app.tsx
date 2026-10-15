/** Project dashboard, pinned navigation and native project import. */
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { open } from "@tauri-apps/plugin-dialog";
import {
	ArrowDown,
	ArrowUp,
	ArrowUpRight,
	Check,
	CircleAlert,
	FilePenLine,
	FolderPlus,
	GitBranch,
	HardDrive,
	LayoutDashboard,
	Pin,
	RefreshCw,
	Search,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { api } from "./api";
import type { Selection } from "./models";
import { countRepos, type Project, type Summary } from "./models";
import { parseNavigation } from "./navigation";
import { ProjectView } from "./project-view";
import "./workspace.css";

export default function App() {
	const client = useQueryClient();
	const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
	const ordered = [...(projects.data ?? [])].sort(
		(a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name),
	);
	const summaries = useQueries({
		queries: ordered.map((project) => ({
			queryKey: ["summary", project.path],
			queryFn: () => api.summary(project.path),
			staleTime: 25_000,
			refetchInterval: 60_000,
			retry: false,
		})),
	});
	const [navigation, setNavigation] = useState<(Selection & { source: string }) | null>(null);
	const [guidancePaused, setGuidancePaused] = useState(false);
	const pausedRef = useRef(false);
	pausedRef.current = guidancePaused;
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [onlyChanges, setOnlyChanges] = useState(false);
	const [sort, setSort] = useState(() => localStorage.getItem("boa-project-sort") ?? "name");
	const [display, setDisplay] = useState(() => localStorage.getItem("boa-project-display") ?? "grid");
	const [notice, setNotice] = useState("");
	useEffect(() => {
		let disposed = false;
		let cleanup: (() => void) | undefined;
		const handleLinks = async (urls: string[]): Promise<void> => {
			if (pausedRef.current || disposed) return;
			try {
				const raw = urls.at(-1);
				if (!raw) return;
				const request = parseNavigation(raw);
				const target = await api.navigate(request.file);
				if (disposed || pausedRef.current) return;
				setSelectedPath(target.project);
				setNavigation({
					...target,
					line: request.line,
					endLine: request.endLine,
					source: request.source,
					navigationId: crypto.randomUUID(),
				});
			} catch (error) {
				if (!disposed) setNotice(String(error));
			}
		};
		const subscribe = async (): Promise<void> => {
			try {
				const unlisten = await onOpenUrl((urls) => {
					void handleLinks(urls);
				});
				if (disposed) {
					unlisten();
					return;
				}
				cleanup = unlisten;
				const urls = await getCurrent();
				if (urls) await handleLinks(urls);
			} catch (error) {
				if (!disposed) setNotice(`Navigation CLI indisponible : ${String(error)}`);
			}
		};
		void subscribe();
		return () => {
			disposed = true;
			cleanup?.();
		};
	}, []);
	useEffect(() => {
		let disposed = false;
		let cleanup: (() => void) | undefined;
		void listen("boa:projects-changed", () => {
			void client.invalidateQueries({ queryKey: ["projects"] });
		})
			.then((unlisten) => {
				if (disposed) unlisten();
				else cleanup = unlisten;
			})
			.catch((error: unknown) => setNotice(`Actualisation CLI indisponible : ${String(error)}`));
		return () => {
			disposed = true;
			cleanup?.();
		};
	}, [client]);
	const selected = ordered.find((project) => project.path === selectedPath);
	const selectedIndex = ordered.findIndex((project) => project.path === selectedPath);
	const selectedSummary = selectedIndex >= 0 ? summaries[selectedIndex] : undefined;
	const allRepos = summaries.flatMap((summary) => summary.data?.repos ?? []);
	const counts = countRepos(allRepos);
	const scanning = summaries.filter((summary) => summary.isFetching).length;
	const handleRefresh = (): void => {
		void client.invalidateQueries();
	};
	const handlePin = async (project: Project): Promise<void> => {
		try {
			await api.pin(project.path, !project.pinned);
			await client.invalidateQueries({ queryKey: ["projects"] });
		} catch (error) {
			setNotice(String(error));
		}
	};
	const handleImport = async (): Promise<void> => {
		try {
			const path = await open({ directory: true, multiple: false, title: "Ajouter un projet à BOA" });
			if (typeof path !== "string") return;
			const project = await api.add(path);
			await client.invalidateQueries({ queryKey: ["projects"] });
			setSelectedPath(project.path);
		} catch (error) {
			setNotice(String(error));
		}
	};
	const handleProjectRefresh = (): void => {
		if (selected) {
			void client.invalidateQueries({ queryKey: ["summary", selected.path] });
			void client.invalidateQueries({ queryKey: ["directory", selected.path] });
			void client.invalidateQueries({ queryKey: ["preview"] });
			void client.invalidateQueries({ queryKey: ["history"] });
			void client.invalidateQueries({ queryKey: ["branches"] });
			void client.invalidateQueries({ queryKey: ["comparison"] });
		}
	};
	const filtered = ordered
		.filter(
			(project, index) =>
				project.name.toLowerCase().includes(search.toLowerCase()) &&
				(!onlyChanges ||
					Boolean(
						summaries[index]?.data?.repos.some(
							(repo) => repo.changes.length > 0 || (repo.ahead ?? 0) > 0 || repo.operation || repo.error,
						),
					)),
		)
		.sort((left, right) => {
			const leftSummary = summaries[ordered.indexOf(left)]?.data;
			const rightSummary = summaries[ordered.indexOf(right)]?.data;
			if (sort === "recent")
				return (
					(rightSummary?.updatedAt ?? 0) - (leftSummary?.updatedAt ?? 0) ||
					left.name.localeCompare(right.name)
				);
			if (sort === "changes")
				return (
					countRepos(rightSummary?.repos ?? []).files - countRepos(leftSummary?.repos ?? []).files ||
					left.name.localeCompare(right.name)
				);
			return sort === "reverse" ? right.name.localeCompare(left.name) : left.name.localeCompare(right.name);
		});
	return (
		<div className="app-shell">
			<header className="titlebar">
				<div className="brand">
					<span className="brand-mark">b.</span>
					<strong>boa</strong>
					<span className="brand-divider" />
					<span className="muted">Project space</span>
				</div>
				<div className="titlebar-right">
					{navigation && (
						<button
							type="button"
							data-testid="guidance-toggle"
							className="guidance-badge"
							title="Source déclarée par la commande reçue ; cliquer pour suspendre ou reprendre le guidage"
							onClick={() => setGuidancePaused(!guidancePaused)}
						>
							{guidancePaused ? "Guidage suspendu" : `Repère reçu · ${navigation.source}`}
							<span>{guidancePaused ? "Reprendre" : "Reprendre la main"}</span>
						</button>
					)}
					<span className="local-dot" />
					Sur ce Mac
					<button
						type="button"
						data-testid="refresh-all"
						className="icon-button"
						onClick={handleRefresh}
						title="Actualiser les projets"
					>
						<RefreshCw size={14} className={scanning ? "spin" : ""} />
					</button>
				</div>
			</header>
			<div className="app-content">
				<nav className="navigation" aria-label="Navigation principale">
					<div className="nav-section-title">ESPACE DE TRAVAIL</div>
					<button
						type="button"
						data-testid="dashboard-nav"
						className={`nav-button ${!selected ? "selected" : ""}`}
						onClick={() => setSelectedPath(null)}
					>
						<LayoutDashboard size={16} />
						Vue d’ensemble
					</button>
					<div className="nav-section-title pinned-heading">
						PROJETS ÉPINGLÉS <span>{ordered.filter((project) => project.pinned).length}</span>
					</div>
					<div className="pinned-list">
						{ordered
							.filter((project) => project.pinned)
							.map((project) => {
								const summary = summaries[ordered.indexOf(project)];
								return (
									<button
										type="button"
										key={project.path}
										data-testid={`nav-project-${project.name}`}
										className={`nav-project ${selected?.path === project.path ? "selected" : ""}`}
										onClick={() => setSelectedPath(project.path)}
										title={project.path}
									>
										<span className="project-initial">{project.name[0]?.toUpperCase()}</span>
										<span className="nav-project-copy">
											<strong>{project.name}</strong>
											<SidebarCounts summary={summary.data} error={Boolean(summary.error)} />
										</span>
									</button>
								);
							})}
					</div>
					<div className="sidebar-legend">
						<span>
							<FilePenLine size={11} />
							Fichiers à committer
						</span>
						<span>
							<ArrowUp size={11} />
							Commits à pousser
						</span>
					</div>
					<button
						type="button"
						data-testid="add-project"
						className="nav-button add-project"
						onClick={() => {
							void handleImport();
						}}
					>
						<FolderPlus size={15} />
						Ajouter un projet
					</button>
					<div className="nav-bottom">
						<HardDrive size={13} />
						Local · Git système
					</div>
				</nav>
				<main className="main-content">
					{notice && (
						<div className="app-notice" role="alert" data-testid="app-notice">
							<span>{notice}</span>
							<button
								type="button"
								className="icon-button"
								data-testid="dismiss-notice"
								onClick={() => setNotice("")}
							>
								×
							</button>
						</div>
					)}
					{projects.error ? (
						<div className="empty-view error">{String(projects.error)}</div>
					) : projects.isPending ? (
						<div className="empty-view" data-testid="projects-loading">
							Chargement des projets…
						</div>
					) : selected ? (
						<ErrorBoundary
							key={selected.path}
							fallbackRender={({ error }) => <div className="empty-view error">{String(error)}</div>}
						>
							<ProjectView
								key={selected.path}
								navigation={navigation?.project === selected.path ? navigation : null}
								project={selected}
								summary={selectedSummary?.data}
								pending={selectedSummary?.isFetching ?? false}
								error={selectedSummary?.error ? String(selectedSummary.error) : undefined}
								onRefresh={handleProjectRefresh}
							/>
						</ErrorBoundary>
					) : (
						<div className="dashboard" data-testid="dashboard">
							<div className="eyebrow">VOTRE ESPACE DE TRAVAIL</div>
							<h1>Les projets, en un regard.</h1>
							<p className="dashboard-intro">Ce qui a changé. Ce qui reste à relire.</p>
							<div className="dashboard-summary" data-testid="dashboard-counts">
								<div>
									<strong>{ordered.length}</strong>
									<span>projets suivis</span>
								</div>
								<div>
									<strong>{counts.files}</strong>
									<span>fichiers à committer</span>
								</div>
								<div>
									<strong>{counts.ahead}</strong>
									<span>commits à pousser connus</span>
								</div>
								<div className="summary-caption">
									{scanning ? `${scanning} projets en cours d’analyse…` : "Actualisation toutes les minutes"}
									{counts.errors > 0 && <span className="error">{counts.errors} dépôts inaccessibles</span>}
								</div>
							</div>
							<div className="dashboard-toolbar">
								<h2>
									Vos projets <span>{filtered.length}</span>
								</h2>
								<div className="dashboard-filters">
									<select
										aria-label="Trier les projets"
										data-testid="project-sort"
										value={sort}
										onChange={(event) => {
											setSort(event.target.value);
											localStorage.setItem("boa-project-sort", event.target.value);
										}}
									>
										<option value="name">Nom A → Z</option>
										<option value="reverse">Nom Z → A</option>
										<option value="recent">Activité récente</option>
										<option value="changes">Fichiers à committer</option>
									</select>
									<select
										aria-label="Présentation des projets"
										data-testid="project-display"
										value={display}
										onChange={(event) => {
											setDisplay(event.target.value);
											localStorage.setItem("boa-project-display", event.target.value);
										}}
									>
										<option value="grid">Grille</option>
										<option value="list">Liste</option>
									</select>
									<label className="search-field">
										<Search size={14} />
										<input
											data-testid="project-search"
											placeholder="Rechercher un projet"
											value={search}
											onChange={(event) => setSearch(event.target.value)}
											aria-label="Rechercher un projet"
										/>
									</label>
									<button
										type="button"
										data-testid="filter-changes"
										aria-pressed={onlyChanges}
										className={`quiet-button ${onlyChanges ? "selected" : ""}`}
										onClick={() => setOnlyChanges(!onlyChanges)}
									>
										<FilePenLine size={13} />À vérifier
									</button>
								</div>
							</div>
							<div className={`project-grid ${display === "list" ? "project-list" : ""}`}>
								{filtered.map((project) => {
									const index = ordered.indexOf(project);
									const summary = summaries[index];
									return (
										<ProjectCard
											key={project.path}
											project={project}
											summary={summary.data}
											pending={summary.isPending}
											error={summary.error ? String(summary.error) : undefined}
											onOpen={() => setSelectedPath(project.path)}
											onPin={() => {
												void handlePin(project);
											}}
										/>
									);
								})}
							</div>
							{!filtered.length && (
								<div className="empty-view">
									<p>
										{ordered.length
											? "Aucun projet dans cette vue."
											: "Votre espace est prêt. Ajoutez votre premier projet."}
									</p>
									{!ordered.length && <span>Aucun dossier n’est parcouru avant votre sélection.</span>}
									{onlyChanges && scanning > 0 && <span>L’analyse des projets est encore en cours.</span>}
									<button
										type="button"
										className="quiet-button"
										data-testid="empty-add-project"
										onClick={() => {
											void handleImport();
										}}
									>
										<FolderPlus size={14} />
										Ajouter un dossier
									</button>
								</div>
							)}
							<p className="dashboard-footnote">
								Les compteurs distants utilisent les références Git présentes sur le Mac. BOA ne lance aucun
								fetch automatique.
							</p>
						</div>
					)}
				</main>
			</div>
			<footer className="statusbar">
				<span>
					<span className="local-dot" />
					Espace local
				</span>
				<span>
					{selected?.path ??
						`${ordered.length} projets · ${scanning ? "analyse en cours" : "dernière lecture locale"}`}
				</span>
				<span>BOA 0.1 · fichiers en lecture seule</span>
			</footer>
		</div>
	);
}

function SidebarCounts({ summary, error }: { summary?: Summary; error: boolean }) {
	if (error)
		return (
			<small className="error">
				<CircleAlert size={11} />
				Lecture impossible
			</small>
		);
	if (!summary) return <small className="muted">Analyse…</small>;
	const counts = countRepos(summary.repos);
	return (
		<small className="sidebar-counts">
			{counts.errors ? (
				<span className="error">! {counts.errors}</span>
			) : (
				<>
					<span className={counts.files ? "changed" : "muted"} title={`${counts.files} fichiers à committer`}>
						<FilePenLine size={11} />
						{counts.files}
					</span>
					<span
						className={counts.ahead ? "outgoing" : "muted"}
						title={
							counts.unknown
								? "Certaines branches ne suivent aucun upstream"
								: `${counts.ahead} commits à pousser`
						}
					>
						<ArrowUp size={11} />
						{counts.ahead || (counts.unknown ? "?" : "0")}
					</span>
					{!counts.files && !counts.ahead && !counts.unknown && <Check size={11} className="good" />}
				</>
			)}
		</small>
	);
}

function ProjectCard({
	project,
	summary,
	pending,
	error,
	onOpen,
	onPin,
}: {
	project: Project;
	summary?: Summary;
	pending: boolean;
	error?: string;
	onOpen: () => void;
	onPin: () => void;
}) {
	const counts = countRepos(summary?.repos ?? []);
	const root = summary?.repos.find((repo) => repo.path === project.path) ?? summary?.repos[0];
	return (
		<article className="project-card" data-testid={`project-card-${project.name}`}>
			<div className="project-card-heading">
				<button
					type="button"
					className="project-open"
					data-testid={`open-project-${project.name}`}
					onClick={onOpen}
				>
					<span className="project-initial">{project.name[0]?.toUpperCase()}</span>
					<strong>{project.name}</strong>
					<ArrowUpRight size={14} />
				</button>
				<button
					type="button"
					data-testid={`pin-project-${project.name}`}
					className={`icon-button pin-button ${project.pinned ? "pinned" : ""}`}
					onClick={onPin}
					title={project.pinned ? "Désépingler" : "Épingler"}
					aria-pressed={project.pinned}
				>
					<Pin size={13} fill={project.pinned ? "currentColor" : "none"} />
				</button>
			</div>
			<button
				type="button"
				className="project-card-content"
				data-testid={`project-detail-${project.name}`}
				onClick={onOpen}
			>
				<div className="branch">
					<GitBranch size={12} />
					<span>
						{pending
							? "Lecture Git…"
							: error || counts.errors
								? "Git à vérifier"
								: root?.branch || "Dossier sans Git"}
					</span>
				</div>
				<div className="project-stats">
					{error || counts.errors ? (
						<span className="error">
							<CircleAlert size={12} />
							{error || `${counts.errors} dépôts à vérifier`}
						</span>
					) : pending ? (
						<span className="muted">Analyse de l’état local…</span>
					) : (
						<>
							<span className={counts.files ? "changed" : "good"}>
								{counts.files ? <FilePenLine size={12} /> : <Check size={12} />}
								{counts.files ? `${counts.files} à committer` : "Aucun changement"}
							</span>
							{counts.ahead > 0 && (
								<span className="outgoing">
									<ArrowUp size={12} />
									{counts.ahead} à pousser
								</span>
							)}
							{counts.behind > 0 && (
								<span>
									<ArrowDown size={12} />
									{counts.behind} à récupérer
								</span>
							)}
						</>
					)}
				</div>
				<div className="card-footer">
					<span>{summary ? `${summary.repos.length} dépôts / worktrees` : "Découverte…"}</span>
					<span>
						{summary?.updatedAt
							? new Date(summary.updatedAt * 1000).toLocaleString("fr-FR", {
									day: "numeric",
									month: "short",
									hour: "2-digit",
									minute: "2-digit",
								})
							: summary?.scanLimited
								? "Scan partiel"
								: ""}
					</span>
				</div>
				{summary?.repos.some((repo) => repo.operation) && (
					<span className="operation-label">{summary.repos.find((repo) => repo.operation)?.operation}</span>
				)}
			</button>
		</article>
	);
}
