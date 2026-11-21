/** One catalog row: title (and dock badge), project, state with its evidence in the tooltip, activity. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitBranch, MoreHorizontal, Pin } from "lucide-react";
import { useState } from "react";
import { MenuItem, PopoverMenu } from "./popover-menu";
import { useSessionDock } from "./session-dock-state";
import { activityParts, useSessionText } from "./session-labels";
import { SessionRename } from "./session-rename";
import { type SessionSummary, sameKey, sessionsApi } from "./sessions-api";

export function StateBadge({ session, compact = false }: { session: SessionSummary; compact?: boolean }) {
	const { t, state } = useSessionText();
	const evidence = t(`evidence.${session.evidence}`);
	return (
		<span
			className={`session-state state-${session.state}`}
			title={compact ? evidence : undefined}
			role={compact ? "cell" : undefined}
		>
			<span className="session-state-line">
				<span className="session-state-dot" aria-hidden="true" />
				{state(session.state)}
			</span>
			{!compact && <small>{evidence}</small>}
		</span>
	);
}

export function SessionRow({
	session,
	projectName,
	selected,
	onSelect,
	onMessage,
}: {
	session: SessionSummary;
	projectName?: string | null;
	selected: boolean;
	onSelect: () => void;
	onMessage: (text: string) => void;
}) {
	const { t, provider, error, reason } = useSessionText();
	const dock = useSessionDock();
	const queryClient = useQueryClient();
	const [renaming, setRenaming] = useState(false);
	const tool = provider(session.key.provider);
	const activity = activityParts(session.updatedAt);
	const refresh = () => void queryClient.invalidateQueries({ queryKey: ["sessions"] });
	const pin = useMutation({
		mutationFn: (pinned: boolean) => sessionsApi.pin(session.key, pinned),
		onSuccess: refresh,
		onError: (value) => onMessage(error(value)),
	});
	const run = (task: () => Promise<unknown>, success?: string) =>
		void task().then(
			() => {
				refresh();
				if (success) onMessage(success);
			},
			(value: unknown) => onMessage(error(value)),
		);
	const docked = dock.tabs.some((tab) => sameKey(tab, session.key));
	return (
		<div
			className={`session-row ${selected ? "selected" : ""}`}
			role="row"
			data-testid={`session-row-${session.key.id}`}
			aria-selected={selected}
		>
			<div className="session-title-cell" role="cell">
				{renaming ? (
					<SessionRename session={session} onDone={() => setRenaming(false)} />
				) : (
					<button
						type="button"
						className="session-title-button"
						title={session.title || session.key.id}
						onClick={onSelect}
						onDoubleClick={() => dock.show(session.key)}
						onKeyDown={(event) => {
							if (event.key !== "Enter") return;
							event.preventDefault();
							onSelect();
							dock.show(session.key);
						}}
					>
						<span className="session-title-line">
							<span className="session-title">{session.title || session.key.id}</span>
							{docked && <span className="session-docked">{t("inDock")}</span>}
						</span>
						<span className="session-meta">
							{session.pinned && (
								<span className="session-pinned">
									<Pin size={10} aria-hidden="true" />
									<span className="sr-only">{t("pinnedYes")}</span>
								</span>
							)}
							{session.recordedBranch && (
								<span className="session-branch">
									<GitBranch size={11} aria-hidden="true" />
									{session.recordedBranch}
								</span>
							)}
							<span className="session-tool">{tool}</span>
						</span>
					</button>
				)}
			</div>
			<span className="session-project" role="cell">
				{projectName ?? (session.project ? session.project.split("/").pop() : t("outsideProjects"))}
			</span>
			<StateBadge session={session} compact />
			<span className="session-activity" role="cell" title={activity?.absolute}>
				{activity?.relative ?? t("activityNever")}
			</span>
			<span role="cell" className="session-row-menu">
				<PopoverMenu label={t("more")} trigger={<MoreHorizontal size={14} />}>
					{(close) => (
						<>
							<MenuItem close={close} onSelect={() => dock.show(session.key)}>
								{t("openDock")}
							</MenuItem>
							<MenuItem
								close={close}
								disabled={!session.capabilities.rename.available}
								hint={reason(session.capabilities.rename.reason)}
								onSelect={() => setRenaming(true)}
							>
								{t("rename")}
							</MenuItem>
							<MenuItem close={close} onSelect={() => pin.mutate(!session.pinned)}>
								{session.pinned ? t("unpin") : t("pin")}
							</MenuItem>
							<MenuItem
								close={close}
								disabled={!session.capabilities.resume.available}
								hint={
									session.capabilities.resume.available
										? t("resumeHint")
										: reason(session.capabilities.resume.reason)
								}
								onSelect={() => run(() => sessionsApi.resume(session.key))}
							>
								{t("resume")}
							</MenuItem>
							<MenuItem
								close={close}
								disabled={!session.capabilities.openInApp.available}
								hint={reason(session.capabilities.openInApp.reason)}
								onSelect={() => run(() => sessionsApi.openInApp(session.key), t("openRequested", { tool }))}
							>
								{t("openInApp", { tool })}
							</MenuItem>
						</>
					)}
				</PopoverMenu>
			</span>
		</div>
	);
}
