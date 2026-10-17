/** Project dashboard, pinned navigation and native project import. */
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { open } from "@tauri-apps/plugin-dialog";
import {
	Archive,
	ArchiveRestore,
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
	Settings,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { DraftIndicator } from "./file-editing";
import { createFilesystemRefresh } from "./filesystem-refresh";
import { getLocale, i18n, setInterfaceLanguage } from "./i18n";
import type { Selection } from "./models";
import { countRepos, type Project, type Summary } from "./models";
import { localizeNativeText } from "./native-text";
import { parseNavigation } from "./navigation";
import { ProjectView } from "./project-view";
import { SettingsView } from "./settings-view";
import "./workspace.css";

export default function App() {
	const { t } = useTranslation("dashboard");
	const client = useQueryClient();
	const settings = useQuery({
		queryKey: ["settings"],
		queryFn: api.settings,
	});
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: api.projects,
	});
	const [settingsOpen, setSettingsOpen] = useState(false);
	const language = settings.data?.language;
	useEffect(() => {
		if (!language) return;
		const changed = i18n.language !== language;
		void setInterfaceLanguage(language).then(() => {
			if (changed) void client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "settings" });
		});
	}, [language, client]);
	const [archivesOpen, setArchivesOpen] = useState(false);
	const archived = (projects.data ?? []).filter((project) => project.archived);
	const ordered = [...(projects.data ?? [])]
		.filter((project) => !project.archived)
		.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
	const summaries = useQueries({
		queries: ordered.map((project) => ({
			queryKey: ["summary", project.path],
			queryFn: () => api.summary(project.path),
			staleTime: Number.POSITIVE_INFINITY,
			// Archived projects are not watched; returning observers must read current state.
			refetchOnMount: "always" as const,
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
				await api.add(target.project);
				await client.invalidateQueries({ queryKey: ["projects"] });
				if (disposed || pausedRef.current) return;
				setSelectedPath(target.project);
				setSettingsOpen(false);
				setArchivesOpen(false);
				setNavigation({
					...target,
					line: request.line,
					endLine: request.endLine,
					source: request.source,
					navigationId: crypto.randomUUID(),
				});
			} catch (error) {
				if (!disposed) setNotice(localizeNativeText(String(error)));
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
				if (!disposed) setNotice(t("cliNavigationUnavailable", { error: localizeNativeText(String(error)) }));
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
			.catch((error: unknown) =>
				setNotice(t("cliRefreshUnavailable", { error: localizeNativeText(String(error)) })),
			);
		return () => {
			disposed = true;
			cleanup?.();
		};
	}, [client]);
	useEffect(() => {
		let disposed = false;
		let cleanup: (() => void) | undefined;
		const refresh = createFilesystemRefresh(client);
		void listen<{ discovery: boolean; settings: boolean; projects: string[] }>(
			"boa:filesystem-changed",
			({ payload }) => {
				if (payload.discovery)
					void client.invalidateQueries({ queryKey: ["projects"] }, { cancelRefetch: false });
				if (payload.discovery || payload.settings)
					void client.invalidateQueries({ queryKey: ["settings"] }, { cancelRefetch: false });
				for (const project of payload.projects) refresh.project(project);
			},
		)
			.then((unlisten) => {
				if (disposed) unlisten();
				else cleanup = unlisten;
			})
			.catch((error: unknown) => setNotice(localizeNativeText(String(error))));
		return () => {
			disposed = true;
			refresh.dispose();
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
			setNotice(localizeNativeText(String(error)));
		}
	};
	const handleArchive = async (project: Project, value: boolean): Promise<void> => {
		try {
			await api.archive(project.path, value);
			await client.invalidateQueries({ queryKey: ["projects"] });
		} catch (error) {
			setNotice(localizeNativeText(String(error)));
		}
	};
	const handleImport = async (): Promise<void> => {
		try {
			const path = await open({ directory: true, multiple: false, title: t("importTitle") });
			if (typeof path !== "string") return;
			const project = await api.add(path);
			await client.invalidateQueries({ queryKey: ["projects"] });
			setSelectedPath(project.path);
			setSettingsOpen(false);
			setArchivesOpen(false);
		} catch (error) {
			setNotice(localizeNativeText(String(error)));
		}
	};
	useEffect(() => {
		const resume = (event: Event): void => {
			const target = (event as CustomEvent<Selection>).detail;
			setSelectedPath(target.project);
			setSettingsOpen(false);
			setArchivesOpen(false);
			setNavigation({ ...target, source: "BOA", navigationId: crypto.randomUUID() });
		};
		window.addEventListener("boa:resume-draft", resume);
		return () => window.removeEventListener("boa:resume-draft", resume);
	}, []);
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
					<span className="muted">{t("projectSpace")}</span>
				</div>
				<div className="titlebar-right">
					<DraftIndicator />
					{navigation && navigation.source !== "BOA" && (
						<button
							type="button"
							data-testid="guidance-toggle"
							className="guidance-badge"
							title={t("guidanceTitle")}
							onClick={() => setGuidancePaused(!guidancePaused)}
						>
							{guidancePaused ? t("paused") : t("guidanceReceived", { source: navigation.source })}
							<span>{guidancePaused ? t("resume") : t("takeControl")}</span>
						</button>
					)}
					<span className="local-dot" />
					{t("onThisMac")}
					<button
						type="button"
						data-testid="refresh-all"
						className="icon-button"
						onClick={handleRefresh}
						title={t("refreshProjects")}
					>
						<RefreshCw size={14} className={scanning ? "spin" : ""} />
					</button>
				</div>
			</header>
			<div className="app-content">
				<nav className="navigation" aria-label={t("mainNavigation")}>
					<div className="nav-section-title">{t("workspaceHeading")}</div>
					<button
						type="button"
						data-testid="dashboard-nav"
						className={`nav-button ${!selected && !settingsOpen && !archivesOpen ? "selected" : ""}`}
						onClick={() => {
							setSelectedPath(null);
							setSettingsOpen(false);
							setArchivesOpen(false);
						}}
					>
						<LayoutDashboard size={16} />
						{t("overview")}
					</button>
					<div className="nav-section-title pinned-heading">
						{t("pinnedProjects")} <span>{ordered.filter((project) => project.pinned).length}</span>
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
										className={`nav-project ${!settingsOpen && !archivesOpen && selected?.path === project.path ? "selected" : ""}`}
										onClick={() => {
											setSelectedPath(project.path);
											setSettingsOpen(false);
											setArchivesOpen(false);
										}}
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
							{t("filesToCommitLabel")}
						</span>
						<span>
							<ArrowUp size={11} />
							{t("commitsToPushLabel")}
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
						{t("addProject")}
					</button>
					<div className="nav-bottom">
						<button
							type="button"
							className={`nav-button ${archivesOpen ? "selected" : ""}`}
							data-testid="archives-nav"
							onClick={() => {
								setArchivesOpen(true);
								setSettingsOpen(false);
							}}
						>
							<Archive size={16} />
							{t("archives")} <span>{archived.length}</span>
						</button>
						<button
							type="button"
							className={`nav-button ${settingsOpen ? "selected" : ""}`}
							data-testid="settings-nav"
							onClick={() => {
								setSettingsOpen(true);
								setArchivesOpen(false);
							}}
						>
							<Settings size={16} />
							{t("settings")}
						</button>
						<span className="nav-local">
							<HardDrive size={13} />
							{t("localGit")}
						</span>
					</div>
				</nav>
				<main className="main-content">
					{settings.data?.watchError && !settingsOpen && (
						<div className="app-notice" role="alert">
							{t("watchError", { error: settings.data.watchError })}
						</div>
					)}
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
					{settingsOpen ? (
						settings.data ? (
							<SettingsView
								settings={settings.data}
								onChanged={async (value) => {
									client.setQueryData(["settings"], value);
									await client.invalidateQueries();
								}}
							/>
						) : (
							<div className="empty-view">
								{settings.error ? String(settings.error) : t("loadingSettings")}
							</div>
						)
					) : archivesOpen ? (
						<div className="dashboard settings-view" data-testid="archives-view">
							<div className="eyebrow">{t("workspaceEyebrow")}</div>
							<h1>{t("archives")}</h1>
							<p className="dashboard-intro">{t("archivesIntro")}</p>
							{!archived.length && <p className="muted">{t("archivesEmpty")}</p>}
							{archived.map((project) => (
								<div
									className="settings-card archive-row"
									key={project.path}
									data-testid={`archived-${project.name}`}
								>
									<Archive size={18} />
									<div>
										<strong>{project.name}</strong>
										<p className="muted">{project.path}</p>
									</div>
									<button
										type="button"
										className="quiet-button"
										data-testid={`restore-${project.name}`}
										onClick={() => void handleArchive(project, false)}
									>
										<ArchiveRestore size={14} />
										{t("restore")}
									</button>
								</div>
							))}
						</div>
					) : projects.error ? (
						<div className="empty-view error">{String(projects.error)}</div>
					) : projects.isPending ? (
						<div className="empty-view" data-testid="projects-loading">
							{t("loadingProjects")}
						</div>
					) : selected ? (
						<ErrorBoundary
							key={selected.path}
							fallbackRender={({ error }) => (
								<div className="empty-view error">{localizeNativeText(String(error))}</div>
							)}
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
							<div className="eyebrow">{t("workspaceEyebrow")}</div>
							<h1>{t("dashboardTitle")}</h1>
							<p className="dashboard-intro">{t("dashboardIntro")}</p>
							<div className="dashboard-summary" data-testid="dashboard-counts">
								<div>
									<strong>{ordered.length}</strong>
									<span>{t("trackedProjects", { count: ordered.length })}</span>
								</div>
								<div>
									<strong>{counts.files}</strong>
									<span>{t("filesToCommit", { count: counts.files })}</span>
								</div>
								<div>
									<strong>{counts.ahead}</strong>
									<span>{t("knownCommitsToPush", { count: counts.ahead })}</span>
								</div>
								<div className="summary-caption">
									{scanning ? t("scanningCount", { count: scanning }) : t("refreshInterval")}
									{counts.errors > 0 && (
										<span className="error">{t("inaccessibleRepos", { count: counts.errors })}</span>
									)}
								</div>
							</div>
							<div className="dashboard-toolbar">
								<h2>
									{t("yourProjects")} <span>{filtered.length}</span>
								</h2>
								<div className="dashboard-filters">
									<select
										aria-label={t("sortProjects")}
										data-testid="project-sort"
										value={sort}
										onChange={(event) => {
											setSort(event.target.value);
											localStorage.setItem("boa-project-sort", event.target.value);
										}}
									>
										<option value="name">{t("sortName")}</option>
										<option value="reverse">{t("sortReverse")}</option>
										<option value="recent">{t("sortRecent")}</option>
										<option value="changes">{t("filesToCommitLabel")}</option>
									</select>
									<select
										aria-label={t("displayProjects")}
										data-testid="project-display"
										value={display}
										onChange={(event) => {
											setDisplay(event.target.value);
											localStorage.setItem("boa-project-display", event.target.value);
										}}
									>
										<option value="grid">{t("grid")}</option>
										<option value="list">{t("list")}</option>
									</select>
									<label className="search-field">
										<Search size={14} />
										<input
											data-testid="project-search"
											placeholder={t("searchProjects")}
											value={search}
											onChange={(event) => setSearch(event.target.value)}
											aria-label={t("searchProjects")}
										/>
									</label>
									<button
										type="button"
										data-testid="filter-changes"
										aria-pressed={onlyChanges}
										className={`quiet-button ${onlyChanges ? "selected" : ""}`}
										onClick={() => setOnlyChanges(!onlyChanges)}
									>
										<FilePenLine size={13} />
										{t("needsReview")}
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
											onArchive={() => void handleArchive(project, true)}
										/>
									);
								})}
							</div>
							{!filtered.length && (
								<div className="empty-view">
									<p>{ordered.length ? t("emptyView") : t("firstProject")}</p>
									{!ordered.length && <span>{t("noFolderScan")}</span>}
									{onlyChanges && scanning > 0 && <span>{t("scanningProjects")}</span>}
									<button
										type="button"
										className="quiet-button"
										data-testid="empty-add-project"
										onClick={() => {
											void handleImport();
										}}
									>
										<FolderPlus size={14} />
										{t("addFolder")}
									</button>
								</div>
							)}
							<p className="dashboard-footnote">{t("remoteFootnote")}</p>
						</div>
					)}
				</main>
			</div>
			<footer className="statusbar">
				<span>
					<span className="local-dot" />
					{t("localWorkspace")}
				</span>
				<span>
					{selected?.path ??
						t("statusProjects", {
							count: ordered.length,
							status: scanning ? t("statusScanning") : t("statusLocalRead"),
						})}
				</span>
				<span>{t("readOnly")}</span>
			</footer>
		</div>
	);
}

