/**
 * Session target for the context composer: pinned sessions first, all sessions on demand,
 * then Copier / Préparer le message / Envoyer. The exact preview above is what is sent.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useId, useState } from "react";
import { useSessionDock } from "./session-dock-state";
import { useSessionText } from "./session-labels";
import { keyId, type SendReceipt, type SessionKey, sameKey, sessionsApi } from "./sessions-api";

type Sent = {
	at: number;
	key: SessionKey;
	title: string;
	text: string;
	receipt?: SendReceipt;
	error?: string;
};

export function ContextSessionTarget({
	prompt,
	blockedReason,
	onPrepared,
}: {
	prompt: string;
	/** Localized reason when the collection cannot be transmitted as text (images, drafts). */
	blockedReason: string | null;
	onPrepared: () => void;
}) {
	const { t, provider, state, error, receipt, reason } = useSessionText();
	const id = useId();
	const dock = useSessionDock();
	const queryClient = useQueryClient();
	const [scope, setScope] = useState<"pinned" | "all">("pinned");
	const [search, setSearch] = useState("");
	const [target, setTarget] = useState<SessionKey | null>(dock.current);
	const [sent, setSent] = useState<Sent[]>([]);
	const [notice, setNotice] = useState("");
	const listing = useQuery({
		queryKey: ["sessions", "list", { scope, search }],
		queryFn: () => sessionsApi.list({ scope, search: search.trim() || undefined }),
	});
	const sessions = listing.data?.sessions ?? [];
	const chosen = sessions.find((session) => sameKey(session.key, target)) ?? null;
	// Target, title and text are captured at click time; results stay attached to that target.
	const send = useMutation({
		mutationFn: (input: { key: SessionKey; title: string; text: string }) =>
			sessionsApi.send(input.key, input.text),
		onSuccess: (result, input) => {
			setSent((current) =>
				[
					{ at: Date.now(), key: input.key, title: input.title, text: input.text, receipt: result },
					...current,
				].slice(0, 5),
			);
			void queryClient.invalidateQueries({ queryKey: ["sessions"] });
		},
		onError: (value, input) =>
			setSent((current) =>
				[
					{ at: Date.now(), key: input.key, title: input.title, text: input.text, error: error(value) },
					...current,
				].slice(0, 5),
			),
	});
	const blocked =
		blockedReason ??
		(chosen && !chosen.capabilities.send.available ? reason(chosen.capabilities.send.reason) : null);
	return (
		<section
			className="context-session-target"
			aria-labelledby={`${id}-title`}
			data-testid="context-session-target"
		>
			<div className="session-actions-row">
				<h3 id={`${id}-title`} className="eyebrow">
					{t("context.title")}
				</h3>
				<small className="muted">{scope === "pinned" ? t("context.pinnedFirst") : t("allTab")}</small>
				{scope === "pinned" ? (
					<button type="button" className="quiet-button" onClick={() => setScope("all")}>
						{t("context.allSessions")}
					</button>
				) : (
					<input
						type="search"
						aria-label={t("searchLabel")}
						placeholder={t("searchPlaceholder")}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
				)}
			</div>
			{listing.data && !listing.data.discoveryEnabled && (
				<p className="muted">{t("errors.discovery_disabled")}</p>
			)}
			<fieldset className="context-session-options">
				<legend className="sr-only">{t("context.title")}</legend>
				{sessions.map((session) => (
					<label key={keyId(session.key)} className="context-session-option">
						<input
							type="radio"
							name={`${id}-target`}
							checked={sameKey(session.key, target)}
							onChange={() => setTarget(session.key)}
						/>
						<span>
							{session.title || session.key.id}
							<small>
								{[session.project?.split("/").pop(), session.recordedBranch, provider(session.key.provider)]
									.filter(Boolean)
									.join(" · ")}
							</small>
						</span>
						<span className={`session-state-line state-${session.state}`}>
							<span className="session-state-dot" aria-hidden="true" />
							{state(session.state)}
						</span>
					</label>
				))}
			</fieldset>
			<p className="muted">
				{chosen ? (
					<>
						{t("context.to")} <strong>{chosen.title}</strong> · {provider(chosen.key.provider)}
						{chosen.project && ` · ${chosen.project.split("/").pop()}`}
						{chosen.recordedBranch && ` / ${chosen.recordedBranch}`}
					</>
				) : (
					t("context.noTarget")
				)}
			</p>
			{chosen && !blocked && (
				<small className="muted">{t("composer.sendModeHint", { tool: provider(chosen.key.provider) })}</small>
			)}
			{blocked && <p className="session-feedback error">{blocked}</p>}
			<div className="context-session-actions">
				<span className="session-feedback" role="status">
					{notice}
				</span>
				<button
					type="button"
					className="quiet-button"
					disabled={!prompt}
					onClick={() =>
						void writeText(prompt).then(
							() => setNotice(t("context.copy")),
							(value: unknown) => setNotice(String(value)),
						)
					}
				>
					{t("context.copy")}
				</button>
				<button
					type="button"
					className="quiet-button"
					disabled={!chosen || !prompt}
					onClick={() => {
						if (!chosen) return;
						const existing = dock.draftFor(chosen.key);
						dock.setDraft(chosen.key, existing ? `${existing}\n\n${prompt}` : prompt);
						dock.show(chosen.key);
						setNotice(t("composer.prepared"));
						onPrepared();
					}}
				>
					{t("context.prepare")}
				</button>
				<button
					type="button"
					className="primary-button"
					data-testid="context-session-send"
					disabled={!chosen || !prompt || !!blocked || send.isPending}
					onClick={() =>
						chosen && send.mutate({ key: chosen.key, title: chosen.title || chosen.key.id, text: prompt })
					}
				>
					{send.isPending ? t("composer.sending") : t("context.send")}
				</button>
			</div>
			{sent.length > 0 && (
				<div className="context-session-target">
					<span className="eyebrow">{t("context.recent")}</span>
					{sent.map((item) => (
						<p
							key={`${item.at}-${keyId(item.key)}`}
							className={item.error ? "session-feedback error" : "session-feedback"}
						>
							{new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(item.at)} ·{" "}
							{item.error
								? `${t("context.failed")} : ${item.error}`
								: receipt(item.receipt as SendReceipt, item.key.provider)}{" "}
							· {item.title}
							{item.error && (
								<button
									type="button"
									className="quiet-button"
									disabled={send.isPending}
									onClick={() => send.mutate({ key: item.key, title: item.title, text: item.text })}
								>
									{t("context.retry")}
								</button>
							)}
						</p>
					))}
				</div>
			)}
		</section>
	);
}
