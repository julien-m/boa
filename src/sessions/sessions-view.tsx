/** Global Sessions view: sortable table, optional project grouping, rows open in the dock. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { getLocale } from "../i18n";
import { SessionCreate } from "./session-create";
import { useSessionText } from "./session-labels";
import { SessionRow } from "./session-row";
import {
	ATTENTION,
	nextSort,
	readGrouping,
	readSort,
	type SessionSort,
	type SortColumn,
	sortSessions,
	writeGrouping,
	writeSort,
} from "./session-sort";
import {
	keyId,
	type ListQuery,
	type Provider,
	type SessionKey,
	type SessionState,
	type SessionSummary,
	sameKey,
	sessionsApi,
} from "./sessions-api";

export type ProjectRef = { path: string; name: string };

const COLUMN_LABELS: Record<SortColumn, string> = {
	title: "columnSession",
	project: "columnProject",
	state: "columnState",
	activity: "columnActivity",
};

export function useSessionsSettings() {
	return useQuery({ queryKey: ["sessions", "settings"], queryFn: sessionsApi.settings });
}

function DiscoveryCard() {
	const { t, error } = useSessionText();
	const queryClient = useQueryClient();
	const enable = useMutation({
		mutationFn: () => sessionsApi.setDiscovery(true),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["sessions"] }),
	});
	return (
		<section className="settings-card session-discovery" aria-labelledby="session-discovery-title">
			<h2 id="session-discovery-title">{t("discovery.title")}</h2>
			<p>{t("discovery.body")}</p>
			<div className="session-actions-row">
				<button
					type="button"
					className="primary-button"
					data-testid="enable-session-discovery"
					disabled={enable.isPending}
					onClick={() => enable.mutate()}
				>
					{t("discovery.enable")}
				</button>
				{enable.isError && <span className="session-feedback error">{error(enable.error)}</span>}
			</div>
		</section>
	);
}

function CodexDaemonNotice() {
	const { t, error } = useSessionText();
	const queryClient = useQueryClient();
	const start = useMutation({
		mutationFn: sessionsApi.startCodexDaemon,
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["sessions"] }),
	});
	return (
		<div className="app-notice session-notice" role="status">
			<span>{start.isError ? error(start.error) : t("codexDaemon.notRunning")}</span>
			<button
				type="button"
				className="quiet-button"
				disabled={start.isPending}
				onClick={() => start.mutate()}
			>
				{start.isPending ? t("codexDaemon.starting") : t("codexDaemon.start")}
			</button>
		</div>
	);
}

export function SessionsView({ projects }: { projects: ProjectRef[] }) {
	const { t, provider, reason } = useSessionText();
	const [scope, setScope] = useState<ListQuery["scope"]>("pinned");
	const [search, setSearch] = useState("");
	const [tool, setTool] = useState<Provider | "">("");
	const [project, setProject] = useState("");
	const [stateFilter, setStateFilter] = useState<SessionState | "">("");
	const [sort, setSort] = useState<SessionSort>(readSort);
	const [grouped, setGrouped] = useState(readGrouping);
	const [selected, setSelected] = useState<SessionKey | null>(null);
	const [creating, setCreating] = useState(false);
	const [message, setMessage] = useState("");
	const settings = useSessionsSettings();
	const query: ListQuery = {
		scope,
		search: search.trim() || undefined,
		provider: tool || undefined,
		project: project || undefined,
		state: stateFilter || undefined,
	};
	const listing = useQuery({
		queryKey: ["sessions", "list", query],
		queryFn: () => sessionsApi.list(query),
		enabled: settings.data?.discoveryEnabled === true,
	});
	const queryClient = useQueryClient();
	const projectName = (path: string | null) => projects.find((item) => item.path === path)?.name ?? null;
	const sessions = useMemo(
		() =>
			sortSessions(
				listing.data?.sessions ?? [],
				sort,
				(path) => projects.find((item) => item.path === path)?.name ?? path?.split("/").pop() ?? null,
				getLocale(),
			),
		[listing.data, sort, projects],
	);
	const groups = useMemo(
		() =>
			grouped ? groupByProject(sessions, projects, sort.column === "project" ? sort.direction : "asc") : [],
		[sessions, projects, grouped, sort],
	);
	const changeSort = (column: SortColumn) => {
		const next = nextSort(sort, column);
		writeSort(next);
		setSort(next);
	};
	const header = (column: SortColumn) => {
		const active = sort.column === column;
		return (
			<span
				role="columnheader"
				aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
				className={`session-column ${active ? "active" : ""}`}
			>
				<button type="button" data-testid={`sort-${column}`} onClick={() => changeSort(column)}>
					{t(COLUMN_LABELS[column])}
					{active &&
						(sort.direction === "asc" ? (
							<ArrowUp size={11} aria-hidden="true" />
						) : (
							<ArrowDown size={11} aria-hidden="true" />
						))}
				</button>
			</span>
		);
	};
	const codexStatus = settings.data?.providers.find((status) => status.provider === "codex");
	const daemonMissing =
		settings.data?.discoveryEnabled &&
		codexStatus?.available &&
		codexStatus.reason === "codex_daemon_not_running";
	const renderRow = (session: SessionSummary) => (
		<SessionRow
			key={keyId(session.key)}
			session={session}
			projectName={projectName(session.project)}
			selected={sameKey(selected, session.key)}
			onSelect={() => setSelected(session.key)}
			onMessage={setMessage}
		/>
	);

	return (
		<div className="dashboard sessions-view" data-testid="sessions-view">
			<header className="sessions-header">
				<h1>{t("title")}</h1>
				{settings.data?.discoveryEnabled && (
					<>
						<div className="segmented" role="group" aria-label={t("scopeLabel")}>
							{(["pinned", "all"] as const).map((value) => (
								<button
									type="button"
									key={value}
									aria-pressed={scope === value}
									className={scope === value ? "selected" : ""}
									onClick={() => setScope(value)}
								>
									{value === "pinned" ? t("pinnedTab") : t("allTab")}
									<span className="count-badge">
										{value === "pinned" ? (listing.data?.pinnedCount ?? 0) : (listing.data?.totalCount ?? 0)}
									</span>
								</button>
							))}
						</div>
						<label className="sessions-search">
							<Search size={13} aria-hidden="true" />
							<input
								type="search"
								aria-label={t("searchLabel")}
								placeholder={t("searchPlaceholder")}
								value={search}
								onChange={(event) => setSearch(event.target.value)}
							/>
						</label>
					</>
				)}
				<button
					type="button"
					className="primary-button sessions-new"
					disabled={!settings.data?.discoveryEnabled || projects.length === 0}
					onClick={() => setCreating((value) => !value)}
					aria-expanded={creating}
				>
					<Plus size={14} />
					{t("newSession")}
				</button>
			</header>
			{settings.data && !settings.data.discoveryEnabled && <DiscoveryCard />}
			{daemonMissing && <CodexDaemonNotice />}
			{creating && (
				<SessionCreate
					projects={projects}
					onDone={(key) => {
						setCreating(false);
						if (key) setSelected(key);
					}}
				/>
			)}
			{settings.data?.discoveryEnabled && (
				<>
					<div className="sessions-toolbar">
						<div className="sessions-toolbar-group">
							<label className="sessions-filter">
								<span>{t("toolFilter")}</span>
								<select value={tool} onChange={(event) => setTool(event.target.value as Provider | "")}>
									<option value="">{t("all")}</option>
									<option value="codex">{provider("codex")}</option>
									<option value="claude">{provider("claude")}</option>
								</select>
							</label>
							<label className="sessions-filter">
								<span>{t("projectFilter")}</span>
								<select value={project} onChange={(event) => setProject(event.target.value)}>
									<option value="">{t("all")}</option>
									{projects.map((item) => (
										<option key={item.path} value={item.path}>
											{item.name}
										</option>
									))}
								</select>
							</label>
							<label className="sessions-filter">
								<span>{t("stateFilter")}</span>
								<select
									value={stateFilter}
									onChange={(event) => setStateFilter(event.target.value as SessionState | "")}
								>
									<option value="">{t("all")}</option>
									{ATTENTION.map((value) => (
										<option key={value} value={value}>
											{t(`states.${value}`)}
										</option>
									))}
								</select>
							</label>
							<label className="sessions-group-toggle">
								<input
									type="checkbox"
									data-testid="sessions-group"
									checked={grouped}
									onChange={(event) => {
										writeGrouping(event.target.checked);
										setGrouped(event.target.checked);
									}}
								/>
								{t("groupByProject")}
							</label>
							<button
								type="button"
								className="icon-button"
								aria-label={t("refresh")}
								data-hint={t("refresh")}
								onClick={() => void queryClient.invalidateQueries({ queryKey: ["sessions"] })}
							>
								<RefreshCw size={14} className={listing.isFetching ? "spin" : ""} />
							</button>
						</div>
					</div>
					{listing.data?.issues.map((issue) => (
						<p key={issue.provider} className="session-feedback error" role="status">
							{provider(issue.provider)} : {reason(issue.code)}
						</p>
					))}
					<p className="session-feedback" role="status">
						{message}
					</p>
					<div className="sessions-table" role="table" aria-label={t("title")}>
						<div className="session-columns" role="row">
							{header("title")}
							{header("project")}
							{header("state")}
							{header("activity")}
							<span role="columnheader" className="sr-only">
								{t("more")}
							</span>
						</div>
						{listing.isLoading && <p className="muted">{t("loading")}</p>}
						{listing.data && sessions.length === 0 && (
							<p className="muted">{scope === "pinned" && !search ? t("noPinned") : t("noResult")}</p>
						)}
						{!grouped && (
							<div className="session-group" role="rowgroup">
								{sessions.map(renderRow)}
							</div>
						)}
						{groups.map((group) => (
							<div
								key={group.path ?? "outside"}
								className="session-group"
								role="rowgroup"
								aria-label={group.path === null ? t("outsideProjects") : group.name}
							>
								<div className="session-group-title" role="row">
									<span role="rowheader">
										{group.path === null ? t("outsideProjects") : group.name}
										<small>{t("sessionCount", { count: group.sessions.length })}</small>
									</span>
								</div>
								{group.sessions.map(renderRow)}
							</div>
						))}
						{listing.data?.truncated && <p className="muted">{t("truncated")}</p>}
					</div>
				</>
			)}
		</div>
	);
}

type Group = { path: string | null; name: string; sessions: SessionSummary[] };

/** Groups by registered project name; unmatched sessions come last. */
export function groupByProject(
	sessions: SessionSummary[],
	projects: ProjectRef[],
	direction: "asc" | "desc" = "asc",
): Group[] {
	const groups = new Map<string | null, Group>();
	for (const session of sessions) {
		const path = session.project;
		const known = projects.find((item) => item.path === path);
		const group = groups.get(path) ?? {
			path,
			name: known?.name ?? path?.split("/").pop() ?? "",
			sessions: [],
		};
		group.sessions.push(session);
		groups.set(path, group);
	}
	const sign = direction === "asc" ? 1 : -1;
	// Rows keep the table order inside each group; unmatched sessions stay last.
	return [...groups.values()].sort((a, b) =>
		a.path === null ? 1 : b.path === null ? -1 : sign * a.name.localeCompare(b.name),
	);
}