function SidebarCounts({ summary, error }: { summary?: Summary; error: boolean }) {
	const { t } = useTranslation("dashboard");
	if (error)
		return (
			<small className="error">
				<CircleAlert size={11} />
				{t("readFailed")}
			</small>
		);
	if (!summary) return <small className="muted">{t("scanning")}</small>;
	const counts = countRepos(summary.repos);
	return (
		<small className="sidebar-counts">
			{counts.errors ? (
				<span className="error">! {counts.errors}</span>
			) : (
				<>
					<span
						className={counts.files ? "changed" : "muted"}
						title={t("filesToCommitCount", { count: counts.files })}
					>
						<FilePenLine size={11} />
						{counts.files}
					</span>
					<span
						className={counts.ahead ? "outgoing" : "muted"}
						title={counts.unknown ? t("unknownUpstream") : t("commitsToPushCount", { count: counts.ahead })}
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
	onArchive,
}: {
	project: Project;
	summary?: Summary;
	pending: boolean;
	error?: string;
	onOpen: () => void;
	onPin: () => void;
	onArchive: () => void;
}) {
	const { t } = useTranslation("dashboard");
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
					className="icon-button"
					title={t("archiveTitle")}
					aria-label={t("archiveProject", { name: project.name })}
					data-testid={`archive-project-${project.name}`}
					onClick={onArchive}
				>
					<Archive size={14} />
				</button>
				<button
					type="button"
					data-testid={`pin-project-${project.name}`}
					className={`icon-button pin-button ${project.pinned ? "pinned" : ""}`}
					onClick={onPin}
					title={project.pinned ? t("unpin") : t("pin")}
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
						{pending ? t("readingGit") : error || counts.errors ? t("checkGit") : root?.branch || t("noGit")}
					</span>
				</div>
				<div className="project-stats">
					{error || counts.errors ? (
						<span className="error">
							<CircleAlert size={12} />
							{error || t("reposToCheck", { count: counts.errors })}
						</span>
					) : pending ? (
						<span className="muted">{t("scanningLocal")}</span>
					) : (
						<>
							<span className={counts.files ? "changed" : "good"}>
								{counts.files ? <FilePenLine size={12} /> : <Check size={12} />}
								{counts.files ? t("toCommit", { count: counts.files }) : t("noChanges")}
							</span>
							{counts.ahead > 0 && (
								<span className="outgoing">
									<ArrowUp size={12} />
									{t("toPush", { count: counts.ahead })}
								</span>
							)}
							{counts.behind > 0 && (
								<span>
									<ArrowDown size={12} />
									{t("toPull", { count: counts.behind })}
								</span>
							)}
						</>
					)}
				</div>
				<div className="card-footer">
					<span>{summary ? t("repoWorktrees", { count: summary.repos.length }) : t("discovering")}</span>
					<span>
						{summary?.updatedAt
							? new Date(summary.updatedAt * 1000).toLocaleString(getLocale(), {
									day: "numeric",
									month: "short",
									hour: "2-digit",
									minute: "2-digit",
								})
							: summary?.scanLimited
								? t("partialScan")
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
