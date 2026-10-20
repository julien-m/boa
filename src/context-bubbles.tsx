/** One ephemeral context composer: selection or file reference, with explicit copying. */
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, MessageSquarePlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "./i18n";

export interface CodeContext {
	project: string;
	path: string;
	startLine: number | null;
	endLine: number | null;
	code: string;
	label: string;
}

/** A file context deliberately contains its location, never its whole content. */
export function contextPrompt(context: CodeContext, message: string, wholeFile = false): string {
	const location = i18n.t("workspace:context.location", { ...context });
	if (wholeFile || !context.code)
		return i18n.t("workspace:context.filePrompt", { message: message.trim(), location });
	const lines =
		context.startLine === null
			? ""
			: i18n.t("workspace:context.lines", {
					start: context.startLine,
					end: context.endLine,
				});
	return i18n.t("workspace:context.selectionPrompt", {
		message: message.trim(),
		location,
		lines,
		code: context.code,
	});
}

export function ContextBubbles({
	capture,
	context,
}: {
	capture: () => CodeContext | null;
	context: CodeContext | null;
}) {
	const { t } = useTranslation("workspace");
	const container = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const [draft, setDraft] = useState<CodeContext | null>(null);
	const [anchor, setAnchor] = useState({ top: 0, right: 16 });
	const [wholeFile, setWholeFile] = useState(false);
	const [message, setMessage] = useState("");
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<{ key: string; error?: string } | null>(null);
	const open = (): void => {
		const next = capture();
		if (!next) {
			setNotice({ key: "context.openFile" });
			return;
		}
		const bounds = container.current?.getBoundingClientRect();
		if (bounds) setAnchor({ top: bounds.bottom + 8, right: Math.max(16, window.innerWidth - bounds.right) });
		setDraft(next);
		setWholeFile(!next.code);
		setMessage("");
		setNotice(null);
	};
	// Follow a new source selection, while preserving it when the comment takes focus.
	const contextKey = context ? JSON.stringify(context) : "";
	useEffect(() => {
		if (!contextKey) return;
		const next: CodeContext = JSON.parse(contextKey);
		setDraft((current) => (current && (next.code || current.path !== next.path) ? next : current));
	}, [contextKey]);
	useEffect(() => {
		if (draft) input.current?.focus();
	}, [Boolean(draft)]);
	useEffect(() => {
		const outside = (event: PointerEvent): void => {
			if (!container.current?.contains(event.target as Node)) setDraft(null);
		};
		const keyboard = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setDraft(null);
			if (
				(event.metaKey || event.ctrlKey) &&
				event.shiftKey &&
				event.key.toLowerCase() === "b" &&
				!event.repeat
			) {
				event.preventDefault();
				open();
			}
		};
		document.addEventListener("pointerdown", outside, true);
		document.addEventListener("keydown", keyboard, true);
		return () => {
			document.removeEventListener("pointerdown", outside, true);
			document.removeEventListener("keydown", keyboard, true);
		};
	});
	const submit = async (): Promise<void> => {
		if (!draft || !message.trim() || pending) return;
		if (!wholeFile && draft.code.length > 100_000) {
			setNotice({ key: "context.tooLarge" });
			return;
		}
		setPending(true);
		try {
			await writeText(contextPrompt(draft, message, wholeFile));
			setDraft(null);
			setMessage("");
			setNotice({ key: "context.copied" });
		} catch (error) {
			setNotice({ key: "context.copyFailed", error: String(error) });
		} finally {
			setPending(false);
		}
	};
	return (
		<div className="context-bubbles" ref={container}>
			<button
				type="button"
				data-testid="create-context"
				className="quiet-button"
				data-hint={t("context.shortcut")}
				aria-expanded={Boolean(draft)}
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => (draft ? setDraft(null) : open())}
			>
				<MessageSquarePlus size={14} /> {t("context.bubble")}
			</button>
			{notice && (
				<button
					type="button"
					className="context-notice"
					data-testid="context-notice"
					onClick={() => setNotice(null)}
				>
					{t(notice.key, { error: notice.error })} ×
				</button>
			)}
			{draft && (
				<section
					role="dialog"
					aria-modal="false"
					aria-label={t("context.title")}
					className="bubble-popover"
					style={{
						position: "fixed",
						top: anchor.top,
						right: anchor.right,
						maxHeight: `calc(100vh - ${anchor.top + 24}px)`,
					}}
					data-testid="context-popover"
				>
					<header>
						<strong>{t("context.title")}</strong>
						<button
							type="button"
							className="icon-button"
							data-testid="close-contexts"
							aria-label={t("context.close")}
							onClick={() => setDraft(null)}
						>
							<X size={16} />
						</button>
					</header>
					<form
						className="bubble-draft"
						onSubmit={(event) => {
							event.preventDefault();
							void submit();
						}}
					>
						<div className="context-scope" role="group" aria-label={t("context.scope")}>
							<button
								type="button"
								className="quiet-button"
								data-testid="context-selection"
								disabled={!draft.code}
								aria-pressed={!wholeFile}
								onClick={() => setWholeFile(false)}
							>
								{t("context.selection")}
							</button>
							<button
								type="button"
								className="quiet-button"
								data-testid="context-file"
								aria-pressed={wholeFile}
								onClick={() => setWholeFile(true)}
							>
								{t("context.filePath")}
							</button>
						</div>
						<span className="context-path" title={draft.path}>
							{draft.path}
							{!wholeFile && draft.startLine !== null
								? t("context.lineRange", { start: draft.startLine, end: draft.endLine })
								: ""}
						</span>
						{wholeFile ? (
							<p className="small muted">{t("context.fileExplanation")}</p>
						) : (
							<pre className="context-excerpt" data-testid="context-excerpt">
								{draft.code}
							</pre>
						)}
						<label htmlFor="context-message">{t("context.question")}</label>
						<textarea
							id="context-message"
							data-testid="context-message"
							ref={input}
							placeholder={t("context.placeholder")}
							value={message}
							rows={3}
							onChange={(event) => setMessage(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
									event.preventDefault();
									void submit();
								}
							}}
						/>
						<div className="context-actions">
							<button type="button" className="quiet-button" onClick={() => setDraft(null)}>
								{t("context.cancel")}
							</button>
							<button
								type="submit"
								data-testid="save-context"
								className="primary-button"
								disabled={!message.trim() || pending}
							>
								<Copy size={13} />
								{pending ? t("context.copying") : t("context.confirm")}
							</button>
						</div>
					</form>
				</section>
			)}
		</div>
	);
}
