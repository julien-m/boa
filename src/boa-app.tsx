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
import { type AppLocation, navigationVisit, useAppHistory } from "./app-history";
import { captureCurrentReaderSelection } from "./code-viewer";
import { resolveContextPassage } from "./context-anchors";
import { contextApi, type ReaderOpenRequest } from "./context-api";
import { DraftIndicator } from "./file-editing";
import { FileSearchPanel } from "./file-search-panel";
import { FileSpaceView } from "./file-space-view";
import { defaultShortcuts, type FileHit, fileWorkspace, spaceEntries } from "./file-workspace-api";
import { useFileLabels } from "./file-workspace-labels";
import { createFilesystemRefresh, projectSummaryOptions } from "./filesystem-refresh";
import { getLocale, i18n, setInterfaceLanguage } from "./i18n";
import type { Selection } from "./models";
import { countRepos, type Project, type Summary } from "./models";
import { localizeNativeText } from "./native-text";
import { parseNavigation } from "./navigation";
import { ProjectView } from "./project-view";
import { rememberReadingReturn } from "./reading-return";
import { SearchInput } from "./search-input";
import { installSearchShortcuts } from "./search-shortcuts";
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
	const history = useAppHistory();
	const settingsOpen = history.location.view === "settings";
	const visitView = (location: AppLocation) => {
		if (
			location.view === history.location.view &&
			(location.view === "project"
				? location.root === history.location.root
				: location.view === "space"
					? location.space === history.location.space
					: true)
		)
			return;
		history.visit({
			...location,
			...(location.view === "project"
				? {
						workspace: {
							selection: null,
							library: null,
							layout:
								localStorage.getItem("boa-layout") === "git"
									? "git"
									: localStorage.getItem("boa-layout") === "files"
										? "files"
										: "split",
						},
					}
				: location.view === "space"
					? { workspace: { selection: null, library: null } }
					: {}),
		});
	};
	const fl = useFileLabels();
	const workspace = useQuery({ queryKey: ["file-workspace"], queryFn: fileWorkspace.state, retry: false });
	const selectedSpace = history.location.view === "space" ? history.location.space : null;
	const activeSpace = workspace.data?.spaces.find((s) => s.id === selectedSpace);
	const [globalSearch, setGlobalSearch] = useState(false);
	useEffect(
		() => installSearchShortcuts(workspace.data?.shortcuts ?? defaultShortcuts),
		[workspace.data?.shortcuts],
	);
	useEffect(() => {
		const show = () => setGlobalSearch(true);
		window.addEventListener("boa:global-search", show);
		return () => window.removeEventListener("boa:global-search", show);
	}, []);

	const language = settings.data?.language;
	useEffect(() => {
		if (!language) return;
		const changed = i18n.language !== language;
		void setInterfaceLanguage(language).then(() => {
			if (changed) void client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "settings" });
		});
	}, [language, client]);
	const archivesOpen = history.location.view === "archives";
	const archived = (projects.data ?? []).filter((project) => project.archived);
	const ordered = [...(projects.data ?? [])]
		.filter((project) => !project.archived)
		.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
	const summaries = useQueries({
		queries: ordered.map((project) => projectSummaryOptions(project.path)),
	});
	const [navigation, setNavigation] = useState<(Selection & { source: string }) | null>(null);
	const [guidancePaused, setGuidancePaused] = useState(false);
	const pausedRef = useRef(false);
	pausedRef.current = guidancePaused;
	const selectedPath = history.location.view === "project" ? history.location.root : null;
	const projectSearch = useRef<HTMLInputElement>(null);
	const [search, setSearch] = useState("");
	const [onlyChanges, setOnlyChanges] = useState(false);
	const [sort, setSort] = useState(() => localStorage.getItem("boa-project-sort") ?? "name");
	const [display, setDisplay] = useState(() => localStorage.getItem("boa-project-display") ?? "grid");
	const [notice, setNotice] = useState("");
	useEffect(() => {
		const restore = (event: Event) => {
			const selection = (event as CustomEvent<Selection>).detail;
			void fileWorkspace.state().then((spaces) => {
				const containing = spaces.spaces.find((space) => spaceEntries(space).includes(selection.project));
				history.visit({
					view: containing ? "space" : "project",
					root: selection.project,
					space: containing?.id,
					workspace: navigationVisit(selection),
					request: { ...selection, navigationId: crypto.randomUUID() },
				});
				setNavigation({ ...selection, source: "BOA", navigationId: crypto.randomUUID() });
			});
		};
		window.addEventListener("boa:restore-reading", restore);
		return () => window.removeEventListener("boa:restore-reading", restore);
	}, []);
	useEffect(() => {
		let disposed = false;
		let stop: (() => void) | undefined;
		let latest = "";
		const handled = new Set<string>();
		const handle = async (request: ReaderOpenRequest) => {
			if (disposed || handled.has(request.requestId)) return;
			handled.add(request.requestId);
			if (handled.size > 256) handled.delete(handled.values().next().value as string);
			latest = request.requestId;
			const acknowledge = (status: "paused" | "missing" | "failed", message?: string) =>
				contextApi.acknowledge(request.requestId, status, message).catch(() => {});
			if (pausedRef.current || document.querySelector('[data-testid="edit-save"]')) {
				await acknowledge("paused");
				return;
			}
			try {
				const target = await api.navigate(request.file);
				const preview = await api.preview(target);
				let line: number | undefined = request.line;
				let endLine: number | undefined = request.endLine;
				let contextRef: Selection["contextRef"];
				let anchorStatus: Selection["anchorStatus"] = "exact";
				if (request.context) {
					const ref = request.context;
					const view = await contextApi.get(ref.project, ref.viewId);
					const passage = view.steps
						.find((step) => step.id === ref.stepId)
						?.passages.find((p) => p.id === ref.passageId);
					if (!passage) {
						await acknowledge("missing", "Context step or passage was removed");
						return;
					}
					const expectedFile =
						view.project === request.file && passage.path === view.project.split("/").at(-1)
							? view.project
							: `${view.project}/${passage.path}`;
					if (expectedFile !== request.file) {
						await acknowledge("failed", "Context passage changed during navigation; open it again");
						return;
					}
					const resolved = resolveContextPassage(preview.modified, passage);
					anchorStatus = resolved.status;
					line = resolved.line;
					endLine = resolved.endLine;
					contextRef = { ...ref, revision: view.revision };
				} else if (endLine > preview.modified.split("\n").length) anchorStatus = "needs-review";
				if (anchorStatus === "needs-review") {
					line = undefined;
					endLine = undefined;
				}
				const spaces = await fileWorkspace.state();
				if (disposed || latest !== request.requestId) {
					await acknowledge("failed", "Superseded by another navigation request");
					return;
				}
				if (pausedRef.current || document.querySelector('[data-testid="edit-save"]')) {
					await acknowledge("paused");
					return;
				}
				const containing = spaces.spaces.find((space) => spaceEntries(space).includes(target.project));
				if (request.context) rememberReadingReturn(captureCurrentReaderSelection());
				if (!containing) {
					await api.add(target.project);
					await client.invalidateQueries({ queryKey: ["projects"] });
				}
				if (disposed || latest !== request.requestId || pausedRef.current) {
					await acknowledge("failed", "Navigation superseded");
					return;
				}
				const next: Selection = {
					...target,
					line,
					endLine,
					contextRef,
					anchorStatus,
					receiptId: request.requestId,
					navigationId: request.requestId,
				};
				history.visit({
					view: containing ? "space" : "project",
					root: target.project,
					space: containing?.id,
					workspace: navigationVisit(next),
					request: next,
				});
				setNavigation({
					...target,
					line,
					endLine,
					contextRef,
					anchorStatus,
					source: request.source,
					receiptId: request.requestId,
					navigationId: request.requestId,
				});
			} catch (error) {
				await acknowledge("missing", String(error));
			}
		};
		void listen<ReaderOpenRequest>("boa:reader-open", (event) => void handle(event.payload))
			.then(async (unlisten) => {
				if (disposed) {
					unlisten();
					return;
				}
				stop = unlisten;
				try {
					const pending = await contextApi.pending();
					for (const request of pending) await handle(request);
				} catch {
					/* Older app versions have no receipt queue. */
				}
			})
			.catch(() => {});
		return () => {
			disposed = true;
			stop?.();
		};
	}, []);
	useEffect(() => {
		let disposed = false;
		let cleanup: (() => void) | undefined;
		const handleLinks = async (urls: string[]): Promise<void> => {
			if (disposed) return;
			try {
				const raw = urls.at(-1);
				if (!raw) return;
				const request = parseNavigation(raw);
				if (pausedRef.current && !request.document) return;
				const target = request.document
					? await api.openDocument(request.file)
					: await api.navigate(request.file);
				const spaces = await fileWorkspace.state();
				const containing = spaces.spaces.find((s) => spaceEntries(s).includes(target.project));
				if (!containing) await api.add(target.project);
				await client.invalidateQueries({ queryKey: ["projects"] });
				if (request.document) await client.invalidateQueries({ queryKey: ["file-workspace"] });
				if (disposed || (pausedRef.current && !request.document)) return;
				history.visit({
					view: containing ? "space" : "project",
					root: target.project,
					space: containing?.id,
					workspace: navigationVisit({ ...target, line: request.line, endLine: request.endLine }),
					request: {
						...target,
						line: request.line,
						endLine: request.endLine,
						navigationId: crypto.randomUUID(),
					},
				});
				setNavigation({
					...target,
					line: request.line,
					endLine: request.endLine,
					source: request.document ? "BOA" : request.source,
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
			void client.invalidateQueries({ queryKey: ["file-workspace"] });
			void client.invalidateQueries({ queryKey: ["file-preferences"] });
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
				if (payload.discovery) refresh.collection("projects");
				if (payload.discovery || payload.settings) refresh.collection("settings");
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
			visitView({ view: "project", root: project.path });
		} catch (error) {
			setNotice(localizeNativeText(String(error)));
		}
	};
	useEffect(() => {
		const resume = (event: Event): void => {
			const target = (event as CustomEvent<Selection>).detail;
			const containing = workspace.data?.spaces.find((s) => spaceEntries(s).includes(target.project));
			const navigate = () => {
				history.visit({
					view: containing ? "space" : "project",
					root: target.project,
					space: containing?.id,
					workspace: navigationVisit(target),
					request: { ...target, navigationId: crypto.randomUUID() },
				});
				setNavigation({ ...target, source: "BOA", navigationId: crypto.randomUUID() });
			};
			if (
				!containing &&
				(event.type === "boa:open-file" ||
					projects.data?.some((project) => project.path === target.project && project.archived))
			) {
				void api
					.add(target.project)
					.then(() => client.invalidateQueries({ queryKey: ["projects"] }))
					.then(navigate)
					.catch((error: unknown) => setNotice(localizeNativeText(String(error))));
			} else navigate();
		};
		window.addEventListener("boa:resume-draft", resume);
		window.addEventListener("boa:open-file", resume);
		return () => {
			window.removeEventListener("boa:resume-draft", resume);
			window.removeEventListener("boa:open-file", resume);
		};
	}, [workspace.data?.spaces, projects.data, client]);
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
	useEffect(() => {
		let disposed = false;
		let cleanup: (() => void) | undefined;
		void listen<unknown>("boa:history-navigation", ({ payload }) => {
			if (!disposed && (payload === -1 || payload === 1)) history.go(payload);
		})
			.then((unlisten) => {
				if (disposed) unlisten();
				else cleanup = unlisten;
			})
			.catch((error: unknown) => console.error("Native history navigation unavailable", error));
		return () => {
			disposed = true;
			cleanup?.();
		};
	}, [history.go]);

	useEffect(() => {
		const keydown = (event: KeyboardEvent) => {
			const target = event.target instanceof Element ? event.target : null;
			if (
				event.defaultPrevented ||
				event.isComposing ||
				target?.closest(
					'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],dialog,[role="dialog"],[role="menu"],[role="combobox"]',
				)
			)
				return;
			if (
				event.key === "BrowserBack" ||
				(event.altKey && event.key === "ArrowLeft") ||
				(event.metaKey && event.key === "[")
			) {
				event.preventDefault();
				history.go(-1);
				return;
			}
			if (
				event.key === "BrowserForward" ||
				(event.altKey && event.key === "ArrowRight") ||
				(event.metaKey && event.key === "]")
			) {
				event.preventDefault();
				history.go(1);
				return;
			}
			if (
				history.location.view !== "overview" ||
				!projectSearch.current ||
				globalSearch ||
				document.querySelector('dialog[open],[role="dialog"],[role="menu"]') ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				event.key.length !== 1 ||
				!event.key.trim()
			)
				return;
			event.preventDefault();
			setSearch((value) => value + event.key);
			projectSearch.current?.focus();
		};
		const mouse = (event: MouseEvent) => {
			if (event.button !== 3 && event.button !== 4) return;
			event.preventDefault();
			if (event.type === "mouseup") history.go(event.button === 3 ? -1 : 1);
		};
		window.addEventListener("keydown", keydown);
		window.addEventListener("mousedown", mouse);
		window.addEventListener("mouseup", mouse);
		window.addEventListener("auxclick", mouse);
		return () => {
			window.removeEventListener("keydown", keydown);
			window.removeEventListener("mousedown", mouse);
			window.removeEventListener("mouseup", mouse);
			window.removeEventListener("auxclick", mouse);
		};
	}, [history.location.view, history.go, globalSearch]);
	useEffect(() => {
		if (history.restoration) setGlobalSearch(false);
	}, [history.restoration]);
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
							data-hint={t("guidanceTitle")}
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
						data-hint={t("refreshProjects")}
						aria-label={t("refreshProjects")}
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
						className={`nav-button ${!selected && !activeSpace && !settingsOpen && !archivesOpen ? "selected" : ""}`}
						onClick={() => {
							visitView({ view: "overview" });
						}}
					>
						<LayoutDashboard size={16} />
						{t("overview")}
					</button>
					<div className="nav-section-title">{fl.spaces}</div>
					{(workspace.data?.spaces ?? []).map((space) => (
						<button
							type="button"
							key={space.id}
							className={`nav-button ${activeSpace?.id === space.id && !settingsOpen && !archivesOpen ? "selected" : ""}`}
							onClick={() => {
								visitView({ view: "space", space: space.id });
							}}
						>
							{space.name}
						</button>
					))}
					<button
						type="button"
						className="nav-button"
						onClick={() => {
							visitView({ view: "settings" });
						}}
					>
						+ {fl.create}
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
										className={`nav-project ${!activeSpace && !settingsOpen && !archivesOpen && selected?.path === project.path ? "selected" : ""}`}
										onClick={() => {
											visitView({ view: "project", root: project.path });
										}}
										data-hint={project.path}
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
								visitView({ view: "archives" });
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
								visitView({ view: "settings" });
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
					{globalSearch && (
						<div
							className="file-search-overlay"
							onMouseDown={(e) => {
								if (e.target === e.currentTarget) setGlobalSearch(false);
							}}
						>
							<div role="dialog" aria-modal="true" aria-label={fl.global}>
								<h2>{fl.global}</h2>
								<FileSearchPanel
									roots={[
										...new Set([
											...ordered.map((p) => p.path),
											...(workspace.data?.spaces ?? []).flatMap(spaceEntries),
										]),
									]}
									onClose={() => setGlobalSearch(false)}
									onOpen={(hit: FileHit) => {
										const containing = workspace.data?.spaces.find((s) =>
											spaceEntries(s).includes(hit.project),
										);
										const target = {
											project: hit.project,
											path: hit.directory ? `${hit.path}/` : hit.path,
											line: hit.line || undefined,
											navigationId: crypto.randomUUID(),
										};
										history.visit({
											view: containing ? "space" : "project",
											root: hit.project,
											space: containing?.id,
											workspace: navigationVisit(target),
											request: target,
										});
										setNavigation({
											project: hit.project,
											path: hit.directory ? `${hit.path}/` : hit.path,
											line: hit.line || undefined,
											source: "CLI",
											navigationId: crypto.randomUUID(),
										});
										setGlobalSearch(false);
									}}
								/>
							</div>
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
					) : activeSpace && !archivesOpen ? (
						<FileSpaceView
							key={activeSpace.id}
							space={activeSpace}
							onVisit={history.record}
							restoration={history.restoration}
							navigation={
								history.location.request &&
								spaceEntries(activeSpace).includes(history.location.request.project)
									? history.location.request
									: null
							}
						/>
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
								navigation={
									history.location.request?.project === selected.path ? history.location.request : null
								}
								project={selected}
								onVisit={history.record}
								restoration={history.restoration}
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
									<div className="search-field">
										<Search size={14} />
										<SearchInput
											data-testid="project-search"
											inputRef={projectSearch}
											placeholder={t("searchProjects")}
											value={search}
											onClear={() => setSearch("")}
											onChange={(event) => setSearch(event.target.value)}
											aria-label={t("searchProjects")}
										/>
									</div>
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
											onOpen={() => {
												visitView({ view: "project", root: project.path });
											}}
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
					data-hint={t("archiveTitle")}
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
					data-hint={project.pinned ? t("unpin") : t("pin")}
					aria-label={project.pinned ? t("unpin") : t("pin")}
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
