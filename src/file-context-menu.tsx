import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { type KeyboardEvent, type MouseEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { useFileLabels } from "./file-workspace-labels";
import { requestImageAction } from "./image-actions";
import type { DirectoryEntry } from "./models";
import "./file-context-menu.css";

export type FileMenuEvent = MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>;
export type FileMenuTarget = {
	entry: DirectoryEntry;
	trigger: HTMLElement;
	x: number;
	y: number;
	open: () => void;
	keep?: () => void;
};

export function fileMenuTarget(
	event: FileMenuEvent,
	entry: DirectoryEntry,
	open: () => void,
	keep?: () => void,
): FileMenuTarget {
	event.preventDefault();
	event.stopPropagation();
	const trigger = event.currentTarget;
	const selection = window.getSelection();
	if (selection?.anchorNode && trigger.contains(selection.anchorNode)) selection.removeAllRanges();
	const bounds = trigger.getBoundingClientRect();
	return {
		entry,
		trigger,
		open,
		keep,
		x: "clientX" in event ? event.clientX : bounds.left,
		y: "clientY" in event ? event.clientY : bounds.bottom,
	};
}

export function FileContextMenu({
	project,
	target,
	pinned,
	busy,
	onPin,
	onFolderImages,
	onSearch,
	onShare,
	onClose,
	onError,
}: {
	project: string;
	target: FileMenuTarget;
	pinned: boolean;
	busy: boolean;
	onPin: () => void;
	onFolderImages?: () => void;
	onSearch: () => void;
	onShare: () => void;
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
		node.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
		const outside = (event: PointerEvent) => {
			if (!node.contains(event.target as Node)) onClose();
		};
		const dismiss = () => onClose();
		document.addEventListener("pointerdown", outside, true);
		window.addEventListener("resize", dismiss);
		return () => {
			document.removeEventListener("pointerdown", outside, true);
			window.removeEventListener("resize", dismiss);
			if (target.trigger.isConnected) target.trigger.focus({ preventScroll: true });
		};
	}, [target]);
	const { entry } = target;
	const image = !entry.directory && /\.(png|jpe?g|gif|webp|svg)$/i.test(entry.path);
	const run = (action: () => void | Promise<void>) => {
		onClose();
		try {
			Promise.resolve(action()).catch((error) => onError(String(error)));
		} catch (error) {
			onError(String(error));
		}
	};
	const actions: { label: string; action: () => void | Promise<void>; disabled?: boolean }[] = [
		{ label: l.finder, action: () => api.revealFile(project, entry.path) },
		...(!entry.directory ? [{ label: l.openDefault, action: () => api.openFile(project, entry.path) }] : []),
		{ label: l.openBoa, action: target.open },
		...(target.keep ? [{ label: l.keepTab, action: target.keep }] : []),
		{ label: l.copyName, action: () => writeText(entry.name) },
		{ label: l.copyRelative, action: () => writeText(entry.path) },
		{ label: l.copyAbsolute, action: () => writeText(`${project.replace(/\/$/, "")}/${entry.path}`) },
		{ label: pinned ? l.unpin : l.pin, action: onPin, disabled: busy },
		...(image
			? [
					{ label: l.previewImage, action: target.open },
					{
						label: l.fullscreen,
						action: () => {
							requestImageAction(project, entry.path, "fullscreen");
							target.open();
						},
					},
					{
						label: l.compareImages,
						action: () => {
							requestImageAction(project, entry.path, "compare");
							target.open();
						},
					},
				]
			: []),
		...(entry.directory
			? [
					...(onFolderImages ? [{ label: l.folderImages, action: onFolderImages }] : []),
					{ label: l.rootSearch, action: onSearch },
				]
			: []),
		{ label: l.shareContext, action: onShare },
	];
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
				const items = [...menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
				const current = items.indexOf(document.activeElement as HTMLButtonElement);
				if (event.key === "Enter") {
					event.preventDefault();
					items[current]?.click();
				} else if (event.key === "Escape" || event.key === "Tab") {
					event.preventDefault();
					onClose();
				} else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
					event.preventDefault();
					const next =
						event.key === "Home"
							? 0
							: event.key === "End"
								? items.length - 1
								: (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
					items[next]?.focus();
				}
			}}
		>
			{actions.map((item) => (
				<button
					key={item.label}
					type="button"
					role="menuitem"
					tabIndex={-1}
					disabled={item.disabled}
					onClick={() => run(item.action)}
				>
					{item.label}
				</button>
			))}
		</div>,
		document.body,
	);
}
