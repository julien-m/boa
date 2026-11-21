/**
 * Branch of the session's real working tree. Choosing a branch asks the agent to switch;
 * the label changes only when the backend reads the new branch in that working tree.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, GitBranch } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useSessionText } from "./session-labels";
import { keyId, type SessionSummary, sessionsApi } from "./sessions-api";

export function SessionBranchPicker({
	session,
	onMessage,
}: {
	session: SessionSummary;
	onMessage: (text: string) => void;
}) {
	const { t, error } = useSessionText();
	const id = useId();
	const popover = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const [filter, setFilter] = useState("");
	const queryClient = useQueryClient();
	const branch = useQuery({
		queryKey: ["sessions", "branch", keyId(session.key)],
		queryFn: () => sessionsApi.branch(session.key),
	});
	const request = useMutation({
		mutationFn: (target: string) => sessionsApi.requestBranch(session.key, target),
		onSuccess: () => {
			onMessage(t("branchPicker.requested"));
			void queryClient.invalidateQueries({ queryKey: ["sessions", "branch", keyId(session.key)] });
		},
		onError: (value) => onMessage(error(value)),
	});
	const clear = useMutation({
		mutationFn: () => sessionsApi.clearBranchRequest(session.key),
		onSuccess: () =>
			void queryClient.invalidateQueries({ queryKey: ["sessions", "branch", keyId(session.key)] }),
		onError: (value) => onMessage(error(value)),
	});
	const facts = branch.data;
	const label = facts ? (facts.detached ? t("branchPicker.detached") : (facts.current ?? "—")) : "…";
	const shared = (facts?.sharedWith.length ?? 0) > 0;
	const options = (facts?.options ?? []).filter((option) =>
		option.name.toLowerCase().includes(filter.trim().toLowerCase()),
	);
	return (
		<>
			<button
				ref={trigger}
				type="button"
				className="session-branch-trigger"
				aria-haspopup="dialog"
				{...({ commandfor: id, command: "toggle-popover" } as Record<string, string>)}
				title={branch.isError ? error(branch.error) : undefined}
			>
				<GitBranch size={12} aria-hidden="true" />
				<span className="code">{label}</span>
				{facts?.pending && (
					<small className={facts.pending.status === "unconfirmed" ? "session-feedback error" : "muted"}>
						{facts.pending.status === "unconfirmed"
							? t("branchPicker.unconfirmed", { branch: facts.pending.target })
							: t("branchPicker.pending", { branch: facts.pending.target })}
					</small>
				)}
				<ChevronDown size={12} aria-hidden="true" />
			</button>
			<div
				ref={popover}
				id={id}
				popover="auto"
				role="dialog"
				aria-label={t("branchPicker.title")}
				className="popover-menu branch-popover"
				onToggle={(event) => {
					if (event.newState !== "open" || !trigger.current || !popover.current) return;
					const anchor = trigger.current.getBoundingClientRect();
					const box = popover.current.getBoundingClientRect();
					const fitsBelow = anchor.bottom + 4 + box.height <= window.innerHeight;
					popover.current.style.top = `${fitsBelow ? anchor.bottom + 4 : Math.max(4, anchor.top - 4 - box.height)}px`;
					popover.current.style.left = `${Math.min(anchor.left, window.innerWidth - box.width - 4)}px`;
					void branch.refetch();
				}}
			>
				<div className="branch-popover-body">
					<span className="eyebrow">{t("branchPicker.title")}</span>
					<input
						type="search"
						aria-label={t("branchPicker.filter")}
						placeholder={t("branchPicker.filter")}
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
					/>
					{shared && <p className="session-feedback error">{t("branchPicker.shared")}</p>}
					{facts?.pending?.status === "unconfirmed" && (
						<div className="session-actions-row" data-testid="branch-unconfirmed">
							<small className="muted">
								{t("branchPicker.unconfirmedHint", { branch: facts.pending.target })}
							</small>
							<button type="button" className="quiet-button" onClick={() => void branch.refetch()}>
								{t("branchPicker.refresh")}
							</button>
							<button type="button" className="quiet-button" onClick={() => clear.mutate()}>
								{t("branchPicker.clear")}
							</button>
						</div>
					)}
					<ul className="branch-options" aria-label={t("branchPicker.title")}>
						{options.map((option) => {
							const active = option.name === facts?.current;
							return (
								<li key={option.name}>
									<button
										type="button"
										className={active ? "selected" : ""}
										aria-current={active ? "true" : undefined}
										disabled={active || shared || request.isPending}
										onClick={() => {
											popover.current?.hidePopover();
											request.mutate(option.name);
										}}
									>
										<span className="branch-check">{active && <Check size={12} aria-hidden="true" />}</span>
										<span className="code">{option.name}</span>
										<small className="muted">
											{active
												? t("branchPicker.active")
												: option.worktree
													? t("branchPicker.worktree", { path: option.worktree.split("/").pop() })
													: ""}
										</small>
									</button>
								</li>
							);
						})}
					</ul>
					<small className="muted">{t("branchPicker.footer")}</small>
				</div>
			</div>
		</>
	);
}
