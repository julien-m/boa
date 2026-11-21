/** New native session in a registered project; opens it in the dock once the provider confirms. */
import { useIsMutating, useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSessionDock } from "./session-dock-state";
import { useSessionText } from "./session-labels";
import { type CreatedSession, keyId, type Provider, type SessionKey, sessionsApi } from "./sessions-api";
import type { ProjectRef } from "./sessions-view";

/** Prefill for « Nouvelle session depuis un résumé »: same tool and project, editable text. */
export type SessionSeed = { provider: Provider; project: string; title: string; text: string; hint: string };

function needsConfirmation(result: CreatedSession): boolean {
	return result.receipt.status === "unknown" || !!result.titleWarning;
}

export function SessionCreate({
	projects,
	onDone,
	seed,
	sourceSession,
}: {
	projects: ProjectRef[];
	onDone: (key: SessionKey | null) => void;
	seed?: SessionSeed;
	sourceSession?: SessionKey;
}) {
	const { t, provider, error, receipt } = useSessionText();
	const id = useId();
	const dock = useSessionDock();
	const queryClient = useQueryClient();
	const [tool, setTool] = useState<Provider>(seed?.provider ?? "codex");
	const [project, setProject] = useState(seed?.project ?? projects[0]?.path ?? "");
	const [title, setTitle] = useState(seed?.title ?? "");
	const [text, setText] = useState(seed?.text ?? "");
	const filters = {
		mutationKey: ["sessions", "create", sourceSession ? keyId(sourceSession) : null],
		exact: true,
	} as const;
	const pending = useIsMutating(filters) > 0;
	const results = useMutationState({
		filters,
		select: (mutation) => mutation.state.data as CreatedSession | undefined,
	});
	const clearReceipt = () => {
		const cache = queryClient.getMutationCache();
		for (const operation of cache.findAll(filters)) cache.remove(operation);
	};
	const open = (key: SessionKey) => {
		clearReceipt();
		dock.show(key);
		onDone(key);
	};
	const create = useMutation({
		mutationKey: filters.mutationKey,
		// A partial receipt must survive remounting until the user opens the resulting session.
		gcTime: Infinity,
		mutationFn: () => sessionsApi.create(tool, project, text, title.trim() || undefined),
		onSuccess: (result) => {
			void queryClient.invalidateQueries({ queryKey: ["sessions"] });
			if (!needsConfirmation(result)) open(result.session);
		},
		onError: clearReceipt,
	});
	const result = results.at(-1);
	if (result && needsConfirmation(result)) {
		return (
			<section className="settings-card session-create" aria-labelledby={`${id}-title`}>
				<h2 id={`${id}-title`}>{seed ? t("newFromSummary") : t("newSession")}</h2>
				<div className="session-actions-row">
					<p className="session-feedback error" role="status">
						{result.titleWarning
							? t("creationTitleWarning")
							: receipt(result.receipt, result.session.provider)}
					</p>
					<button type="button" className="primary-button" onClick={() => open(result.session)}>
						{t("openDock")}
					</button>
				</div>
			</section>
		);
	}
	return (
		<form
			className="settings-card session-create"
			aria-labelledby={`${id}-title`}
			onSubmit={(event) => {
				event.preventDefault();
				if (!queryClient.isMutating(filters) && project && text.trim()) create.mutate();
			}}
		>
			<h2 id={`${id}-title`}>{seed ? t("newFromSummary") : t("newSession")}</h2>
			{seed && <p className="muted">{seed.hint}</p>}
			<div className="session-create-fields">
				<label className="field">
					<span>{t("toolFilter")}</span>
					<select value={tool} onChange={(event) => setTool(event.target.value as Provider)}>
						<option value="codex">{provider("codex")}</option>
						<option value="claude">{provider("claude")}</option>
					</select>
				</label>
				<label className="field">
					<span>{t("projectFilter")}</span>
					<select value={project} onChange={(event) => setProject(event.target.value)}>
						{projects.map((item) => (
							<option key={item.path} value={item.path}>
								{item.name}
							</option>
						))}
					</select>
				</label>
				<label className="field">
					<span>{t("renameField")}</span>
					<input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
				</label>
			</div>
			<label className="field">
				<span>{t("composer.label")}</span>
				<textarea rows={seed ? 8 : 3} value={text} onChange={(event) => setText(event.target.value)} />
			</label>
			<div className="session-actions-row">
				<button type="submit" className="primary-button" disabled={pending || !text.trim() || !project}>
					{pending ? t("composer.sending") : t("composer.send")}
				</button>
				<button type="button" className="quiet-button" disabled={pending} onClick={() => onDone(null)}>
					{t("cancel")}
				</button>
				<span className={create.isError ? "session-feedback error" : "session-feedback"} role="status">
					{create.isError ? error(create.error) : ""}
				</span>
			</div>
		</form>
	);
}
