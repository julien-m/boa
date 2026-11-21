/** Compare neighboring source tabs using the same scoped reads as the file reader. */
import { DiffEditor } from "@monaco-editor/react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { editor } from "monaco-editor/editor/editor.api.js";
import {
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { fileAnnotationContext, useAnnotationMenu } from "./annotation-menu";
import { api } from "./api";
import { disposeDiffModelsAfterEditor, monacoReaderOptions, resolveMonacoLanguage } from "./code-viewer";
import { useFileEditing } from "./file-editing";
import type { Selection } from "./models";
import "./file-comparison.css";

interface FilePair {
	left: Selection;
	right: Selection;
}

interface OpenComparison {
	pair: FilePair;
	selection: Selection | null;
	trigger: HTMLElement;
}

const sameFile = (a: Selection, b: Selection) => a.project === b.project && a.path === b.path;
const comparableLines = (text: string) => text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

/** Exposes contextual comparison actions in the order of the visible file tabs. */
export function useFileComparison(tabs: readonly Selection[], selection: Selection | null) {
	const { t } = useTranslation("workspace");
	const annotation = useAnnotationMenu();
	const [open, setOpen] = useState<OpenComparison | null>(null);
	const pair =
		open?.selection === selection &&
		tabs.some((tab) => sameFile(tab, open.pair.left)) &&
		tabs.some((tab) => sameFile(tab, open.pair.right))
			? open.pair
			: null;
	// Discard comparisons invalidated by a file change or navigation so going back cannot reopen them.
	if (open && !pair) setOpen(null);
	const openMenu = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, tab: Selection) => {
		const index = tabs.findIndex((candidate) => sameFile(candidate, tab));
		const trigger = event.currentTarget;
		const neighboringTabs = [
			{ side: "left", file: tabs[index - 1], label: "comparison.leftAction" },
			{ side: "right", file: tabs[index + 1], label: "comparison.rightAction" },
		] as const;
		const actions = neighboringTabs
			.filter(({ file }) => file && !file.repo)
			.map(({ side, label, file }) => {
				const target = fileAnnotationContext(file);
				return {
					id: `compare-file-${side}`,
					label: t(label, { name: target.label }),
					path: target.path,
					run: () =>
						setOpen({
							pair: side === "left" ? { left: file, right: tab } : { left: tab, right: file },
							selection,
							trigger,
						}),
				};
			});
		annotation.open(event, fileAnnotationContext(tab), actions);
	};
	return {
		pair,
		menu: annotation.menu,
		openMenu,
		close: (restoreFocus = false) => {
			setOpen(null);
			if (restoreFocus && open?.trigger.isConnected) open.trigger.focus({ preventScroll: true });
		},
	};
}

function useComparisonSource(file: Selection) {
	const editing = useFileEditing();
	const draft = editing.draft(file.project, file.path);
	const source = { project: file.project, path: file.path };
	const query = useQuery({
		queryKey: ["preview", source],
		queryFn: () => api.preview(source),
		enabled: !draft,
		refetchOnWindowFocus: false,
	});
	if (draft)
		return { kind: "text", content: draft.content, draft: draft.content !== draft.original } as const;
	if (query.isError) return { kind: "error" } as const;
	if (!query.data) return { kind: "loading" } as const;
	const { kind, modified } = query.data;
	// The normal reader exposes SVG source alongside its image preview.
	if (!kind || kind === "text" || (kind === "image" && /\.svg$/i.test(file.path) && modified))
		return { kind: "text", content: modified, draft: false } as const;
	return { kind: "unsupported" } as const;
}

/** Keeps the reader mounted while the comparison owns the visible panel. */
export function FileComparisonReader({
	comparison,
	onClose,
	children,
}: {
	comparison: FilePair | null;
	onClose: (restoreFocus?: boolean) => void;
	children: ReactNode;
}) {
	return (
		<>
			<div className="file-reader-slot" hidden={Boolean(comparison)}>
				{children}
			</div>
			{comparison && (
				<FileComparison
					key={JSON.stringify([
						comparison.left.project,
						comparison.left.path,
						comparison.right.project,
						comparison.right.path,
					])}
					pair={comparison}
					onClose={() => onClose(true)}
				/>
			)}
		</>
	);
}

