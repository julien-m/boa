/** Local Monaco reader and diff viewer with portable AI context export. */
import { DiffEditor, Editor, loader } from "@monaco-editor/react";
import { useQuery } from "@tanstack/react-query";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ArrowDown, ArrowUp, Copy, FileCode2, PanelLeftClose, SplitSquareHorizontal } from "lucide-react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import { useTranslation } from "react-i18next";
import "monaco-editor/basic-languages/monaco.contribution.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import { type CodeContext, ContextBubbles } from "./context-bubbles";
import { useFileEditing } from "./file-editing";
import { type MarkdownBookmark, MarkdownPreview } from "./markdown-preview";
import type { Preview, Selection } from "./models";
import { relocateLine } from "./reading-position";
import "./syntax-highlighting";
import "monaco-editor/editor/contrib/find/browser/findController.js";

// Local worker and local language grammars keep all code on the Mac and work offline.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
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
}
export function CodeViewer({ selection, compact = false }: CodeViewerProps) {
	const { t } = useTranslation("workspace");
	const editing = useFileEditing();
	const draft = selection && !selection.repo ? editing.draft(selection.project, selection.path) : undefined;
	const [discard, setDiscard] = useState(false);
	useEffect(() => setDiscard(false), [selection?.project, selection?.path]);
	const [sideBySide, setSideBySide] = useState(false);
	const [notice, setNotice] = useState<{ key: string; error?: string } | null>(null);
	const [markdownMode, setMarkdownMode] = useState<{ key: string; source: boolean } | null>(null);
	const fileKey = selection
		? `${selection.project}/${selection.path}:${selection.navigationId ?? selection.line ?? ""}`
		: "";
	const isMarkdown = Boolean(selection && !selection.repo && /\.(md|markdown)$/i.test(selection.path));
	const showMarkdown =
		isMarkdown && !draft && (markdownMode?.key === fileKey ? !markdownMode.source : !selection?.line);
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
	const sideRef = useRef("file");
	const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
	const findOnMount = useRef(false);
	const [selectionVersion, setSelectionVersion] = useState(0);
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
	const capture = (): CodeContext | null => {
		if (!selection || !query.data) return null;
		const editor = showMarkdown ? null : editorRef.current;
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
			path: `${selection.repo ?? selection.project}/${selection.path}`,
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

	const hasSelection = Boolean(
		!showMarkdown && editorRef.current?.getSelection() && !editorRef.current.getSelection()?.isEmpty(),
	);
	const handleCopy = async (full = false): Promise<void> => {
		if (!selection || !query.data) return;
		const editor = showMarkdown ? null : editorRef.current;
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
			path: `${selection.repo ?? selection.project}/${selection.path}`,
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
	useEffect(() => {
		const find = (): void => {
			if (showMarkdown) {
				findOnMount.current = true;
				setMarkdownMode({ key: fileKey, source: true });
			} else editorRef.current?.trigger("boa", "actions.find", null);
		};
		window.addEventListener("boa:find", find);
		return () => window.removeEventListener("boa:find", find);
	}, [showMarkdown, fileKey]);
	if (!selection)
		return (
			<section className="code-viewer empty-view" data-testid="preview-empty">
				<FileCode2 size={32} strokeWidth={1} />
				<h2>{t("viewer.emptyTitle")}</h2>
				<p>{t("viewer.emptyDescription")}</p>
				<span>{t("viewer.readOnly")}</span>
			</section>
		);
	return (
		<section className={`code-viewer ${compact ? "compact" : ""}`} data-testid="code-viewer">
			<div className="editor-toolbar">
				<span className="editor-tab">
					<FileCode2 size={14} />
					{selection.path.split("/").pop()}
				</span>
				<div className="toolbar-actions">
					{isMarkdown && !draft && (
						<button
							type="button"
							className="quiet-button"
							data-testid="markdown-toggle"
							onClick={() => setMarkdownMode({ key: fileKey, source: showMarkdown })}
						>
							{showMarkdown ? t("viewer.source") : t("viewer.preview")}
						</button>
					)}
					<ContextBubbles capture={capture} context={capture()} />
					{selection.repo && (
						<>
							<button
								type="button"
								className="icon-button"
								data-testid="diff-previous"
								title={t("viewer.previous")}
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
								title={t("viewer.next")}
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
							title={sideBySide ? t("viewer.inlineDiff") : t("viewer.sideBySideDiff")}
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
						disabled={!query.data || !hasSelection}
					>
						<Copy size={13} />
						{t("viewer.copySelection")}
					</button>
					<button
						type="button"
						className="quiet-button"
						data-testid="copy-whole-file"
						disabled={!query.data}
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
				{selection.repo ? (
					<span>{query.data?.label}</span>
				) : (
					<div className="editing-controls">
						{draft && (
							<>
								{draft.content !== draft.original && <span data-testid="edit-dirty">•</span>}
								<button
									type="button"
									disabled={draft.saving}
									title={t("edit.undo")}
									onClick={() => editorRef.current?.trigger("boa", "undo", null)}
								>
									↶
								</button>
								<button
									type="button"
									disabled={draft.saving}
									title={t("edit.redo")}
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
				(showMarkdown ? (
					<MarkdownPreview
						key={`${selection.project}/${selection.path}`}
						project={selection.project}
						path={selection.path}
						content={query.data.modified}
						restorePosition={
							markdownBookmark.current?.key === fileKey ? markdownBookmark.current.position : undefined
						}
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
							if (findOnMount.current && navigate) {
								findOnMount.current = false;
								editor.trigger("boa", "actions.find", null);
							}
							sideRef.current = side;
							setSelectionVersion((version) => version + 1);
							if (navigate && draft && markdownBookmark.current?.key === fileKey) {
								editor.revealLineNearTop(markdownBookmark.current.line);
							} else if (selection.line && navigate) {
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
						}}
					/>
				))
			)}
		</section>
	);
}

function MonacoContent({
	preview,
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
	editable?: boolean;
	onChange: (value: string) => void;
	onSave: () => void;
	diff: boolean;
	sideBySide: boolean;
	onEditor: (editor: monaco.editor.IStandaloneCodeEditor, side: string, navigate: boolean) => void;
}) {
	const { t } = useTranslation("workspace");
	const reader = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
	const save = useRef(onSave);
	save.current = onSave;
	useLayoutEffect(() => {
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
					theme="vs-dark"
					defaultValue={preview.modified}
					language={language(preview.path)}
					options={{ ...options, readOnly: !editable, domReadOnly: !editable }}
					onChange={(value) => {
						if (editable) onChange(value ?? "");
					}}
					onMount={(editor) => {
						reader.current = editor;
						editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save.current());
						editor.onDidChangeCursorSelection(() => onEditor(editor, "file", false));
						onEditor(editor, "file", true);
					}}
				/>
			)}
		</div>
	);
}
