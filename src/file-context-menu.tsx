import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Fragment, type KeyboardEvent, type MouseEvent, useLayoutEffect, useRef, useState } from "react";
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

type FileAction = {
	label: string;
	action: () => void | Promise<void>;
	disabled?: boolean;
	testId?: string;
};

export type FileActionMenuAnchor = Pick<FileMenuTarget, "trigger" | "x" | "y"> & {
	alignEnd?: boolean;
	toggleTrigger?: boolean;
	returnFocus?: HTMLElement;
};

export function absoluteFilePath(root: string, path: string, singleFile = false): string {
	return singleFile ? root : `${root.replace(/\/$/, "")}/${path}`;
}

export function filePathActions(
	labels: ReturnType<typeof useFileLabels>,
	entry: Pick<DirectoryEntry, "name" | "path">,
	fullPath: string,
): FileAction[] {
	return [
		{ label: labels.copyName, action: () => writeText(entry.name), testId: "file-action-copy-name" },
		{ label: labels.copyRelative, action: () => writeText(entry.path), testId: "file-action-copy-relative" },
		{ label: labels.copyAbsolute, action: () => writeText(fullPath), testId: "file-action-copy-absolute" },
	];
}

export function FileActionMenu({
	target,
	groups,
	label,
	onClose,
	onError,
	portal = document.body,
}: {
	target: FileActionMenuAnchor;
	groups: readonly (readonly FileAction[])[];
	label: string;
	onClose: () => void;
	onError: (error: string) => void;
	portal?: HTMLElement;
}) {
	const menu = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState({ x: target.x, y: target.y });
	useLayoutEffect(() => {
		const node = menu.current!;
		const bounds = node.getBoundingClientRect();
		setPosition({
			x: Math.max(
				8,
				Math.min(target.alignEnd ? target.x - bounds.width : target.x, window.innerWidth - bounds.width - 8),
			),
			y: Math.max(8, Math.min(target.y, window.innerHeight - bounds.height - 8)),
		});
		node.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
		const outside = (event: PointerEvent) => {
			const clicked = event.target as Node;
			if (!node.contains(clicked) && !(target.toggleTrigger && target.trigger.contains(clicked))) onClose();
		};
		const dismiss = () => onClose();
		document.addEventListener("pointerdown", outside, true);
		window.addEventListener("resize", dismiss);
		return () => {
			document.removeEventListener("pointerdown", outside, true);
			window.removeEventListener("resize", dismiss);
			const focus = target.returnFocus?.isConnected ? target.returnFocus : target.trigger;
			if (focus.isConnected) focus.focus({ preventScroll: true });
		};
	}, [target]);
	const run = (action: () => void | Promise<void>) => {
		onClose();
		try {
			Promise.resolve(action()).catch((error) => onError(String(error)));
		} catch (error) {
			onError(String(error));
		}
	};
	return createPortal(
		<div
			ref={menu}
			role="menu"
			aria-label={label}
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
			{groups.map((actions, index) => (
				<Fragment key={actions[0]?.label}>
					{index > 0 && <hr />}
					{actions.map((item) => (
						<button
							key={item.label}
							type="button"
							role="menuitem"
							data-testid={item.testId}
							tabIndex={-1}
							disabled={item.disabled}
							onClick={() => run(item.action)}
						>
							{item.label}
						</button>
					))}
				</Fragment>
			))}
		</div>,
		portal,
	);
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
	onAddToSpace,
	singleFile = false,
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
	onAddToSpace?: () => void;
	singleFile?: boolean;
}) {
	const l = useFileLabels();
	const { entry } = target;
	const image = !entry.directory && /\.(png|jpe?g|gif|webp|svg)$/i.test(entry.path);
	const actions: FileAction[] = [
		{ label: l.finder, action: () => api.revealFile(project, entry.path) },
		...(!entry.directory ? [{ label: l.openDefault, action: () => api.openFile(project, entry.path) }] : []),
		{ label: l.openBoa, action: target.open },
		...(target.keep ? [{ label: l.keepTab, action: target.keep }] : []),
		...filePathActions(l, entry, absoluteFilePath(project, entry.path, singleFile)),
		...(onAddToSpace ? [{ label: l.addToSpace, action: onAddToSpace }] : []),
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
	return (
		<FileActionMenu
			target={target}
			groups={[actions]}
			label={l.contextMenu}
			onClose={onClose}
			onError={onError}
		/>
	);
}
