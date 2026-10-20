import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderPlus, Keyboard, X } from "lucide-react";
import { useState } from "react";
import { defaultShortcuts, type FileSpace, fileWorkspace } from "./file-workspace-api";
import { useFileLabels } from "./file-workspace-labels";
import { validSearchShortcuts } from "./search-shortcuts";
export function FileWorkspaceSettings() {
	const l = useFileLabels();
	const client = useQueryClient();
	const state = useQuery({ queryKey: ["file-workspace"], queryFn: fileWorkspace.state, retry: false });
	const [draft, setDraft] = useState<FileSpace | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const shortcuts = state.data?.shortcuts ?? defaultShortcuts;
	const refresh = () => client.invalidateQueries({ queryKey: ["file-workspace"] });
	const perform = async (task: () => Promise<unknown>) => {
		setBusy(true);
		setError("");
		try {
			await task();
			await refresh();
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<section className="settings-card">
				<h2>{l.spaces}</h2>
				<p>{l.rootHint}</p>
				{(state.data?.spaces ?? []).map((space) => (
					<div className="space-settings-row" key={space.id}>
						<strong>{space.name}</strong>
						<span className="muted truncate" title={space.roots.join("\n")}>
							{space.roots.join(" · ")}
						</span>
						<button
							type="button"
							className="quiet-button"
							disabled={busy}
							onClick={() => setDraft({ ...space, roots: [...space.roots] })}
						>
							{l.edit}
						</button>
						<button
							type="button"
							className="icon-button"
							disabled={busy}
							aria-label={`${l.remove} ${space.name}`}
							onClick={() => void perform(() => fileWorkspace.remove(space.id))}
						>
							<X size={14} />
						</button>
					</div>
				))}
				{!draft ? (
					<button
						type="button"
						className="quiet-button"
						onClick={() => setDraft({ id: crypto.randomUUID(), name: "", roots: [] })}
					>
						<FolderPlus size={14} />
						{l.create}
					</button>
				) : (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void perform(async () => {
								await fileWorkspace.save(draft);
								setDraft(null);
							});
						}}
					>
						<label>
							{l.name}
							<input
								required
								maxLength={100}
								value={draft.name}
								onChange={(e) => setDraft({ ...draft, name: e.target.value })}
							/>
						</label>
						{draft.roots.map((root) => (
							<div className="space-settings-row" key={root}>
								<span className="truncate" title={root}>
									{root}
								</span>
								<button
									type="button"
									className="icon-button"
									aria-label={`${l.remove} ${root}`}
									onClick={() => setDraft({ ...draft, roots: draft.roots.filter((r) => r !== root) })}
								>
									<X size={13} />
								</button>
							</div>
						))}
						<button
							type="button"
							className="quiet-button"
							onClick={() => {
								void open({ directory: true, multiple: true, title: l.addRoot })
									.then((value) => {
										if (value)
											setDraft((current) =>
												current
													? {
															...current,
															roots: [
																...new Set([...current.roots, ...(Array.isArray(value) ? value : [value])]),
															],
														}
													: null,
											);
									})
									.catch((e) => setError(String(e)));
							}}
						>
							{l.addRoot}
						</button>
						<button
							type="submit"
							className="quiet-button"
							disabled={busy || !draft.name.trim() || !draft.roots.length}
						>
							{l.save}
						</button>
						<button type="button" className="quiet-button" onClick={() => setDraft(null)}>
							{l.cancel}
						</button>
					</form>
				)}
			</section>
			<section className="settings-card">
				<h2>
					<Keyboard size={18} /> {l.shortcutTitle}
				</h2>
				<p>{l.shortcutHint}</p>
				{(["contextual", "global"] as const).map((field) => (
					<label className="language-field" key={field}>
						<span>{field === "contextual" ? l.contextual : l.globalShortcut}</span>
						<input
							className="shortcut-field"
							aria-label={field === "contextual" ? l.contextual : l.globalShortcut}
							readOnly
							value={shortcuts[field].replace("Mod", navigator.platform.includes("Mac") ? "⌘" : "Ctrl")}
							disabled={busy}
							onKeyDown={(e) => {
								e.stopPropagation();
								if (e.metaKey || e.ctrlKey) {
									e.preventDefault();
									if (!/^[a-z]$/i.test(e.key)) return;
									const next = {
										...shortcuts,
										[field]: `Mod+${e.shiftKey ? "Shift+" : ""}${e.altKey ? "Alt+" : ""}${e.key.toUpperCase()}`,
									};
									if (!validSearchShortcuts(next)) {
										setError(l.shortcutError);
										return;
									}
									void perform(() => fileWorkspace.shortcuts(next));
								}
							}}
						/>
					</label>
				))}
				<button
					type="button"
					className="quiet-button"
					disabled={busy}
					onClick={() => void perform(() => fileWorkspace.shortcuts(defaultShortcuts))}
				>
					{l.reset}
				</button>
			</section>
			{(error || state.error) && (
				<p className="error" role="alert">
					{error || String(state.error)}
				</p>
			)}
		</>
	);
}
