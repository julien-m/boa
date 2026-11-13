/** One contextual annotation entry point shared by source selections and file tabs. */
import { type KeyboardEvent, type MouseEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CodeContext } from "./context-bubbles";
import { useContextCollection } from "./context-collection";
import { useCollectionLabels } from "./context-collection-labels";
import type { Selection } from "./models";
import "./file-context-menu.css";

type Target = { context: CodeContext; x: number; y: number; trigger: HTMLElement };
export function fileAnnotationContext(selection: Selection): CodeContext {
	return {
		project: selection.project,
		path: selection.absolutePath ?? `${selection.repo ?? selection.project}/${selection.path}`,
		startLine: null,
		endLine: null,
		code: "",
		label: selection.path.split("/").pop() ?? selection.path,
	};
}
function AnnotationMenu({ target, onClose }: { target: Target; onClose: () => void }) {
	const c = useContextCollection()!;
	const l = useCollectionLabels();
	const menu = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState({ x: target.x, y: target.y });
	useLayoutEffect(() => {
		const node = menu.current!;
		const bounds = node.getBoundingClientRect();
		setPosition({
			x: Math.max(8, Math.min(target.x, window.innerWidth - bounds.width - 8)),
			y: Math.max(8, Math.min(target.y, window.innerHeight - bounds.height - 8)),
		});
		node.querySelector("button")?.focus({ preventScroll: true });
		const outside = (event: PointerEvent) => {
			if (!node.contains(event.target as Node)) onClose();
		};
		document.addEventListener("pointerdown", outside, true);
		return () => {
			document.removeEventListener("pointerdown", outside, true);
			if (target.trigger.isConnected) target.trigger.focus({ preventScroll: true });
		};
	}, [target]);
	return createPortal(
		<div
			ref={menu}
			role="menu"
			aria-label={l.title}
			className="file-context-menu"
			style={{ left: position.x, top: position.y }}
			onContextMenu={(event) => event.preventDefault()}
			onKeyDown={(event) => {
				if (["Escape", "Tab"].includes(event.key)) {
					event.preventDefault();
					event.stopPropagation();
					onClose();
				}
			}}
		>
			<button
				type="button"
				role="menuitem"
				disabled={!c.ready}
				onClick={() => {
					onClose();
					c.annotate(target.context, {
						top: Math.min(target.y, Math.max(16, window.innerHeight - 400)),
						right: Math.max(16, window.innerWidth - target.x - 420),
					});
				}}
			>
				{target.context.code ? l.annotateText : l.add}
			</button>
		</div>,
		document.body,
	);
}
export function useAnnotationMenu() {
	const c = useContextCollection();
	const [target, setTarget] = useState<Target | null>(null);
	return {
		open: (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, context: CodeContext | null) => {
			if (!c || !context) return;
			event.preventDefault();
			event.stopPropagation();
			const bounds = event.currentTarget.getBoundingClientRect();
			setTarget({
				context: { ...context },
				trigger: event.currentTarget,
				x: "clientX" in event ? event.clientX : bounds.left,
				y: "clientY" in event ? event.clientY : bounds.bottom,
			});
		},
		menu: target && c ? <AnnotationMenu target={target} onClose={() => setTarget(null)} /> : null,
	};
}
