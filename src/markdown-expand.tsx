/** Native modal keeps the original reader mounted, including its scroll positions. */
import { Maximize2, X } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

type Expansion = { content: ReactNode; label: string; trigger: HTMLElement; scrollTop: number };
const ExpansionContext = createContext<((value: Expansion) => void) | null>(null);

function ExpandedMarkdown({ value, onClose }: { value: Expansion; onClose: () => void }) {
	const { t } = useTranslation("workspace");
	const dialog = useRef<HTMLDialogElement>(null);
	const body = useRef<HTMLDivElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		const element = dialog.current;
		element?.showModal();
		close.current?.focus({ preventScroll: true });
		if (body.current) body.current.scrollTop = value.scrollTop;
		return () => {
			if (element?.open) element.close();
			if (value.trigger.isConnected) value.trigger.focus({ preventScroll: true });
		};
	}, [value]);
	return createPortal(
		<dialog
			ref={dialog}
			className="markdown-expanded"
			aria-label={value.label}
			onCancel={(e) => {
				e.preventDefault();
				onClose();
			}}
			onClose={(event) => {
				// Ignore a queued cleanup close if StrictMode has already reopened this dialog.
				if (!event.currentTarget.open) onClose();
			}}
		>
			<header>
				<strong>{value.label}</strong>
				<button
					ref={close}
					type="button"
					className="quiet-button"
					onClick={onClose}
					aria-label={t("markdown.closeExpanded")}
				>
					<X size={16} />
					{t("markdown.closeExpanded")}
				</button>
			</header>
			<div ref={body} className="markdown-expanded-scroll">
				<ExpansionContext.Provider value={null}>
					<article className="markdown-preview markdown-expanded-content">{value.content}</article>
				</ExpansionContext.Provider>
			</div>
		</dialog>,
		document.body,
	);
}

export function MarkdownExpansion({ children, revision }: { children: ReactNode; revision: string }) {
	const [expanded, setExpanded] = useState<Expansion | null>(null);
	useEffect(() => {
		setExpanded(null);
	}, [revision]);
	return (
		<ExpansionContext.Provider value={setExpanded}>
			{children}
			{expanded && <ExpandedMarkdown value={expanded} onClose={() => setExpanded(null)} />}
		</ExpansionContext.Provider>
	);
}

export function MarkdownExpandButton({
	content,
	label,
	wholeDocument = false,
	toolbar = false,
}: {
	content: ReactNode;
	label: string;
	wholeDocument?: boolean;
	toolbar?: boolean;
}) {
	const expand = useContext(ExpansionContext);
	const { t } = useTranslation("workspace");
	if (!expand) return null;
	return (
		<button
			type="button"
			className={`icon-button markdown-expand-button ${wholeDocument || toolbar ? "markdown-expand-document" : ""}`}
			title={t("markdown.expand", { name: label })}
			aria-label={t("markdown.expand", { name: label })}
			onClick={(e) =>
				expand({
					content,
					label,
					trigger: e.currentTarget,
					scrollTop: wholeDocument ? (e.currentTarget.closest(".markdown-scroll")?.scrollTop ?? 0) : 0,
				})
			}
		>
			<Maximize2 size={15} />
			{wholeDocument && <span>{t("markdown.expandDocument")}</span>}
		</button>
	);
}

export function MarkdownExpandable({
	children,
	label,
	inline = false,
	expandedContent,
}: {
	children: ReactNode;
	label: string;
	inline?: boolean;
	expandedContent?: ReactNode;
}) {
	const Tag = inline ? "span" : "div";
	return (
		<Tag className="markdown-expandable">
			<MarkdownExpandButton content={expandedContent ?? children} label={label} />
			{children}
		</Tag>
	);
}
