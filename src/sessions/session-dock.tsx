/**
 * Application-level session dock. Mounted once below every view (and alone in the detached
 * window); it targets the docked session, never the project currently displayed.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, ExternalLink, MoreHorizontal } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { PanelResizer } from "../panel-resizer";
import { MenuItem, PopoverMenu } from "./popover-menu";
import { SessionBranchPicker } from "./session-branch-picker";
import { SessionComposer } from "./session-composer";
import { SessionConversation } from "./session-conversation";
import { SessionCreate, type SessionSeed } from "./session-create";
import { useSessionDock } from "./session-dock-state";
import { useSessionText } from "./session-labels";
import { SessionRename } from "./session-rename";
import { panelId, SessionTabs, tabId } from "./session-tabs";
import { SessionTerminal } from "./session-terminal";
import {
	type ConversationEntry,
	keyId,
	type SessionKey,
	type SessionSummary,
	sameKey,
	sessionsApi,
} from "./sessions-api";

/** Catalog lookup shared with the Sessions view cache. */
function useDockedSession(key: SessionKey | null, needed: boolean) {
	const all = useQuery({
		queryKey: ["sessions", "list", { scope: "all" }],
		queryFn: () => sessionsApi.list({ scope: "all" }),
		enabled: needed,
	});
	return {
		session: all.data?.sessions.find((item) => sameKey(item.key, key)) ?? null,
		candidates: all.data?.sessions ?? [],
		loading: all.isLoading,
	};
}