function FileComparison({ pair, onClose }: { pair: FilePair; onClose: () => void }) {
	const { t } = useTranslation("workspace");
	const left = useComparisonSource(pair.left);
	const right = useComparisonSource(pair.right);
	const leftFile = fileAnnotationContext(pair.left);
	const rightFile = fileAnnotationContext(pair.right);
	const container = useRef<HTMLElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	const diff = useRef<editor.IStandaloneDiffEditor>(null);
	const [hasChanges, setHasChanges] = useState(false);
	useLayoutEffect(() => close.current?.focus({ preventScroll: true }), []);
	useEffect(() => {
		const find = (event: Event) => {
			const target = event instanceof CustomEvent ? event.detail?.target : null;
			const current = diff.current;
			if (!current || !(target instanceof Node) || !container.current?.contains(target)) return;
			const original = current.getOriginalEditor();
			const pane = original.getDomNode()?.contains(target) ? original : current.getModifiedEditor();
			pane.trigger("boa", "actions.find", null);
		};
		window.addEventListener("boa:find", find);
		return () => window.removeEventListener("boa:find", find);
	}, []);
	const issues = [
		{ source: left, path: leftFile.path },
		{ source: right, path: rightFile.path },
	].flatMap(({ source, path }) => {
		if (source.kind === "error") return [t("comparison.readError", { path })];
		if (source.kind === "unsupported") return [t("comparison.unsupported", { path })];
		return [];
	});
	const identical = left.kind === "text" && right.kind === "text" && left.content === right.content;
	const formattingOnly =
		!identical &&
		left.kind === "text" &&
		right.kind === "text" &&
		comparableLines(left.content) === comparableLines(right.content);
	return (
		<section
			ref={container}
			className="file-comparison"
			data-testid="file-comparison"
			aria-label={t("comparison.title")}
			onKeyDown={(event) => {
				if (event.key !== "Escape" || event.defaultPrevented) return;
				event.preventDefault();
				event.stopPropagation();
				onClose();
			}}
		>
			<div className="editor-toolbar file-comparison-toolbar">
				<strong>{t("comparison.title")}</strong>
				{identical && <span role="status">{t("comparison.identical")}</span>}
				{formattingOnly && <span role="status">{t("comparison.formattingOnly")}</span>}
				<div className="toolbar-actions">
					<button
						type="button"
						className="icon-button"
						data-hint={t("viewer.previous")}
						aria-label={t("viewer.previous")}
						disabled={!hasChanges || Boolean(issues.length)}
						onClick={() => diff.current?.goToDiff("previous")}
					>
						<ArrowUp size={15} />
					</button>
					<button
						type="button"
						className="icon-button"
						data-hint={t("viewer.next")}
						aria-label={t("viewer.next")}
						disabled={!hasChanges || Boolean(issues.length)}
						onClick={() => diff.current?.goToDiff("next")}
					>
						<ArrowDown size={15} />
					</button>
					<button
						ref={close}
						type="button"
						className="icon-button"
						data-hint={t("comparison.close")}
						aria-label={t("comparison.close")}
						onClick={onClose}
					>
						<X size={15} />
					</button>
				</div>
			</div>
			<div className="file-comparison-labels">
				<div title={leftFile.path} data-testid="comparison-left-file">
					<span>{t("comparison.leftFile")}</span>
					<strong>{leftFile.label}</strong>
					{left.kind === "text" && left.draft && <span>{t("comparison.draft")}</span>}
				</div>
				<div title={rightFile.path} data-testid="comparison-right-file">
					<span>{t("comparison.rightFile")}</span>
					<strong>{rightFile.label}</strong>
					{right.kind === "text" && right.draft && <span>{t("comparison.draft")}</span>}
				</div>
			</div>
			{issues.length ? (
				<div className="file-comparison-status" role="alert">
					{issues.map((issue) => (
						<div key={issue}>{issue}</div>
					))}
				</div>
			) : left.kind === "text" && right.kind === "text" ? (
				<div className="monaco-container">
					<DiffEditor
						theme="vs-dark"
						keepCurrentOriginalModel
						keepCurrentModifiedModel
						original={left.content}
						modified={right.content}
						originalLanguage={resolveMonacoLanguage(pair.left.path)}
						modifiedLanguage={resolveMonacoLanguage(pair.right.path)}
						options={{
							...monacoReaderOptions,
							renderSideBySide: true,
							useInlineViewWhenSpaceIsLimited: false,
							enableSplitViewResizing: false,
							ignoreTrimWhitespace: false,
							originalAriaLabel: leftFile.path,
							modifiedAriaLabel: rightFile.path,
						}}
						onMount={(editor) => {
							diff.current = editor;
							disposeDiffModelsAfterEditor(editor);
							const update = () => setHasChanges(Boolean(editor.getLineChanges()?.length));
							const subscription = editor.onDidUpdateDiff(update);
							update();
							editor.onDidDispose(() => {
								subscription.dispose();
								diff.current = null;
							});
						}}
					/>
				</div>
			) : (
				<div className="file-comparison-status" role="status">
					{t("viewer.loading")}
				</div>
			)}
		</section>
	);
}
