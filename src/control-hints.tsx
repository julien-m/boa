/** One delegated tooltip handles translated control labels, including controls inside modal dialogs. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

function hintFor(control: HTMLElement, french: boolean) {
	const label =
		control.dataset.hint ||
		control.getAttribute("aria-label") ||
		(control.tagName === "BUTTON" ? control.textContent : "");
	const keys = control
		.getAttribute("aria-keyshortcuts")
		?.replaceAll("ArrowLeft", "←")
		.replaceAll("ArrowRight", "→")
		.replaceAll("PageUp", "Page ↑")
		.replaceAll("PageDown", "Page ↓")
		.replaceAll("Escape", french ? "Échap" : "Esc");
	return [label?.trim(), keys].filter(Boolean).join(" · ");
}
export function ControlHints() {
	const { i18n } = useTranslation();
	const id = useId();
	const [control, setControl] = useState<HTMLElement | null>(null);
	const tooltip = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState({ left: 0, top: 0 });
	const [text, setText] = useState("");
	useLayoutEffect(() => {
		if (!control) {
			setText("");
			return;
		}
		const update = () => setText(hintFor(control, i18n.language.startsWith("fr")));
		update();
		const observer = new MutationObserver(update);
		observer.observe(control, {
			attributes: true,
			attributeFilter: ["data-hint", "aria-label", "aria-keyshortcuts"],
			childList: true,
			characterData: true,
			subtree: true,
		});
		return () => observer.disconnect();
	}, [control, i18n.language]);
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const hide = () => {
			clearTimeout(timer);
			setControl(null);
		};
		const find = (target: EventTarget | null) =>
			target instanceof Element
				? target.closest<HTMLElement>("button,[data-hint],input[aria-label],select[aria-label]")
				: null;
		const show = (event: Event) => {
			const element = find(event.target);
			if (!element || element.closest("[hidden],[inert]")) return;
			if (
				event instanceof MouseEvent &&
				event.relatedTarget instanceof Node &&
				element.contains(event.relatedTarget)
			)
				return;
			clearTimeout(timer);
			setControl(null);
			if (event.type === "focusin") setControl(element);
			else timer = setTimeout(() => setControl(element.isConnected ? element : null), 350);
		};
		const leave = (event: Event) => {
			const element = find(event.target);
			const related = (event as FocusEvent).relatedTarget;
			if (related instanceof Node && element?.contains(related)) return;
			hide();
		};
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") hide();
		};
		document.addEventListener("pointerover", show);
		document.addEventListener("pointerout", leave);
		document.addEventListener("focusin", show);
		document.addEventListener("focusout", leave);
		document.addEventListener("keydown", key);
		document.addEventListener("click", hide);
		window.addEventListener("scroll", hide, true);
		window.addEventListener("resize", hide);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("pointerover", show);
			document.removeEventListener("pointerout", leave);
			document.removeEventListener("focusin", show);
			document.removeEventListener("focusout", leave);
			document.removeEventListener("keydown", key);
			document.removeEventListener("click", hide);
			window.removeEventListener("scroll", hide, true);
			window.removeEventListener("resize", hide);
		};
	}, []);
	useLayoutEffect(() => {
		if (!control || !text || !tooltip.current) return;
		const bounds = control.getBoundingClientRect(),
			hint = tooltip.current.getBoundingClientRect();
		setPosition({
			left: Math.max(8, Math.min(bounds.left, window.innerWidth - hint.width - 8)),
			top:
				bounds.bottom + hint.height + 16 < window.innerHeight
					? bounds.bottom + 8
					: Math.max(8, bounds.top - hint.height - 8),
		});
		const tokens = new Set((control.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
		tokens.add(id);
		control.setAttribute("aria-describedby", [...tokens].join(" "));
		return () => {
			const remaining = (control.getAttribute("aria-describedby") || "")
				.split(/\s+/)
				.filter((token) => token && token !== id);
			if (remaining.length) control.setAttribute("aria-describedby", remaining.join(" "));
			else control.removeAttribute("aria-describedby");
		};
	}, [control, text, id]);
	return control?.isConnected && text
		? createPortal(
				<div ref={tooltip} id={id} role="tooltip" className="control-hint" style={position}>
					{text}
				</div>,
				control.closest("dialog[open]") ?? document.body,
			)
		: null;
}
