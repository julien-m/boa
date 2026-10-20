/** Drafts survive tab/project navigation while editing stays in the existing reader. */
import { useQueryClient } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import type { Preview, Selection } from "./models";

type Draft = {
	project: string;
	path: string;
	original: string;
	content: string;
	saving: boolean;
	error: string;
};
const keyOf = (project: string, path: string): string => JSON.stringify([project, path]);
const EditingContext = createContext<{
	drafts: Record<string, Draft>;
	start: (project: string, path: string, original: string) => void;
	change: (project: string, path: string, content: string) => void;
	cancel: (project: string, path: string) => void;
	save: (project: string, path: string) => Promise<void>;
} | null>(null);

export function useFileEditing() {
	const context = useContext(EditingContext);
	if (!context) throw new Error("FileEditingProvider missing");
	return { ...context, draft: (project: string, path: string) => context.drafts[keyOf(project, path)] };
}

export function FileEditingProvider({ children }: { children: ReactNode }) {
	const client = useQueryClient();
	const { t } = useTranslation("workspace");
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const [warning, setWarning] = useState(false);
	const current = useRef(drafts);
	current.current = drafts;
	const pending = Object.values(drafts).some((draft) => draft.saving || draft.content !== draft.original);
	useEffect(() => {
		if (!pending) {
			setWarning(false);
			return;
		}
		const unlisten = getCurrentWindow().onCloseRequested((event) => {
			event.preventDefault();
			setWarning(true);
		});
		const unload = (event: BeforeUnloadEvent): void => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", unload);
		return () => {
			window.removeEventListener("beforeunload", unload);
			void unlisten.then((stop) => stop()).catch(() => {});
		};
	}, [pending]);
	const patch = (key: string, values: Partial<Draft>): void => {
		setDrafts((all) => (all[key] ? { ...all, [key]: { ...all[key], ...values } } : all));
	};
	const cancel = (project: string, path: string): void => {
		const key = keyOf(project, path);
		if (current.current[key]?.saving) return;
		setDrafts((all) => {
			const next = { ...all };
			delete next[key];
			return next;
		});
	};
	return (
		<EditingContext.Provider
			value={{
				drafts,
				start: (project, path, original) => {
					const key = keyOf(project, path);
					setDrafts((all) =>
						all[key]
							? all
							: { ...all, [key]: { project, path, original, content: original, saving: false, error: "" } },
					);
				},
				change: (project, path, content) => patch(keyOf(project, path), { content }),
				cancel,
				save: async (project, path) => {
					const key = keyOf(project, path);
					const draft = current.current[key];
					if (!draft || draft.saving) return;
					patch(key, { saving: true, error: "" });
					try {
						if (draft.content !== draft.original)
							await api.saveFile(project, path, draft.original, draft.content);
						client.setQueriesData<Preview>(
							{
								predicate: (query) => {
									const selected =
										query.queryKey[0] === "preview" ? (query.queryKey[1] as Selection | null) : null;
									return Boolean(
										selected && !selected.repo && selected.project === project && selected.path === path,
									);
								},
							},
							(previous) => (previous ? { ...previous, modified: draft.content } : previous),
						);
						setDrafts((all) => {
							const next = { ...all };
							delete next[key];
							return next;
						});
						void client.invalidateQueries({ queryKey: ["preview"] });
						void client.invalidateQueries({ queryKey: ["summary", project] });
						void client.invalidateQueries({ queryKey: ["directory", project] });
					} catch (cause) {
						patch(key, { saving: false, error: String(cause) });
					}
				},
			}}
		>
			{children}
			{warning && (
				<div className="draft-warning" role="alert">
					{t("edit.closeWarning")}
				</div>
			)}
		</EditingContext.Provider>
	);
}

export function DraftIndicator() {
	const { t } = useTranslation("workspace");
	const { drafts } = useFileEditing();
	const dirty = Object.values(drafts).filter((draft) => draft.content !== draft.original || draft.saving);
	if (!dirty.length) return null;
	return (
		<details className="draft-indicator" data-testid="draft-indicator">
			<summary>{t("edit.drafts", { count: dirty.length })}</summary>
			<div>
				{dirty.map((draft) => (
					<button
						type="button"
						key={keyOf(draft.project, draft.path)}
						data-hint={`${draft.project}/${draft.path}`}
						onClick={(event) => {
							event.currentTarget.closest("details")?.removeAttribute("open");
							window.dispatchEvent(
								new CustomEvent("boa:resume-draft", { detail: { project: draft.project, path: draft.path } }),
							);
						}}
					>
						{draft.path}
					</button>
				))}
			</div>
		</details>
	);
}
