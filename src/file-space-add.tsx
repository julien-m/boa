import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fileWorkspace } from "./file-workspace-api";
import { useFileLabels } from "./file-workspace-labels";
import type { DirectoryEntry } from "./models";

export function FileSpaceAdd({
	project,
	entry,
	fullPath,
	trigger,
	onClose,
}: {
	project: string;
	entry: DirectoryEntry;
	fullPath: string;
	trigger: HTMLElement;
	onClose: () => void;
}) {
	const l = useFileLabels();
	const client = useQueryClient();
	const query = useQuery({ queryKey: ["file-workspace"], queryFn: fileWorkspace.state, retry: false });
	const [space, setSpace] = useState("");
	const [name, setName] = useState(Array.from(entry.name).slice(0, 100).join(""));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const dialog = useRef<HTMLDialogElement>(null);
	useLayoutEffect(() => {
		const node = dialog.current!;
		node.showModal();
		return () => {
			node.close();
			trigger.isConnected && trigger.focus({ preventScroll: true });
		};
	}, [trigger]);
	const existing = query.data?.spaces.find((s) => s.id === space);
	const duplicate = existing && [...existing.roots, ...(existing.files ?? [])].includes(fullPath);
	return createPortal(
		<dialog
			ref={dialog}
			className="file-space-add"
			aria-label={l.addToSpace}
			onCancel={(e) => {
				e.preventDefault();
				e.stopPropagation();
				if (!busy) onClose();
			}}
			onKeyDown={(e) => e.stopPropagation()}
		>
			<form
				onSubmit={async (e) => {
					e.preventDefault();
					if (busy || duplicate || !query.data) return;
					setBusy(true);
					setError("");
					try {
						await fileWorkspace.addToSpace({
							id: space || crypto.randomUUID(),
							name: space ? undefined : name,
							root: project,
							path: entry.path,
						});
						await client.invalidateQueries({ queryKey: ["file-workspace"] });
						onClose();
					} catch (error) {
						setError(String(error));
						setBusy(false);
					}
				}}
			>
				<h2>{l.addToSpace}</h2>
				<p>{l.spaceReferenceHint}</p>
				<label>
					{l.spaceDestination}
					<select value={space} disabled={busy} onChange={(e) => setSpace(e.target.value)}>
						<option value="">{l.createSpace}</option>
						{query.data?.spaces.map((s) => (
							<option value={s.id} key={s.id}>
								{s.name}
							</option>
						))}
					</select>
				</label>
				{!space && (
					<label>
						{l.name}
						<input
							autoFocus
							required
							maxLength={100}
							value={name}
							disabled={busy}
							onChange={(e) => setName(e.target.value)}
						/>
					</label>
				)}
				<label>
					{l.elementPath}
					<input readOnly value={fullPath} />
				</label>
				{(error || query.error) && (
					<p role="alert" className="inline-error">
						{error || String(query.error)}
					</p>
				)}
				{duplicate && <p role="status">{l.alreadyAdded}</p>}
				<footer>
					<button type="button" className="quiet-button" disabled={busy} onClick={onClose}>
						{l.cancel}
					</button>
					<button
						type="submit"
						className="quiet-button"
						disabled={busy || !query.data || !!duplicate || (!space && !name.trim())}
					>
						{space ? l.add : l.createSpace}
					</button>
				</footer>
			</form>
		</dialog>,
		document.body,
	);
}
