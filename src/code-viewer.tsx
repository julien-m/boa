/** Local Monaco reader and diff viewer with portable AI context export. */
import { DiffEditor, Editor, loader } from "@monaco-editor/react";
import { useQuery } from "@tanstack/react-query";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
	ArrowDown,
	ArrowUp,
	BookmarkPlus,
	Copy,
	FileCode2,
	PanelLeftClose,
	SplitSquareHorizontal,
} from "lucide-react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import { useTranslation } from "react-i18next";
import "monaco-editor/basic-languages/monaco.contribution.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import { contextApi } from "./context-api";
import { type CodeContext, ContextBubbles } from "./context-bubbles";
import { FileAssetPreview } from "./file-asset-preview";
import { useFileEditing } from "./file-editing";
import { localMarkdownLink } from "./markdown-links";
import { type MarkdownBookmark, MarkdownPreview } from "./markdown-preview";
import type { Preview, Selection } from "./models";
import { ReaderNavigation } from "./reader-navigation";
import { relocateLine } from "./reading-position";
import "./syntax-highlighting";
import "monaco-editor/editor/contrib/find/browser/findController.js";

// Local worker and local language grammars keep all code on the Mac and work offline.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
const navigationRequests = new WeakMap<monaco.editor.ITextModel, string>();
const readerViewStates = new WeakMap<monaco.editor.ITextModel, monaco.editor.ICodeEditorViewState>();
const readerCaptures = new Map<HTMLElement, () => Selection | null>();
export function captureCurrentReaderSelection(): Selection | null {
	const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".code-viewer");
	const root =
		focused ?? [...readerCaptures.keys()].find((element) => element.getBoundingClientRect().height > 0);
	return root ? (readerCaptures.get(root)?.() ?? null) : null;
}
export function captureReaderSelection(selection: Selection): Selection {
	const root = [...document.querySelectorAll<HTMLElement>(".code-viewer")].find(
		(element) =>
			element.dataset.readerProject === selection.project && element.dataset.readerPath === selection.path,
	);
	const container = root?.querySelector<HTMLElement>('[data-testid="markdown-preview"]');
	if (container) {
		const top = container.getBoundingClientRect().top;
		const block = [...container.querySelectorAll<HTMLElement>("[data-source-line]")].find(
			(element) => element.getBoundingClientRect().bottom > top,
		);
		if (block)
			return {
				...selection,
				receiptId: undefined,
				contextRef: undefined,
				line: undefined,
				endLine: undefined,
				anchor: undefined,
				restorePosition: undefined,
				navigationId: crypto.randomUUID(),
				markdownRestore: {
					text: block.textContent ?? "",
					tag: block.tagName,
					offset: block.getBoundingClientRect().top - top,
					scrollTop: container.scrollTop,
				},
			};
	}
	const model = monaco.editor.getModel(monaco.Uri.parse(readerModelPath(selection.project, selection.path)));
	const editor = monaco.editor.getEditors().find((item) => item.getModel() === model);
	const position = editor?.getPosition();
	return {
		...selection,
		receiptId: undefined,
		contextRef: undefined,
		line: undefined,
		endLine: undefined,
		anchor: undefined,
		navigationId: crypto.randomUUID(),
		restorePosition:
			editor && position
				? {
						line: position.lineNumber,
						column: position.column,
						scrollTop: editor.getScrollTop(),
						scrollLeft: editor.getScrollLeft(),
					}
				: undefined,
	};
}
export const readerModelPath = (project: string, path: string): string =>
	monaco.Uri.from({ scheme: "boa-file", path: `${project}/${path}` }).toString();
export function disposeReaderModel(project: string, path: string): void {
	const model = monaco.editor.getModel(monaco.Uri.parse(readerModelPath(project, path)));
	if (model && !monaco.editor.getEditors().some((editor) => editor.getModel() === model)) model.dispose();
}
const options: monaco.editor.IStandaloneEditorConstructionOptions = {
	readOnly: true,
	domReadOnly: true,
	minimap: { enabled: false },
	fontSize: 13,
	lineHeight: 21,
	scrollBeyondLastLine: false,
	automaticLayout: true,
	padding: { top: 16 },
	renderLineHighlight: "none",
	wordWrap: "on",
	fontFamily: "SF Mono, Menlo, monospace",
};

