/**
 * Composer bound to the docked session: action buttons, draft and immediate « Envoyer ».
 * BOA never queues: the provider's own queue/steer policy handles a running session.
 */
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { captureCurrentReaderContext } from "../code-viewer";
import { useSessionDock } from "./session-dock-state";
import { useSessionText } from "./session-labels";
import {
	keyId,
	type SendReceipt,
	type SessionKey,
	type SessionSummary,
	sameKey,
	sessionsApi,
} from "./sessions-api";

type SessionSubmission = { key: SessionKey; text: string; fromDraft: boolean };
const sendKey = (key: SessionKey) => ["sessions", "send", keyId(key)] as const;

export function SessionComposer({
	session,
	projectName,
	branch,
}: {
	session: SessionSummary;
	projectName: string | null;
	branch: string | null;
}) {
	const { t, provider, error, receipt, reason } = useSessionText();
	const dock = useSessionDock();
	const queryClient = useQueryClient();
	// A collapsed dock or a tab switch can remount the composer during acknowledgement.
	const sending = useIsMutating({ mutationKey: sendKey(session.key), exact: true }) > 0;
	/** Feedback stays attached to the session it concerns, even if the dock switches meanwhile. */
	const [feedback, setFeedback] = useState<{ key: SessionKey; text: string; error: boolean } | null>(null);
	const shownFeedback = feedback && sameKey(feedback.key, session.key) ? feedback : null;
	const draft = dock.draftFor(session.key);
	const tool = provider(session.key.provider);
	const actions = useQuery({
		queryKey: ["sessions", "actions", session.project ?? ""],
		queryFn: () => sessionsApi.actions(session.project),
	});
	const visible = (actions.data?.actions ?? []).filter(
		(action) => action.enabled && action.providers.includes(session.key.provider),
	);
	// Every mutation carries its target key from the click: callbacks never read the current view.
	const send = useMutation({
		mutationKey: sendKey(session.key),
		mutationFn: (input: SessionSubmission) => sessionsApi.send(input.key, input.text),
		onSuccess: (result: SendReceipt, input) => {
			setFeedback({
				key: input.key,
				text: receipt(result, input.key.provider),
				error: result.status === "unknown",
			});
			// Only a confirmed transmission clears the draft, and only if it was not edited meanwhile.
			if (input.fromDraft && result.status !== "unknown") dock.clearDraftIf(input.key, input.text);
		},
		onError: (value, input) => setFeedback({ key: input.key, text: error(value), error: true }),
	});
	const submit = (input: SessionSubmission) => {
		if (queryClient.isMutating({ mutationKey: sendKey(input.key), exact: true })) return;
		send.mutate(input);
	};
	const runAction = useMutation({
		mutationFn: (input: { key: SessionKey; actionId: string; file?: string; selection?: string }) =>
			sessionsApi.renderAction(input.key, input.actionId, input.file, input.selection),
		onSuccess: (rendered, input) => {
			if (rendered.mode === "send") submit({ key: input.key, text: rendered.text, fromDraft: false });
			else {
				dock.setDraft(input.key, rendered.text);
				setFeedback({ key: input.key, text: t("composer.prepared"), error: false });
			}
		},
		onError: (value, input) => setFeedback({ key: input.key, text: error(value), error: true }),
	});
	const canSend = session.capabilities.send.available;
	const canSubmitDraft = canSend && !sending && !runAction.isPending && draft.trim().length > 0;
	const submitDraft = () => {
		if (canSubmitDraft) submit({ key: session.key, text: draft, fromDraft: true });
	};
	/** {fichier} and {sélection} come from the reader at click time; the file names its project. */
	const readerValues = (): { file?: string; selection?: string } => {
		const context = captureCurrentReaderContext();
		if (!context) return {};
		const lines = context.startLine ? `:${context.startLine}-${context.endLine}` : "";
		return {
			file: `${context.path}${lines}`,
			selection: context.code.trim() ? context.code : undefined,
		};
	};
	return (
		<div className="session-composer">
			<div className="session-composer-head">
				<span className="session-composer-target muted">
					{t("composer.target")} <strong>{session.title || session.key.id}</strong> · {tool}
					{projectName && ` · ${projectName}`}
					{branch && ` / ${branch}`}
				</span>
				{visible.length > 0 && (
					<div className="session-action-buttons" role="group" aria-label={t("composer.actions")}>
						{visible.map((action) => (
							<button
								type="button"
								key={action.id}
								className="quiet-button"
								disabled={runAction.isPending || sending || (action.mode === "send" && !canSend)}
								onClick={() => runAction.mutate({ key: session.key, actionId: action.id, ...readerValues() })}
							>
								{action.label}
							</button>
						))}
					</div>
				)}
			</div>
			<form
				className="session-composer-form"
				onSubmit={(event) => {
					event.preventDefault();
					submitDraft();
				}}
			>
				<textarea
					aria-label={t("composer.label")}
					placeholder={t("composer.placeholder")}
					rows={2}
					value={draft}
					onChange={(event) => dock.setDraft(session.key, event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							submitDraft();
						}
					}}
				/>
				<button
					type="submit"
					className="primary-button"
					data-testid="session-send"
					disabled={!canSubmitDraft}
					title={canSend ? t("composer.sendModeHint", { tool }) : reason(session.capabilities.send.reason)}
				>
					{sending ? t("composer.sending") : t("composer.send")}
				</button>
			</form>
			<span className={shownFeedback?.error ? "session-feedback error" : "session-feedback"} role="status">
				{!canSend
					? t("composer.disabled", { reason: reason(session.capabilities.send.reason) })
					: (shownFeedback?.text ?? "")}
			</span>
		</div>
	);
}
