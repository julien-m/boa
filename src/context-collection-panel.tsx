/** Explicit review surface; closing it leaves the collection available while browsing. */
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ArrowDown, ArrowUp, Check, Copy, Download, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useContextCollection } from "./context-collection";
import { collectionApi } from "./context-collection-api";
import { annotatedImage } from "./context-collection-images";
import { useCollectionLabels } from "./context-collection-labels";
import {
	type CollectionItem,
	collectionLimits,
	collectionPrompt,
	emptyCollection,
	hasUnconfirmedAnnotations,
	imageExportName,
	isAnnotationDraft,
} from "./context-collection-model";
import { ImageMarkers } from "./image-context";

export function CollectionPanel({ onClose }: { onClose: () => void }) {
	const c = useContextCollection()!;
	const l = useCollectionLabels();
	const { i18n } = useTranslation();
	const id = useId();
	const dialog = useRef<HTMLDialogElement>(null);
	const [notice, setNotice] = useState("");
	const [failure, setFailure] = useState("");
	const [busy, setBusy] = useState(false);
	const [clearing, setClearing] = useState(false);
	const prompt = collectionPrompt(c.draft, i18n.language.startsWith("en"));
	const images = c.draft.items.filter((item) => item.kind === "image");
	const unconfirmed = hasUnconfirmedAnnotations(c.draft);
	useEffect(() => {
		const focused = document.activeElement;
		const element = dialog.current;
		element?.showModal();
		return () => {
			if (element?.open) element.close();
			if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true });
		};
	}, []);
	const mutate = (operation: () => void) => {
		try {
			operation();
			setFailure("");
			setNotice("");
		} catch (reason) {
			setFailure(String(reason));
		}
	};
	const patch = (item: CollectionItem, update: (item: CollectionItem) => CollectionItem) =>
		mutate(() =>
			c.change((draft) => ({
				...draft,
				items: draft.items.flatMap((entry) => {
					if (entry.id !== item.id) return [entry];
					const next = update(entry);
					return next.kind === "image" && next.annotations.length === 0 ? [] : [next];
				}),
			})),
		);
	const move = (index: number, direction: number) =>
		mutate(() =>
			c.change((draft) => {
				const items = [...draft.items];
				[items[index], items[index + direction]] = [items[index + direction], items[index]];
				return { ...draft, items };
			}),
		);
	const copy = async () => {
		if (unconfirmed) {
			setFailure(l.unconfirmed);
			return;
		}
		setFailure("");
		try {
			await writeText(prompt);
			setNotice(l.copied);
		} catch (reason) {
			setFailure(`${l.copyFailed}: ${String(reason)}`);
		}
	};
	const exportAll = async () => {
		if (unconfirmed) {
			setFailure(l.unconfirmed);
			return;
		}
		setBusy(true);
		setFailure("");
		setNotice("");
		try {
			const attachments: { name: string; dataUrl: string }[] = [];
			let size = new TextEncoder().encode(prompt).length;
			for (let index = 0; index < c.draft.items.length; index++) {
				const item = c.draft.items[index];
				if (item.kind !== "image") continue;
				const dataUrl = await annotatedImage(item);
				size += dataUrl.length;
				if (size > collectionLimits.bytes) throw new Error(l.limit);
				attachments.push({ name: imageExportName(index), dataUrl });
			}
			const result = await collectionApi.export(prompt, attachments);
			if (result) setNotice(`${l.exported}: ${result.directory}`);
		} catch (reason) {
			setFailure(`${l.exportFailed}: ${String(reason)}`);
		} finally {
			setBusy(false);
		}
	};
	return createPortal(
		<dialog
			ref={dialog}
			className="collection-dialog"
			data-testid="collection-panel"
			aria-labelledby={`${id}-title`}
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) onClose();
			}}
		>
			<header className="collection-heading">
				<h2 id={`${id}-title`}>{l.title}</h2>
				<button type="button" className="icon-button" aria-label={l.close} disabled={busy} onClick={onClose}>
					<X size={18} />
				</button>
			</header>
			{!c.ready ? (
				<div className="collection-body">
					<p role={c.loadError ? "alert" : "status"}>
						{c.loadError ? `${l.loadFailed} ${c.error}` : l.loading}
					</p>
					{c.loadError && (
						<button type="button" onClick={c.retry}>
							{l.retry}
						</button>
					)}
				</div>
			) : (
				<>
					<div className="collection-body">
						<label className="collection-field" htmlFor={`${id}-instruction`}>
							{l.instruction}
							<textarea
								id={`${id}-instruction`}
								data-testid="collection-instruction"
								rows={3}
								maxLength={collectionLimits.message}
								disabled={busy}
								value={c.draft.instruction}
								onChange={(event) =>
									mutate(() =>
										c.change((draft) => ({ ...draft, active: true, instruction: event.target.value })),
									)
								}
							/>
						</label>
						<p className="muted collection-summary">
							{c.draft.items.length} {l.elements} · {images.length} {l.images} ·{" "}
							{prompt.length.toLocaleString(i18n.language)} {l.bytes}
						</p>
						{!c.draft.items.length && <p>{l.empty}</p>}
						<ol className="collection-items">
							{c.draft.items.map((item, index) => (
								<li key={item.id} className="collection-item" data-testid="collection-item">
									<header className="collection-item-heading">
										<div className="collection-source">
											<strong>{item.kind === "text" ? item.context.path : item.path}</strong>
											<small>{item.kind === "text" ? item.context.project : item.project}</small>
										</div>
										<div className="collection-actions">
											<button
												type="button"
												className="icon-button"
												disabled={busy || index === 0}
												aria-label={`${l.up} ${index + 1}`}
												onClick={() => move(index, -1)}
											>
												<ArrowUp size={14} />
											</button>
											<button
												type="button"
												className="icon-button"
												disabled={busy || index === c.draft.items.length - 1}
												aria-label={`${l.down} ${index + 1}`}
												onClick={() => move(index, 1)}
											>
												<ArrowDown size={14} />
											</button>
											<button
												type="button"
												className="icon-button"
												disabled={busy}
												aria-label={`${l.remove} ${index + 1}`}
												onClick={() =>
													mutate(() =>
														c.change((draft) => ({
															...draft,
															items: draft.items.filter((entry) => entry.id !== item.id),
														})),
													)
												}
											>
												<Trash2 size={14} />
											</button>
										</div>
									</header>
									{item.kind === "text" ? (
										<>
											<small>
												{item.wholeFile ? l.reference : l.excerpt}
												{!item.wholeFile && item.context.startLine !== null
													? ` · L${item.context.startLine}–${item.context.endLine}`
													: ""}{" "}
												· {item.context.label}
											</small>
											{!item.wholeFile && item.context.code && (
												<pre className="collection-excerpt">{item.context.code}</pre>
											)}
											<label className="collection-field" htmlFor={`${id}-${item.id}`}>
												{l.comment}
												<textarea
													id={`${id}-${item.id}`}
													rows={2}
													maxLength={collectionLimits.message}
													disabled={busy}
													value={item.message}
													onChange={(event) =>
														patch(item, (entry) =>
															entry.kind === "text" ? { ...entry, message: event.target.value } : entry,
														)
													}
												/>
											</label>
										</>
									) : (
										<>
											<div className="collection-snapshot">
												<img
													src={item.dataUrl}
													alt={`${l.snapshot}: ${item.path}`}
													onError={(event) => {
														event.currentTarget.alt = `${l.snapshotFailed}: ${item.path}`;
													}}
												/>
												<ImageMarkers annotations={item.annotations} />
											</div>
											<small>
												{item.width} × {item.height} px · {imageExportName(index)}
											</small>
											<ol className="collection-annotations">
												{item.annotations.map((annotation, n) => (
													<li key={annotation.id}>
														<label className="collection-field" htmlFor={`${id}-${annotation.id}`}>
															{`${l.annotation} ${n + 1}`}
															{annotation.point
																? ` · ${Math.round(annotation.point.x * 100)}%, ${Math.round(annotation.point.y * 100)}%`
																: ` · ${l.wholeImage}`}
															<textarea
																id={`${id}-${annotation.id}`}
																rows={2}
																maxLength={collectionLimits.message}
																disabled={busy}
																value={annotation.message}
																onChange={(event) =>
																	patch(item, (entry) =>
																		entry.kind === "image"
																			? {
																					...entry,
																					annotations: entry.annotations.map((a) =>
																						a.id === annotation.id
																							? { ...a, message: event.target.value, confirmed: false }
																							: a,
																					),
																				}
																			: entry,
																	)
																}
															/>
														</label>
														{isAnnotationDraft(annotation) && (
															<button
																type="button"
																className="icon-button"
																aria-label={`${l.done} ${n + 1}`}
																disabled={busy || !annotation.message.trim()}
																onClick={() =>
																	patch(item, (entry) =>
																		entry.kind === "image"
																			? {
																					...entry,
																					annotations: entry.annotations.map((a) =>
																						a.id === annotation.id
																							? { ...a, message: a.message.trim(), confirmed: true }
																							: a,
																					),
																				}
																			: entry,
																	)
																}
															>
																<Check size={15} />
															</button>
														)}
														<button
															type="button"
															className="icon-button"
															disabled={busy}
															aria-label={`${l.removeAnnotation} ${n + 1}`}
															onClick={() =>
																patch(item, (entry) =>
																	entry.kind === "image"
																		? {
																				...entry,
																				annotations: entry.annotations.filter((a) => a.id !== annotation.id),
																			}
																		: entry,
																)
															}
														>
															<Trash2 size={14} />
														</button>
													</li>
												))}
											</ol>
										</>
									)}
								</li>
							))}
						</ol>
						{c.draft.items.length > 0 && (
							<details>
								<summary>{l.preview}</summary>
								<pre className="collection-excerpt" data-testid="collection-prompt">
									{prompt}
								</pre>
							</details>
						)}
					</div>
					<footer className="collection-footer">
						<p className="muted" role="status">
							{c.saving ? l.saving : c.error ? l.unsaved : l.saved}
						</p>
						{c.error && (
							<div className="collection-error">
								<p role="alert">{c.error}</p>
								<button type="button" onClick={c.retry}>
									{l.retry}
								</button>
							</div>
						)}
						{unconfirmed && (
							<p role="status" data-testid="collection-drafts-hint">
								{l.unconfirmed}
							</p>
						)}
						{failure && (
							<p role="alert" className="collection-error">
								{failure}
							</p>
						)}
						{notice && (
							<p role="status" className="collection-notice" data-testid="collection-notice">
								{notice}
							</p>
						)}
						{clearing ? (
							<div className="collection-actions">
								<span>{l.confirmClear}</span>
								<button
									type="button"
									data-testid="collection-clear-cancel"
									onClick={() => setClearing(false)}
								>
									{l.cancel}
								</button>
								<button
									type="button"
									className="collection-clear-confirm"
									data-testid="collection-clear-confirm"
									onClick={() =>
										mutate(() => {
											c.change(emptyCollection);
											setClearing(false);
										})
									}
								>
									{l.confirm}
								</button>
							</div>
						) : (
							<div className="collection-actions">
								<button
									type="button"
									className="quiet-button"
									disabled={busy || (!c.draft.active && !c.draft.items.length && !c.draft.instruction)}
									data-testid="collection-clear"
									onClick={() => setClearing(true)}
								>
									{l.clear}
								</button>
								{!c.draft.active && !c.draft.items.length && (
									<button
										type="button"
										onClick={() =>
											mutate(() => {
												c.change((draft) => ({ ...draft, active: true }));
												onClose();
											})
										}
									>
										{l.start}
									</button>
								)}
								<button
									type="button"
									data-testid="collection-export"
									disabled={busy || !c.draft.items.length || unconfirmed}
									onClick={() => void exportAll()}
								>
									<Download size={14} />
									{busy ? l.exporting : l.export}
								</button>
								<button
									type="button"
									className="primary-button"
									data-testid="collection-copy"
									disabled={busy || !c.draft.items.length || unconfirmed}
									onClick={() => void copy()}
								>
									<Copy size={14} />
									{l.copy}
								</button>
							</div>
						)}
					</footer>
				</>
			)}
		</dialog>,
		document.body,
	);
}
