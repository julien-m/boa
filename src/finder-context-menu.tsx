/** Finder reveal for gallery cards and image dialogs, including keyboard access. */
import { type KeyboardEvent, type MouseEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { useFileLabels } from "./file-workspace-labels";
import "./file-context-menu.css";

type Target = { x: number; y: number; trigger: HTMLElement; portal: HTMLElement };
function FinderMenu({
	project,
	path,
	target,
	onClose,
	onError,
}: {
	project: string;
	path: string;
	target: Target;
	onClose: () => void;
	onError: (error: string) => void;
}) {
	const l = useFileLabels();
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
		window.addEventListener("resize", onClose);
		return () => {
			document.removeEventListener("pointerdown", outside, true);
			window.removeEventListener("resize", onClose);
			if (target.trigger.isConnected) target.trigger.focus({ preventScroll: true });
		};
	}, [target]);
	return createPortal(
		<div
			ref={menu}
			role="menu"
			aria-label={l.contextMenu}
			className="file-context-menu"
			style={{ left: position.x, top: position.y }}
			onContextMenu={(event) => event.preventDefault()}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (["Escape", "Tab"].includes(event.key)) {
					event.preventDefault();
					onClose();
				}
			}}
		>
			<button
				type="button"
				role="menuitem"
				onClick={() => {
					onClose();
					void api.revealFile(project, path).catch((error: unknown) => onError(String(error)));
				}}
			>
				{l.finder}
			</button>
		</div>,
		target.portal,
	);
}
export function useFinderContextMenu(project: string, path: string) {
	const [target, setTarget] = useState<Target | null>(null);
	const [error, setError] = useState("");
	const open = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
		event.preventDefault();
		event.stopPropagation();
		const trigger = event.currentTarget;
		const bounds = trigger.getBoundingClientRect();
		setError("");
		setTarget({
			trigger: (event.target as Element).closest<HTMLElement>("button, [tabindex]") ?? trigger,
			portal: trigger.closest("dialog") ?? document.body,
			x: "clientX" in event ? event.clientX : bounds.left,
			y: "clientY" in event ? event.clientY : bounds.bottom,
		});
	};
	return {
		onContextMenu: open,
		onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
			if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") open(event);
		},
		menu: (
			<>
				{target && (
					<FinderMenu
						project={project}
						path={path}
						target={target}
						onClose={() => setTarget(null)}
						onError={setError}
					/>
				)}
				{error && (
					<p className="inline-error" role="alert">
						{error}
					</p>
				)}
			</>
		),
	};
}
