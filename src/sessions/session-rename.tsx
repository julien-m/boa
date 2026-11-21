/** Inline rename: the title changes only after the provider source confirms it. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSessionText } from "./session-labels";
import { type SessionSummary, sessionsApi } from "./sessions-api";

export function SessionRename({ session, onDone }: { session: SessionSummary; onDone: () => void }) {
	const { t, provider, error } = useSessionText();
	const [title, setTitle] = useState(session.title);
	const input = useRef<HTMLInputElement>(null);
	const queryClient = useQueryClient();
	const rename = useMutation({
		mutationFn: (next: string) => sessionsApi.rename(session.key, next),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["sessions"] });
			onDone();
		},
	});
	useEffect(() => {
		input.current?.select();
	}, []);
	const trimmed = title.trim();
	const tool = provider(session.key.provider);
	return (
		<form
			className="session-rename"
			onSubmit={(event) => {
				event.preventDefault();
				if (trimmed && trimmed !== session.title) rename.mutate(trimmed);
			}}
		>
			<div className="session-rename-row">
				<input
					ref={input}
					aria-label={t("renameField")}
					value={title}
					maxLength={200}
					disabled={rename.isPending}
					onChange={(event) => setTitle(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							onDone();
						}
					}}
				/>
				<button
					type="submit"
					className="primary-button"
					disabled={rename.isPending || !trimmed || trimmed === session.title}
				>
					{t("validate")}
				</button>
				<button type="button" className="quiet-button" onClick={onDone} disabled={rename.isPending}>
					{t("cancel")}
				</button>
			</div>
			<small className={rename.isError ? "session-feedback error" : "session-feedback"} role="status">
				{rename.isPending ? t("renamePending", { tool }) : rename.isError ? error(rename.error) : ""}
			</small>
		</form>
	);
}