export function SessionDock({
	projects,
	onOpenProject,
	detachedWindow = false,
	resizeContainer,
}: {
	projects: { path: string; name: string }[];
	onOpenProject?: (path: string) => void;
	detachedWindow?: boolean;
	/** App shell whose grid gives the dock its height; absent in the detached window. */
	resizeContainer?: RefObject<HTMLDivElement | null>;
}) {
	const { t, provider, error, reason } = useSessionText();
	const dock = useSessionDock();
	const queryClient = useQueryClient();
	// Same query as the « + » menu: refreshed by terminal start/exit events, never polled.
	const running = useQuery({ queryKey: ["sessions", "terminals"], queryFn: sessionsApi.terminals });
	const background = (running.data ?? []).length > 0;
	const { session, candidates, loading } = useDockedSession(
		dock.current,
		dock.current !== null || background,
	);
	// Per-tab panels are bound to the session that opened them: switching tabs hides them and
	// a submit can never apply A's form to B.
	const [renaming, setRenaming] = useState<SessionKey | null>(null);
	const [feedback, setFeedback] = useState<{ key: SessionKey; text: string } | null>(null);
	/** Session whose Terminal button was just chosen: its view may start a PTY right away. */
	const [startNow, setStartNow] = useState<SessionKey | null>(null);

	const [seed, setSeed] = useState<{ source: SessionKey; seed: SessionSeed } | null>(null);
	// Changing tab cancels the per-tab forms (rename, new from summary): they never follow.
	const currentId = dock.current ? keyId(dock.current) : "";
	const [formsFor, setFormsFor] = useState(currentId);
	if (formsFor !== currentId) {
		setFormsFor(currentId);
		setRenaming(null);
		setSeed(null);
	}
	/** Latest agent reply (e.g. the Summarize action's output) prefills the new session. */
	const seedFrom = (source: SessionSummary): SessionSeed => {
		const entries =
			queryClient.getQueryData<ConversationEntry[]>(["sessions", "conversation", keyId(source.key)]) ?? [];
		const summary = [...entries].reverse().find((entry) => entry.role === "agent")?.text ?? "";
		const title = source.title || source.key.id;
		return {
			provider: source.key.provider,
			project: source.project ?? "",
			title: t("summaryTitle", { title }).slice(0, 200),
			text: `${t("summaryIntro", { title })}\n\n${summary}`,
			hint: summary ? t("summaryHint") : `${t("summaryHint")} ${t("summaryEmpty")}`,
		};
	};
	/** Feedback stays with the session it concerns; another tab never shows it. */
	const message = feedback && sameKey(feedback.key, dock.current) ? feedback.text : "";
	const permissions = {
		requests: dock.permissions.filter(
			(item) => dock.current?.provider === "claude" && item.sessionId === dock.current.id,
		),
	};
	const branch = useQuery({
		queryKey: ["sessions", "branch", dock.current ? keyId(dock.current) : ""],
		queryFn: () => sessionsApi.branch(dock.current as SessionKey),
		enabled: dock.current !== null,
	});
	const answer = useMutation({
		// The request carries its own session: the answer never follows the dock's current target.
		mutationFn: (input: { sessionId: string; requestId: string; allow: boolean }) =>
			sessionsApi.permission({ provider: "claude", id: input.sessionId }, input.requestId, input.allow),
		onError: (value, input) =>
			setFeedback({ key: { provider: "claude", id: input.sessionId }, text: error(value) }),
	});
	const unpin = useMutation({
		mutationFn: (key: SessionKey) => sessionsApi.pin(key, false),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["sessions"] }),
	});

	if (!dock.open || !dock.current) {
		// No open tab: nothing to show, unless a BOA terminal still runs behind a closed tab.
		// A reduced bar then keeps « + » → « En arrière-plan » one click away.
		if (!background || (dock.detached && !detachedWindow)) return null;
		return (
			<section className="session-dock collapsed" aria-label={t("dock.region")} data-testid="session-dock">
				<header className="session-dock-bar">
					<SessionTabs catalog={candidates} />
					<small className="muted">{t("tabs.backgroundHint")}</small>
				</header>
			</section>
		);
	}
	if (dock.detached && !detachedWindow)
		return (
			<section className="session-dock collapsed" aria-label={t("dock.region")}>
				<div className="session-dock-bar">
					<span className="muted">{t("dock.detachedHere")}</span>
					<button type="button" className="quiet-button" onClick={() => void attachDock(dock)}>
						{t("dock.attach")}
					</button>
				</div>
			</section>
		);
	const projectName = session?.project
		? (projects.find((item) => item.path === session.project)?.name ?? null)
		: null;
	const current = dock.current;
	const view = dock.viewFor(current);
	// The terminal registry is its own source: a PTY BOA runs stays reachable (and stoppable)
	// even when the bounded catalog lacks its session. Send rules still come from the catalog.
	const runningHere = (running.data ?? []).some((item) => sameKey(item.session, current));
	const terminalAvailable = runningHere || session?.capabilities.terminal.available === true;
	const showTerminal = view === "terminal" && terminalAvailable;
	return (
		<section
			className={`session-dock ${dock.collapsed ? "collapsed" : ""}`}
			aria-label={t("dock.region")}
			data-testid="session-dock"
		>
			{resizeContainer && !dock.collapsed && <PanelResizer container={resizeContainer} panel="dock" />}
			<header className="session-dock-bar">
				<SessionTabs catalog={candidates} />
				<div className="session-dock-tools">
					<button
						type="button"
						className="icon-button"
						aria-label={detachedWindow ? t("dock.attach") : t("dock.detach")}
						data-hint={detachedWindow ? t("dock.attach") : t("dock.detach")}
						onClick={() => void (detachedWindow ? attachDock(dock) : detachDock(dock))}
					>
						<ExternalLink size={14} aria-hidden="true" />
					</button>
					{!detachedWindow && (
						<button
							type="button"
							className="icon-button"
							aria-label={dock.collapsed ? t("dock.expand") : t("dock.collapse")}
							data-hint={dock.collapsed ? t("dock.expand") : t("dock.collapse")}
							aria-expanded={!dock.collapsed}
							onClick={() => dock.setCollapsed(!dock.collapsed)}
						>
							{dock.collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
						</button>
					)}
				</div>
			</header>
			{!dock.collapsed && current && (
				<div className="session-dock-body">
					{loading && <p className="muted">{t("loading")}</p>}
					{seed && sameKey(seed.source, current) && (
						<SessionCreate
							key={`create-${keyId(seed.source)}`}
							projects={projects}
							seed={seed.seed}
							onDone={(created) => {
								const source = seed.source;
								setSeed(null);
								if (created) setFeedback({ key: source, text: t("summaryCreated") });
							}}
						/>
					)}
					<div className="session-dock-subbar">
						<div className="segmented" role="group" aria-label={t("dock.viewLabel")}>
							<button
								type="button"
								aria-pressed={!showTerminal}
								className={!showTerminal ? "selected" : ""}
								onClick={() => current && dock.setView(current, "conversation")}
							>
								{t("dock.conversation")}
							</button>
							<button
								type="button"
								aria-pressed={showTerminal}
								className={showTerminal ? "selected" : ""}
								disabled={!terminalAvailable}
								title={terminalAvailable ? undefined : reason(session?.capabilities.terminal.reason)}
								data-testid="dock-view-terminal"
								onClick={() => {
									if (!current || showTerminal) return;
									setStartNow(current);
									dock.setView(current, "terminal");
								}}
							>
								{t("terminal.tab")}
							</button>
						</div>
						{session && sameKey(renaming, session.key) ? (
							<SessionRename
								key={`rename-${keyId(session.key)}`}
								session={session}
								onDone={() => setRenaming(null)}
							/>
						) : (
							<div className="session-dock-identity">
								{projectName && <strong className="session-dock-project">{projectName}</strong>}
								{session && (
									<SessionBranchPicker
										key={`branch-${keyId(session.key)}`}
										session={session}
										onMessage={(text) => setFeedback({ key: session.key, text })}
									/>
								)}
								{session && (
									<span className={`session-state-line state-${session.state}`}>
										<span className="session-state-dot" aria-hidden="true" />
										{t(`states.${session.state}`)}
									</span>
								)}
								<small className="session-tool">{provider(current.provider)}</small>
							</div>
						)}
						<PopoverMenu label={t("more")} trigger={<MoreHorizontal size={14} />}>
							{(close) => (
								<>
									<MenuItem
										close={close}
										disabled={!session?.capabilities.rename.available}
										onSelect={() => setRenaming(current)}
									>
										{t("rename")}
									</MenuItem>
									{session?.project && onOpenProject && !detachedWindow && (
										<MenuItem close={close} onSelect={() => onOpenProject(session.project as string)}>
											{t("dock.returnToProject", { project: projectName ?? "" })}
										</MenuItem>
									)}
									<MenuItem
										close={close}
										disabled={!session?.project}
										onSelect={() => session && setSeed({ source: session.key, seed: seedFrom(session) })}
									>
										{t("newFromSummary")}
									</MenuItem>
									<MenuItem close={close} disabled={!session?.pinned} onSelect={() => unpin.mutate(current)}>
										{t("unpin")}
									</MenuItem>
								</>
							)}
						</PopoverMenu>
					</div>
					<div
						className="session-dock-panel"
						role="tabpanel"
						id={panelId(current)}
						aria-labelledby={tabId(current)}
					>
						{showTerminal ? (
							<TerminalView
								key={keyId(current)}
								sessionKey={current}
								running={runningHere}
								checking={running.isLoading}
								canStart={session?.capabilities.terminal.available === true}
								reason={reason(session?.capabilities.terminal.reason)}
								startNow={sameKey(startNow, current)}
								onStartConsumed={() => setStartNow(null)}
							/>
						) : (
							<SessionConversation key={keyId(current)} sessionKey={current} />
						)}
					</div>
					{permissions.requests.map((request) => (
						<div key={request.requestId} className="app-notice session-permission" role="alert">
							<span>
								{t("permissions.title", { tool: provider("claude") })} · <code>{request.toolName}</code>{" "}
								<small className="muted">{request.summary}</small>
							</span>
							<button
								type="button"
								className="primary-button"
								disabled={answer.isPending}
								onClick={() =>
									answer.mutate({ sessionId: request.sessionId, requestId: request.requestId, allow: true })
								}
							>
								{t("permissions.allow")}
							</button>
							<button
								type="button"
								className="quiet-button"
								disabled={answer.isPending}
								onClick={() =>
									answer.mutate({ sessionId: request.sessionId, requestId: request.requestId, allow: false })
								}
							>
								{t("permissions.deny")}
							</button>
						</div>
					))}
					<p className="session-feedback" role="status">
						{message}
					</p>
					{session && (
						<SessionComposer
							key={`composer-${keyId(session.key)}`}
							session={session}
							projectName={projectName}
							branch={branch.data?.current ?? null}
						/>
					)}
				</div>
			)}
		</section>
	);
}

