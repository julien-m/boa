/** One quiet, reader-scoped find/line widget; ordinary editing is never intercepted. */
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type * as monaco from "monaco-editor/editor/editor.api.js";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./reader-navigation.css";

export type ReaderMode = "auto" | "text" | "line";
export function readerQuery(
	value: string,
	mode: ReaderMode,
): { text: string; line: number | null; kind: "text" | "line" } {
	const kind = mode === "line" || (mode === "auto" && /^\d+$/.test(value)) ? "line" : "text";
	const line =
		kind === "line" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
	return { text: value, line, kind };
}
export function startsReaderQuery(
	event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "isComposing" | "keyCode">,
): boolean {
	return (
		!event.isComposing &&
		event.keyCode !== 229 &&
		!event.metaKey &&
		!event.ctrlKey &&
		!event.altKey &&
		event.key.length === 1
	);
}

export function ReaderNavigation({
	editor,
	root,
	readOnly,
	onSource,
}: {
	editor: monaco.editor.IStandaloneCodeEditor | null;
	root: RefObject<HTMLElement | null>;
	readOnly: boolean;
	onSource: () => void;
}) {
	const { i18n } = useTranslation();
	const fr = i18n.language.startsWith("fr");
	const [state, setState] = useState<{ value: string; mode: ReaderMode } | null>(null);
	const [caseSensitive, setCaseSensitive] = useState(false);
	const [matches, setMatches] = useState<monaco.editor.FindMatch[]>([]);
	const [index, setIndex] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const marks = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
	const source = useRef(onSource);
	source.current = onSource;
	const current = useRef(state);
	current.current = state;
	const open = (mode: ReaderMode, value = "") => {
		source.current();
		setState({ mode, value });
	};
	const close = () => {
		setState(null);
		marks.current?.clear();
		editor?.focus();
	};
	useEffect(() => {
		if (state) input.current?.focus();
	}, [Boolean(state), editor]);
	useEffect(() => {
		const element = root.current;
		if (!element) return;
		const onKey = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement;
			if (target.closest(".reader-navigation")) return;
			const inReader =
				target === element || !!target.closest(".monaco-editor, [data-testid=markdown-preview]");
			if (!inReader) return;
			if (event.key === "Escape" && current.current) {
				event.preventDefault();
				event.stopImmediatePropagation();
				close();
				return;
			}
			if (
				(event.metaKey || event.ctrlKey) &&
				!event.shiftKey &&
				!event.altKey &&
				["f", "l"].includes(event.key.toLowerCase())
			) {
				event.preventDefault();
				event.stopImmediatePropagation();
				open(event.key.toLowerCase() === "l" ? "line" : "text");
				return;
			}
			if (readOnly && startsReaderQuery(event)) {
				event.preventDefault();
				event.stopImmediatePropagation();
				if (event.key === " " && !current.current) open("text");
				else open(current.current?.mode ?? "auto", (current.current?.value ?? "") + event.key);
			}
		};
		const find = (event: Event) => {
			const target = (event as CustomEvent).detail?.target as HTMLElement | undefined;
			const chosen =
				target?.closest(".code-viewer") ?? document.querySelector(".code-viewer:not(.empty-view)");
			if (chosen === element) open("text");
		};
		element.addEventListener("keydown", onKey, true);
		window.addEventListener("boa:find", find);
		return () => {
			element.removeEventListener("keydown", onKey, true);
			window.removeEventListener("boa:find", find);
		};
	}, [readOnly, root]);
	useEffect(() => {
		marks.current?.clear();
		marks.current = editor?.createDecorationsCollection() ?? null;
		return () => marks.current?.clear();
	}, [editor]);
	const parsed = state ? readerQuery(state.value, state.mode) : null;
	const lineCount = editor?.getModel()?.getLineCount() ?? 0;
	const invalid = parsed?.kind === "line" && state?.value !== "" && (!parsed.line || parsed.line > lineCount);
	useEffect(() => {
		const model = editor?.getModel();
		marks.current?.clear();
		if (!state || !editor || !model) {
			setMatches([]);
			return;
		}
		const query = readerQuery(state.value, state.mode);
		if (query.kind === "line") {
			setMatches([]);
			if (query.line && query.line <= model.getLineCount()) {
				editor.setPosition({ lineNumber: query.line, column: 1 });
				editor.revealLineInCenterIfOutsideViewport(query.line);
			}
			return;
		}
		const found = state.value
			? model.findMatches(state.value, false, false, caseSensitive, null, false, 10000)
			: [];
		setMatches(found);
		setIndex(0);
		marks.current?.set(found.map(({ range }) => ({ range, options: { inlineClassName: "boa-find-match" } })));
		if (found[0]) {
			editor.setSelection(found[0].range);
			editor.revealRangeInCenterIfOutsideViewport(found[0].range);
		}
	}, [editor, state, caseSensitive]);
	const next = (direction: number) => {
		if (!matches.length || !editor) return;
		const n = (index + direction + matches.length) % matches.length;
		setIndex(n);
		editor.setSelection(matches[n].range);
		editor.revealRangeInCenterIfOutsideViewport(matches[n].range);
	};
	if (!state) return null;
	return (
		<div
			className={`reader-navigation ${invalid ? "invalid" : ""}`}
			role="search"
			data-testid="reader-navigation"
		>
			<button
				type="button"
				aria-pressed={parsed?.kind === "text"}
				onClick={() => setState({ ...state, mode: "text" })}
			>
				{fr ? "Texte" : "Text"}
			</button>
			<button
				type="button"
				aria-pressed={parsed?.kind === "line"}
				onClick={() => setState({ ...state, mode: "line" })}
			>
				{fr ? "Ligne" : "Line"}
			</button>
			<input
				ref={input}
				data-testid="reader-query"
				value={state.value}
				aria-label={
					parsed?.kind === "line"
						? fr
							? "Aller à la ligne"
							: "Go to line"
						: fr
							? "Rechercher dans le fichier"
							: "Find in file"
				}
				aria-invalid={Boolean(invalid)}
				onChange={(event) => setState({ ...state, value: event.target.value })}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing) return;
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						close();
					} else if (event.key === "Enter") {
						event.preventDefault();
						next(event.shiftKey ? -1 : 1);
					} else if ((event.metaKey || event.ctrlKey) && ["f", "l"].includes(event.key.toLowerCase())) {
						event.preventDefault();
						setState({ ...state, mode: event.key.toLowerCase() === "l" ? "line" : "text" });
					}
				}}
			/>
			{parsed?.kind === "text" ? (
				<>
					<span aria-live="polite">
						{state.value
							? `${matches.length ? index + 1 : 0} / ${matches.length}${matches.length === 10000 ? "+" : ""}`
							: ""}
					</span>
					<button
						type="button"
						disabled={!matches.length}
						aria-label={fr ? "Occurrence précédente" : "Previous match"}
						onClick={() => next(-1)}
					>
						<ArrowUp size={13} />
					</button>
					<button
						type="button"
						disabled={!matches.length}
						aria-label={fr ? "Occurrence suivante" : "Next match"}
						onClick={() => next(1)}
					>
						<ArrowDown size={13} />
					</button>
					<button
						type="button"
						aria-label={fr ? "Respecter la casse" : "Match case"}
						aria-pressed={caseSensitive}
						onClick={() => setCaseSensitive(!caseSensitive)}
					>
						Aa
					</button>
				</>
			) : (
				<span>{lineCount}</span>
			)}
			<button
				type="button"
				aria-label={fr ? "Fermer et garder la position" : "Close and keep position"}
				onClick={close}
			>
				<X size={13} />
			</button>
		</div>
	);
}