function language(path: string): string {
	const extension = path.split(".").pop()?.toLowerCase() ?? "";
	return (
		(
			{
				ts: "typescript",
				tsx: "typescript",
				js: "javascript",
				mjs: "javascript",
				jsx: "javascript",
				py: "python",
				rs: "rust",
				md: "markdown",
				json: "json",
				jsonc: "json",
				xml: "xml",
				xsd: "xml",
				xsl: "xml",
				xslt: "xml",
				svg: "xml",
				css: "css",
				html: "html",
				toml: "toml",
				yaml: "yaml",
				yml: "yaml",
				sh: "shell",
				swift: "swift",
				go: "go",
				sql: "sql",
			} as Record<string, string>
		)[extension] ?? "plaintext"
	);
}

interface CodeViewerProps {
	selection: Selection | null;
	compact?: boolean;
	onOpen?: (selection: Selection) => void;
}
export function CodeViewer({ selection, compact = false, onOpen }: CodeViewerProps) {
	const { t, i18n } = useTranslation("workspace");
	const editing = useFileEditing();
	const draft = selection && !selection.repo ? editing.draft(selection.project, selection.path) : undefined;
	const [discard, setDiscard] = useState(false);
	useEffect(() => setDiscard(false), [selection?.project, selection?.path]);
	const [sideBySide, setSideBySide] = useState(false);
	const [notice, setNotice] = useState<{ key: string; error?: string } | null>(null);
	const [markdownMode, setMarkdownMode] = useState<{ key: string; source: boolean } | null>(null);
	useLayoutEffect(() => setMarkdownMode(null), [selection]);
	const fileKey = selection
		? `${selection.project}/${selection.path}:${selection.navigationId ?? selection.line ?? ""}`
		: "";
	const isMarkdown = Boolean(selection && !selection.repo && /\.(md|markdown)$/i.test(selection.path));

	const markdownBookmark = useRef<{ key: string; position: MarkdownBookmark; line: number } | null>(null);
	const rememberMarkdown = (): void => {
		const container = document.querySelector<HTMLElement>('[data-testid="markdown-preview"]');
		if (!showMarkdown || !container) return;
		const top = container.getBoundingClientRect().top;
		const visible = [...container.querySelectorAll<HTMLElement>("[data-source-line]")].find(
			(block) => block.getBoundingClientRect().bottom > top,
		);
		if (visible)
			markdownBookmark.current = {
				key: fileKey,
				line: Number(visible.dataset.sourceLine) || 1,
				position: {
					text: visible.textContent ?? "",
					tag: visible.tagName,
					offset: visible.getBoundingClientRect().top - top,
					scrollTop: container.scrollTop,
				},
			};
	};
	const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
	const [readerEditor, setReaderEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
	const completedReceipt = useRef<string | null>(null);
	const fr = i18n.language.startsWith("fr");
	const sideRef = useRef("file");
	const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
	const findOnMount = useRef(false);
	const viewerElement = useRef<HTMLElement>(null);
	const [selectionVersion, setSelectionVersion] = useState(0);
	useLayoutEffect(() => {
		const root = viewerElement.current;
		if (!root || !selection) return;
		readerCaptures.set(root, () => captureReaderSelection(selection));
		return () => {
			readerCaptures.delete(root);
		};
	}, [selection]);
	void selectionVersion;
	const query = useQuery({
		queryKey: ["preview", selection],
		queryFn: () => {
			if (!selection) throw new Error(t("viewer.noFile"));
			return api.preview(selection);
		},
		enabled: Boolean(selection),
		staleTime: 0,
		refetchOnWindowFocus: false,
	});
	const sourceRequested =
		markdownMode?.key === fileKey ? markdownMode.source : Boolean(selection?.receiptId && selection.line);
	const svgSource =
		query.data?.kind === "image" && /\.svg$/i.test(selection?.path ?? "") && Boolean(query.data.modified);
	const nonText =
		!draft &&
		(query.data?.kind === "unsupported" || (query.data?.kind === "image" && !(svgSource && sourceRequested)));
	const showMarkdown = isMarkdown && !draft && !nonText && !sourceRequested;
	const capture = (): CodeContext | null => {
		if (!selection || !query.data) return null;
		const editor = showMarkdown || nonText ? null : editorRef.current;
		const range = editor?.getSelection();
		const selected = range && !range.isEmpty();
		const renderedSelection = showMarkdown ? window.getSelection() : null;
		const previewElement = document.querySelector('[data-testid="markdown-preview"]');
		const renderedText =
			renderedSelection?.anchorNode &&
			renderedSelection.focusNode &&
			previewElement?.contains(renderedSelection.anchorNode) &&
			previewElement.contains(renderedSelection.focusNode)
				? renderedSelection.toString()
				: "";
		return {
			project: selection.project,
			path: selection.absolutePath ?? `${selection.repo ?? selection.project}/${selection.path}`,
			startLine: selected ? range.startLineNumber : null,
			endLine: selected ? range.endLineNumber : null,
			code: selected ? (editor?.getModel()?.getValueInRange(range) ?? "") : renderedText,
			label: `${query.data.label} · ${showMarkdown ? t("viewer.markdown") : t(`viewer.${sideRef.current}`)}`,
		};
	};
	useEffect(() => {
		if (!showMarkdown) return;
		const update = (): void => setSelectionVersion((version) => version + 1);
		document.addEventListener("selectionchange", update);
		return () => document.removeEventListener("selectionchange", update);
	}, [showMarkdown]);
	useEffect(() => {
		if (!selection?.receiptId || completedReceipt.current === selection.receiptId) return;
		const id = selection.receiptId;
		if (query.error || draft || nonText || selection.anchorStatus === "needs-review") {
			completedReceipt.current = id;
			void contextApi
				.acknowledge(id, query.error ? "missing" : draft ? "paused" : "needs-review")
				.catch(() => {});
		}
	}, [selection, query.error, draft, nonText]);
	const bookmark = async () => {
		if (!selection || selection.repo || !query.data) return;
		const range = editorRef.current?.getSelection();
		const first = range?.startLineNumber ?? 1;
		const last = range?.endLineNumber ?? first;
		const text = query.data.modified
			.split("\n")
			.slice(first - 1, last)
			.join("\n");
		const title = window.prompt(fr ? "Nom du repère" : "Bookmark name", `${selection.path}:${first}`);
		if (!title?.trim()) return;
		try {
			const views = await contextApi.list(selection.project);
			const id = "bookmarks";
			const existing = views.find((view) => view.id === id);
			const stepId = crypto.randomUUID();
			const view = await contextApi.save(
				{
					id,
					project: selection.project,
					title: existing?.title ?? (fr ? "Repères" : "Bookmarks"),
					description: existing?.description ?? "",
					kind: existing?.kind ?? "walkthrough",
					steps: [
						...(existing?.steps ?? []),
						{
							id: stepId,
							title: title.trim(),
							description: "",
							passages: [
								{ id: crypto.randomUUID(), path: selection.path, startLine: first, endLine: last, text },
							],
						},
					],
				},
				existing?.revision ?? 0,
			);
			window.dispatchEvent(
				new CustomEvent("boa:bookmark-saved", { detail: { project: selection.project, viewId: view.id } }),
			);
		} catch (error) {
			setNotice({ key: "viewer.rawError", error: String(error) });
		}
	};

	const hasSelection = Boolean(
		!showMarkdown &&
			!nonText &&
			editorRef.current?.getSelection() &&
			!editorRef.current.getSelection()?.isEmpty(),
	);
	const handleCopy = async (full = false): Promise<void> => {
		if (!selection || !query.data) return;
		const editor = showMarkdown || nonText ? null : editorRef.current;
		const selected = editor?.getSelection();
		if (!full && (!selected || selected.isEmpty())) {
			setNotice({ key: "viewer.selectLines" });
			return;
		}
		const excerpt =
			!full && selected && !selected.isEmpty()
				? editor?.getModel()?.getValueInRange(selected)
				: (editor?.getModel()?.getValue() ?? query.data.modified);
		const location =
			!full && selected && !selected.isEmpty()
				? `:${selected.startLineNumber}-${selected.endLineNumber}`
				: "";
		const context = t("viewer.copyContext", {
			project: selection.project,
			path: selection.absolutePath ?? `${selection.repo ?? selection.project}/${selection.path}`,
			location,
			label: query.data.label,
			side: t(`viewer.${sideRef.current}`),
			excerpt: excerpt ?? "",
		});
		try {
			await writeText(context);
			setNotice({ key: "viewer.copied" });
		} catch (error) {
			setNotice({ key: "viewer.copyFailed", error: String(error) });
		}
	};
	if (!selection)
		return (
			<section ref={viewerElement} className="code-viewer empty-view" data-testid="preview-empty">
				<FileCode2 size={32} strokeWidth={1} />
				<h2>{t("viewer.emptyTitle")}</h2>
				<p>{t("viewer.emptyDescription")}</p>
				<span>{t("viewer.readOnly")}</span>
			</section>
		);
	return (
		<section
			ref={viewerElement}
			tabIndex={0}
			data-reader-project={selection.project}
			data-reader-path={selection.path}
			className={`code-viewer ${compact ? "compact" : ""}`}
			data-testid="code-viewer"
		>
			{!nonText && (
				<ReaderNavigation
					key={`${selection.project}/${selection.path}`}
					editor={showMarkdown ? null : readerEditor}
					root={viewerElement}
					readOnly={!draft}
					onSource={() => {
						if (showMarkdown) {
							rememberMarkdown();
							setMarkdownMode({ key: fileKey, source: true });
						}
					}}
				/>
			)}
			<div className="editor-toolbar">
				<span className="editor-tab">
					<FileCode2 size={14} />
					{selection.path.split("/").pop()}
				</span>
				<div className="toolbar-actions">
					{!selection.repo && (
						<button
							type="button"
							className="quiet-button"
							data-testid="create-bookmark"
							disabled={!query.data || Boolean(draft) || nonText}
							onClick={() => void bookmark()}
						>
							<BookmarkPlus size={14} />
							{fr ? "Repère" : "Bookmark"}
						</button>
					)}
					{(isMarkdown || svgSource) && !draft && (
						<button
							type="button"
							className="quiet-button"
							data-testid="markdown-toggle"
							onClick={() => setMarkdownMode({ key: fileKey, source: showMarkdown || nonText })}
						>
							{showMarkdown || nonText ? t("viewer.source") : t("viewer.preview")}
						</button>
					)}
					<ContextBubbles capture={capture} context={capture()} />
					{selection.repo && (
						<>
							<button
								type="button"
								className="icon-button"
								data-testid="diff-previous"
								data-hint={t("viewer.previous")}
								aria-label={t("viewer.previous")}
								disabled={!query.data || query.isFetching}
								onClick={() => diffRef.current?.goToDiff("previous")}
							>
								<ArrowUp size={15} />
							</button>
							<button
								type="button"
								className="icon-button"
								data-testid="diff-next"
								data-hint={t("viewer.next")}
								aria-label={t("viewer.next")}
								disabled={!query.data || query.isFetching}
								onClick={() => diffRef.current?.goToDiff("next")}
							>
								<ArrowDown size={15} />
							</button>
						</>
					)}
					{selection.repo && (
						<button
							type="button"
							className="icon-button"
							data-testid="diff-layout"
							onClick={() => setSideBySide(!sideBySide)}
							data-hint={sideBySide ? t("viewer.inlineDiff") : t("viewer.sideBySideDiff")}
							aria-label={sideBySide ? t("viewer.inlineDiff") : t("viewer.sideBySideDiff")}
						>
							{sideBySide ? <PanelLeftClose size={15} /> : <SplitSquareHorizontal size={15} />}
						</button>
					)}
					<button
						type="button"
						className="quiet-button"
						data-testid="copy-ai-context"
						onClick={() => {
							void handleCopy();
						}}
						disabled={!query.data || nonText || !hasSelection}
					>
						<Copy size={13} />
						{t("viewer.copySelection")}
					</button>
					<button
						type="button"
						className="quiet-button"
						data-testid="copy-whole-file"
						disabled={!query.data || nonText}
						onClick={() => {
							void handleCopy(true);
						}}
					>
						{t("viewer.copyFile")}
					</button>
				</div>
			</div>
			<div className="breadcrumb" title={selection.path}>
				<span className="breadcrumb-path">{selection.path}</span>
				{!showMarkdown && !nonText && (
					<span data-testid="reader-position">Ln {editorRef.current?.getPosition()?.lineNumber ?? 1}</span>
				)}
				{selection.repo || nonText ? (
					<span>{query.data?.label}</span>
				) : (
					<div className="editing-controls">
						{draft && (
							<>
								{draft.content !== draft.original && <span data-testid="edit-dirty">•</span>}
								<button
									type="button"
									disabled={draft.saving}
									data-hint={t("edit.undo")}
									aria-label={t("edit.undo")}
									onClick={() => editorRef.current?.trigger("boa", "undo", null)}
								>
									↶
								</button>
								<button
									type="button"
									disabled={draft.saving}
									data-hint={t("edit.redo")}
									aria-label={t("edit.redo")}
									onClick={() => editorRef.current?.trigger("boa", "redo", null)}
								>
									↷
								</button>
								<button
									type="button"
									data-testid="edit-cancel"
									disabled={draft.saving}
									onClick={() => {
										if (draft.content !== draft.original) setDiscard(true);
										else editing.cancel(selection.project, selection.path);
									}}
								>
									{t("edit.cancel")}
								</button>
								<button
									type="button"
									data-testid="edit-save"
									disabled={draft.saving || draft.content === draft.original}
									onClick={() => {
										setDiscard(false);
										void editing.save(selection.project, selection.path);
									}}
								>
									{t("edit.save")}
								</button>
							</>
						)}
						<button
							type="button"
							data-testid="read-only-toggle"
							aria-pressed={Boolean(draft)}
							disabled={!query.data || draft?.saving}
							onClick={() => {
								if (draft) {
									if (draft.content !== draft.original) setDiscard(true);
									else editing.cancel(selection.project, selection.path);
								} else if (query.data) {
									setDiscard(false);
									rememberMarkdown();
									editing.start(selection.project, selection.path, query.data.modified);
								}
							}}
						>
							{draft ? t("edit.title") : t("edit.readOnly")}
						</button>
					</div>
				)}
			</div>
			{draft && discard && (
				<div className="inline-edit-notice" role="alert">
					<span>{t("edit.discard")}</span>
					<button type="button" disabled={draft.saving} onClick={() => setDiscard(false)}>
						{t("edit.keep")}
					</button>
					<button
						type="button"
						data-testid="edit-discard"
						disabled={draft.saving}
						onClick={() => {
							setDiscard(false);
							editing.cancel(selection.project, selection.path);
						}}
					>
						{t("edit.confirm")}
					</button>
				</div>
			)}
			{draft && query.data && query.data.modified !== draft.original && !draft.saving && (
				<p className="inline-error" role="alert">
					{t("edit.externalChange")}
				</p>
			)}
			{draft?.error && (
				<p className="inline-error" role="alert">
					{draft.error}
				</p>
			)}
			{notice && (
				<button
					type="button"
					className="copy-notice"
					data-testid="copy-notice"
					onClick={() => setNotice(null)}
				>
					{t(notice.key, { error: notice.error })} ×
				</button>
			)}
			{query.isFetching && !query.data ? (
				<div className="empty-view" data-testid="preview-loading">
					{t("viewer.loading")}
				</div>
			) : query.error && !draft ? (
				<div className="empty-view error" data-testid="preview-error">
					{String(query.error)}
				</div>
			) : (
				query.data &&
				(nonText ? (
					<FileAssetPreview
						key={`${selection.project}/${selection.path}`}
						preview={query.data}
						selection={selection}
					/>
				) : showMarkdown ? (
					<MarkdownPreview
						key={`${selection.project}/${selection.path}`}
						project={selection.project}
						path={selection.path}
						content={query.data.modified}
						navigation={selection.line || selection.anchor !== undefined ? selection : undefined}
						restorePosition={
							selection.markdownRestore ??
							(markdownBookmark.current?.key === fileKey ? markdownBookmark.current.position : undefined)
						}
						onOpenLink={(href) => {
							void (async () => {
								const document =
									selection.absolutePath ?? `${selection.repo ?? selection.project}/${selection.path}`;
								const link = localMarkdownLink(href, document);
								if (!link) {
									await writeText(href);
									setNotice({ key: "viewer.linkCopied" });
									return;
								}
								const inside = !selection.absolutePath && link.file.startsWith(`${selection.project}/`);
								const target = inside
									? { project: selection.project, path: link.file.slice(selection.project.length + 1) }
									: await api.navigate(link.file);
								const next = { ...target, anchor: link.anchor, navigationId: crypto.randomUUID() };
								if (onOpen) onOpen(next);
								else window.dispatchEvent(new CustomEvent("boa:open-file", { detail: next }));
							})().catch((error: unknown) => setNotice({ key: "viewer.rawError", error: String(error) }));
						}}
						onCopyLink={(href) => {
							void writeText(href).then(
								() => setNotice({ key: "viewer.linkCopied" }),
								(error: unknown) => setNotice({ key: "viewer.rawError", error: String(error) }),
							);
						}}
					/>
				) : (
					<MonacoContent
						key={JSON.stringify(selection)}
						preview={draft ? { ...query.data, modified: draft.content } : query.data}
						modelPath={readerModelPath(selection.project, selection.path)}
						editable={Boolean(draft) && !draft?.saving}
						onChange={(value) => {
							if (draft && !draft.saving) editing.change(selection.project, selection.path, value);
						}}
						onSave={() => {
							if (draft) {
								setDiscard(false);
								void editing.save(selection.project, selection.path);
							}
						}}
						onDiffEditor={(editor) => {
							diffRef.current = editor;
						}}
						diff={Boolean(selection.repo)}
						sideBySide={sideBySide}
						onEditor={(editor, side, navigate) => {
							editorRef.current = editor;
							setReaderEditor(editor);
							if (findOnMount.current && navigate) {
								findOnMount.current = false;
								editor.trigger("boa", "actions.find", null);
							}
							sideRef.current = side;
							setSelectionVersion((version) => version + 1);
							if (navigate && selection.restorePosition) {
								const position = selection.restorePosition;
								editor.setPosition({ lineNumber: position.line, column: position.column });
								editor.setScrollPosition({ scrollTop: position.scrollTop, scrollLeft: position.scrollLeft });
							} else if (navigate && draft && markdownBookmark.current?.key === fileKey) {
								editor.revealLineNearTop(markdownBookmark.current.line);
							} else if (
								selection.line &&
								selection.anchorStatus !== "needs-review" &&
								navigate &&
								editor.getModel() &&
								navigationRequests.get(editor.getModel() as monaco.editor.ITextModel) !==
									(selection.navigationId ?? `${selection.line}:${selection.endLine}`)
							) {
								navigationRequests.set(
									editor.getModel() as monaco.editor.ITextModel,
									selection.navigationId ?? `${selection.line}:${selection.endLine}`,
								);
								const line = Math.min(selection.line, editor.getModel()?.getLineCount() ?? 1);
								editor.setSelection(
									new monaco.Range(
										line,
										1,
										Math.min(selection.endLine ?? line, editor.getModel()?.getLineCount() ?? line),
										10000,
									),
								);
								editor.revealLineInCenter(line);
							}
							if (navigate && selection.receiptId && !draft && selection.anchorStatus !== "needs-review") {
								const id = selection.receiptId;
								requestAnimationFrame(() => {
									if (completedReceipt.current === id || !editor.getDomNode()?.isConnected) return;
									const range = editor.getSelection();
									const visible = editor
										.getVisibleRanges()
										.some(
											(r) =>
												r.startLineNumber <= (selection.line ?? 1) &&
												r.endLineNumber >= (selection.line ?? 1),
										);
									const size = editor.getDomNode()?.getBoundingClientRect();
									const exact =
										range &&
										range.startLineNumber === selection.line &&
										range.endLineNumber === selection.endLine &&
										Boolean(size?.width && size.height) &&
										visible;
									completedReceipt.current = id;
									void contextApi.acknowledge(id, exact ? "displayed" : "needs-review").catch(() => {});
								});
							}
						}}
					/>
				))
			)}
		</section>
	);
}

function MonacoContent({
	preview,
	modelPath,
	editable = false,
	onChange,
	onSave,
	diff,
	sideBySide,
	onEditor,
	onDiffEditor,
}: {
	onDiffEditor: (editor: monaco.editor.IStandaloneDiffEditor | null) => void;
	preview: Preview;
	modelPath: string;
	editable?: boolean;
	onChange: (value: string) => void;
	onSave: () => void;
	diff: boolean;
	sideBySide: boolean;
	onEditor: (editor: monaco.editor.IStandaloneCodeEditor, side: string, navigate: boolean) => void;
}) {
	const { t } = useTranslation("workspace");
	const reader = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
	useLayoutEffect(
		() => () => {
			const editor = reader.current;
			const model = editor?.getModel();
			const state = editor?.saveViewState();
			if (model && state) readerViewStates.set(model, state);
		},
		[],
	);
	const save = useRef(onSave);
	save.current = onSave;
	const synchronize = (): void => {
		const editor = reader.current;
		const model = editor?.getModel();
		if (!editor || !model || diff || model.getValue() === preview.modified) return;
		editor.layout();
		const previous = model.getValue();
		const visible = editor.getVisibleRanges()[0]?.startLineNumber ?? 1;
		const offset = editor.getScrollTop() - editor.getTopForLineNumber(visible);
		const state = editor.saveViewState();
		const cursor = editor.getPosition();
		model.setValue(preview.modified);
		if (state) editor.restoreViewState(state);
		if (cursor)
			editor.setPosition({
				lineNumber: relocateLine(previous, preview.modified, cursor.lineNumber),
				column: cursor.column,
			});
		editor.setScrollTop(
			editor.getTopForLineNumber(relocateLine(previous, preview.modified, visible)) + offset,
			monaco.editor.ScrollType.Immediate,
		);
	};
	const sync = useRef(synchronize);
	sync.current = synchronize;
	useLayoutEffect(() => {
		sync.current();
	}, [preview.modified, diff]);
	return (
		<div className="monaco-container">
			{diff ? (
				<DiffEditor
					theme="vs-dark"
					keepCurrentOriginalModel
					keepCurrentModifiedModel
					original={preview.original}
					modified={preview.modified}
					language={language(preview.path)}
					options={{
						...options,
						renderSideBySide: sideBySide,
						originalEditable: false,
						originalAriaLabel: t("viewer.originalCode"),
						modifiedAriaLabel: t("viewer.modifiedCode"),
						enableSplitViewResizing: true,
					}}
					onMount={(editor) => {
						onDiffEditor(editor);
						const models = editor.getModel();
						editor.onDidDispose(() => {
							onDiffEditor(null);
							queueMicrotask(() => {
								models?.original.dispose();
								models?.modified.dispose();
							});
						});
						const original = editor.getOriginalEditor();
						const modified = editor.getModifiedEditor();
						original.onDidFocusEditorText(() => onEditor(original, "before", false));
						original.onDidChangeCursorSelection(() => onEditor(original, "before", false));
						modified.onDidFocusEditorText(() => onEditor(modified, "after", false));
						modified.onDidChangeCursorSelection(() => onEditor(modified, "after", false));
						onEditor(modified, "after", true);
					}}
				/>
			) : (
				<Editor
					path={modelPath}
					keepCurrentModel
					saveViewState={false}
					theme="vs-dark"
					defaultValue={preview.modified}
					language={language(preview.path)}
					options={{ ...options, readOnly: !editable, domReadOnly: !editable }}
					onChange={(value) => {
						if (editable) onChange(value ?? "");
					}}
					onMount={(editor) => {
						reader.current = editor;
						editor.layout();
						const model = editor.getModel();
						const state = model ? readerViewStates.get(model) : undefined;
						if (state) editor.restoreViewState(state);
						sync.current();
						editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save.current());
						editor.onDidChangeCursorSelection(() => onEditor(editor, "file", false));
						onEditor(editor, "file", true);
					}}
				/>
			)}
		</div>
	);
}
