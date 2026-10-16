/** Local Monaco reader and diff viewer with portable AI context export. */
import { DiffEditor, Editor, loader } from "@monaco-editor/react";
import { useQuery } from "@tanstack/react-query";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ArrowDown, ArrowUp, Copy, FileCode2, PanelLeftClose, SplitSquareHorizontal } from "lucide-react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import { useTranslation } from "react-i18next";
import "monaco-editor/basic-languages/monaco.contribution.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { type CodeContext, ContextBubbles } from "./context-bubbles";
import { MarkdownPreview } from "./markdown-preview";
import type { Preview, Selection } from "./models";
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
	const [sideBySide, setSideBySide] = useState(false);
	const [notice, setNotice] = useState<{ key: string; error?: string } | null>(null);
	const [markdownMode, setMarkdownMode] = useState<{ key: string; source: boolean } | null>(null);
	const fileKey = selection
		? `${selection.project}/${selection.path}:${selection.navigationId ?? selection.line ?? ""}`
		: "";
	const isMarkdown = Boolean(selection && !selection.repo && /\.(md|markdown)$/i.test(selection.path));
	const showMarkdown =
		isMarkdown && (markdownMode?.key === fileKey ? !markdownMode.source : !selection?.line);
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
					{isMarkdown && (
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
				{selection.path}
				<span>{query.data?.label}</span>
			</div>
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
			{query.isFetching ? (
				<div className="empty-view" data-testid="preview-loading">
					{t("viewer.loading")}
				</div>
			) : query.error ? (
				<div className="empty-view error" data-testid="preview-error">
					{String(query.error)}
				</div>
			) : (
				query.data &&
				(showMarkdown ? (
					<MarkdownPreview
						project={selection.project}
						path={selection.path}
						content={query.data.modified}
						onCopyLink={(href) => {
							void writeText(href).then(
								() => setNotice({ key: "viewer.linkCopied" }),
								(error: unknown) => setNotice({ key: "viewer.rawError", error: String(error) }),
							);
						}}
					/>
				) : (
					<MonacoContent
						preview={query.data}
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
							if (selection.line && navigate) {
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
	diff,
	sideBySide,
	onEditor,
	onDiffEditor,
}: {
	onDiffEditor: (editor: monaco.editor.IStandaloneDiffEditor | null) => void;
	preview: Preview;
	diff: boolean;
	sideBySide: boolean;
	onEditor: (editor: monaco.editor.IStandaloneCodeEditor, side: string, navigate: boolean) => void;
}) {
	const { t } = useTranslation("workspace");
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
					value={preview.modified}
					language={language(preview.path)}
					options={options}
					onMount={(editor) => {
						editor.onDidChangeCursorSelection(() => onEditor(editor, "file", false));
						onEditor(editor, "file", true);
					}}
				/>
			)}
		</div>
	);
}
