/** New native session in a registered project; opens it in the dock once the provider confirms. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSessionDock } from "./session-dock-state";
import { useSessionText } from "./session-labels";
import { type Provider, type SessionKey, sessionsApi } from "./sessions-api";
import type { ProjectRef } from "./sessions-view";

/** Prefill for « Nouvelle session depuis un résumé »: same tool and project, editable text. */
export type SessionSeed = { provider: Provider; project: string; title: string; text: string; hint: string };

export function SessionCreate({
	projects,
	onDone,
	seed,
}: {
	projects: ProjectRef[];
	onDone: (key: SessionKey | null) => void;
	seed?: SessionSeed;
}) {
	const { t, provider, error, receipt } = useSessionText();
	const id = useId();
	const dock = useSessionDock();
	const queryClient = useQueryClient();
	const [tool, setTool] = useState<Provider>(seed?.provider ?? "codex");
	const [project, setProject] = useState(seed?.project ?? projects[0]?.path ?? "");
	const [title, setTitle] = useState(seed?.title ?? "");
	const [text, setText] = useState(seed?.text ?? "");
	const create = useMutation({
		mutationFn: () => sessionsApi.create(tool, project, text, title.trim() || undefined),
		onSuccess: (result) => {
			void queryClient.invalidateQueries({ queryKey: ["sessions"] });
			dock.show(result.session);
			onDone(result.session);
		},
	});
	return (
		<form
			className="settings-card session-create"
			aria-labelledby={`${id}-title`}
			onSubmit={(event) => {
				event.preventDefault();
				if (project && text.trim()) create.mutate();
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
				<button
					type="submit"
					className="primary-button"
					disabled={create.isPending || !text.trim() || !project}
				>
					{create.isPending ? t("composer.sending") : t("composer.send")}
				</button>
				<button type="button" className="quiet-button" onClick={() => onDone(null)}>
					{t("cancel")}
				</button>
				<span className={create.isError ? "session-feedback error" : "session-feedback"} role="status">
					{create.isError ? error(create.error) : create.data ? receipt(create.data.receipt, tool) : ""}
				</span>
			</div>
		</form>
	);
}