/**
 * Terminal view of one tab. Restoring it (tab reopened, app restarted) only attaches to a PTY
 * the registry reports running; a new PTY starts only on an explicit action: choosing
 * Terminal from Conversation (`startNow`) or « Start terminal ».
 */
function TerminalView({
	sessionKey,
	running,
	checking,
	canStart,
	reason,
	startNow,
	onStartConsumed,
}: {
	sessionKey: SessionKey;
	running: boolean;
	checking: boolean;
	canStart: boolean;
	reason: string;
	startNow: boolean;
	/** The explicit request is used once: coming back to the tab restores, it never restarts. */
	onStartConsumed: () => void;
}) {
	const { t } = useSessionText();
	const [started, setStarted] = useState(startNow);
	useEffect(() => {
		if (startNow) onStartConsumed();
	}, [startNow, onStartConsumed]);
	const [generation, setGeneration] = useState(0);
	if (running || started)
		return (
			<SessionTerminal
				key={`${keyId(sessionKey)}-${generation}`}
				sessionKey={sessionKey}
				attachOnly={!started}
				onRestart={
					canStart
						? () => {
								setStarted(true);
								setGeneration((value) => value + 1);
							}
						: undefined
				}
			/>
		);
	if (checking) return <p className="muted">{t("loading")}</p>;
	return (
		<div className="session-terminal-stopped" data-testid="terminal-stopped">
			<p className="muted">{t("terminal.stopped")}</p>
			<button
				type="button"
				className="quiet-button"
				disabled={!canStart}
				title={canStart ? undefined : reason}
				onClick={() => setStarted(true)}
			>
				{t("terminal.start")}
			</button>
		</div>
	);
}

const DETACHED_LABEL = "session-dock";

/** Opens the explicit detached window; the backend keeps owning every provider transport. */
async function detachDock(dock: ReturnType<typeof useSessionDock>): Promise<void> {
	const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
	const existing = await WebviewWindow.getByLabel(DETACHED_LABEL);
	dock.setDetached(true);
	if (existing) {
		await existing.setFocus();
		return;
	}
	const window = new WebviewWindow(DETACHED_LABEL, {
		url: "index.html?window=session-dock",
		title: "BOA — Session",
		width: 720,
		height: 560,
		minWidth: 420,
		minHeight: 320,
	});
	void window.once("tauri://destroyed", () => dock.setDetached(false));
	void window.once("tauri://error", () => dock.setDetached(false));
}

async function attachDock(dock: ReturnType<typeof useSessionDock>): Promise<void> {
	dock.setDetached(false);
	const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
	const existing = await WebviewWindow.getByLabel(DETACHED_LABEL);
	await existing?.close();
}
