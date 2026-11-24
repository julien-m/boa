/** Quick Look-style image browsing keeps the gallery, its filters and scroll position underneath. */
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Ellipsis, Maximize2, Minimize2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import {
	absoluteFilePath,
	FileActionMenu,
	type FileActionMenuAnchor,
	filePathActions,
} from "./file-context-menu";
import { FileSpaceAdd } from "./file-space-add";
import type { LibraryImage } from "./file-workspace-api";
import { useFileLabels } from "./file-workspace-labels";
import { ImageFileDatesContext, ImageViewer, ImageZoom, useImageZoomSession } from "./image-viewer";
import { createImageTabNavigation, createImageWheelNavigation } from "./image-wheel";
import { useImageWheelPreferences } from "./use-image-wheel-preferences";

export function ImageLibraryPreview({
	root,
	singleFile,
	image,
	index,
	total,
	trigger,
	onStep,
	onClose,
	onOpen,
	onReveal,
}: {
	root: string;
	singleFile: boolean;
	image: LibraryImage;
	index: number;
	total: number;
	trigger: HTMLElement;
	onStep: (direction: number) => void;
	onClose: () => void;
	onOpen: () => void;
	onReveal: () => void;
}) {
	const l = useFileLabels();
	const { t } = useTranslation("workspace");
	const dialog = useRef<HTMLDialogElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	const more = useRef<HTMLButtonElement>(null);
	const zoomSession = useImageZoomSession();
	const [menu, setMenu] = useState<FileActionMenuAnchor | null>(null);
	const [space, setSpace] = useState<{ image: LibraryImage; trigger: HTMLElement } | null>(null);
	const [menuError, setMenuError] = useState("");
	const [fullscreen, setFullscreen] = useState(false);
	const [failed, setFailed] = useState(false);
	const query = useQuery({
		queryKey: ["library-preview", root, image.path, image.created, image.modified, image.size],
		queryFn: () => api.preview({ project: root, path: image.path }),
		retry: false,
		gcTime: 0,
		refetchOnWindowFocus: false,
	});
	const step = (direction: number) => {
		if (query.isFetching) return;
		// Image controls are replaced while the next file loads; keep keyboard focus in the dialog.
		setMenu(null);
		setMenuError("");
		close.current?.focus({ preventScroll: true });
		zoomSession.retain();
		onStep(direction);
	};
	const wheelState = useRef({ step, index, total, fetching: query.isFetching });
	wheelState.current = { step, index, total, fetching: query.isFetching };
	const { preferences: wheelPreferences } = useImageWheelPreferences();
	const wheelNavigation = useMemo(() => createImageWheelNavigation(wheelPreferences), [wheelPreferences]);
	const tabNavigation = useMemo(() => createImageTabNavigation(wheelPreferences), [wheelPreferences]);
	useEffect(() => {
		const element = dialog.current;
		if (!element) return;
		const navigate = (event: WheelEvent) => {
			if (!(event.target instanceof Element) || event.defaultPrevented) return;
			if (event.target.closest("header,.image-context-form,input,textarea,select,button,[contenteditable]"))
				return;
			const current = wheelState.current;
			const viewport = event.target.closest<HTMLElement>(".image-viewport");
			const loadingSurface =
				current.fetching && (event.target === element || !!event.target.closest(".inline-status"));
			if (viewport ? !element.contains(viewport) : !loadingSurface) return;
			const image = viewport?.querySelector("img");
			const ready = !current.fetching && !!image?.complete && !!image.naturalWidth;
			const decision = wheelNavigation(event, viewport, ready);
			if (!decision.consume) return;
			event.preventDefault();
			if (current.fetching || !decision.direction) return;
			if (
				(decision.direction < 0 && current.index <= 0) ||
				(decision.direction > 0 && current.index >= current.total - 1)
			)
				return;
			current.step(decision.direction);
		};
		// React's delegated wheel handlers may be passive; this listener deliberately owns navigation.
		element.addEventListener("wheel", navigate, { passive: false });
		return () => element.removeEventListener("wheel", navigate);
	}, [wheelNavigation]);
	useEffect(() => {
		setFailed(false);
	}, [image.path, image.created, image.modified, image.size]);
	useEffect(() => {
		const element = dialog.current;
		element?.showModal();
		close.current?.focus({ preventScroll: true });
		return () => {
			if (element?.open) element.close();
			if (trigger.isConnected) trigger.focus({ preventScroll: true });
		};
	}, [trigger]);
	const openMenu = (point?: { x: number; y: number }, returnFocus?: HTMLElement) => {
		const button = more.current;
		if (!button) return;
		const bounds = button.getBoundingClientRect();
		setMenuError("");
		setMenu({
			trigger: button,
			x: point?.x ?? bounds.right,
			y: point?.y ?? bounds.bottom,
			alignEnd: !point,
			toggleTrigger: true,
			returnFocus,
		});
	};
	return createPortal(
		<ImageZoom session={zoomSession.state}>
			<dialog
				ref={dialog}
				className={`library-lightbox ${fullscreen ? "fullscreen" : ""}`}
				aria-label={l.imagePreview}
				onCancel={(event) => {
					event.preventDefault();
					if (menu) setMenu(null);
					else onClose();
				}}
				onClose={(event) => {
					if (!event.currentTarget.open) onClose();
				}}
				onContextMenu={(event) => {
					if (!(event.target as HTMLElement).closest(".image-viewport")) return;
					event.preventDefault();
					event.stopPropagation();
					openMenu(
						{ x: event.clientX, y: event.clientY },
						(event.target as Element).closest<HTMLElement>("button, [tabindex]") ?? undefined,
					);
				}}
				onKeyDown={(event) => {
					if (event.defaultPrevented) return;
					if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
						event.preventDefault();
						event.stopPropagation();
						openMenu(undefined, event.target instanceof HTMLElement ? event.target : undefined);
						return;
					}
					// Thumb-wheel tab commands apply only to an open image, never to text being edited.
					if (
						!(event.target as HTMLElement).closest(
							'input:not([type="range"]),textarea,select,[contenteditable]',
						)
					) {
						const decision = tabNavigation(event, !query.isFetching);
						if (decision.consume) {
							event.preventDefault();
							event.stopPropagation();
							if (decision.direction && (decision.direction < 0 ? index > 0 : index < total - 1))
								step(decision.direction);
							return;
						}
					}
					if (event.metaKey || event.ctrlKey || event.altKey) return;
					if ((event.target as HTMLElement).closest("input,textarea,select,[contenteditable]")) return;
					const direction = ["ArrowRight", "PageDown"].includes(event.key)
						? 1
						: ["ArrowLeft", "PageUp"].includes(event.key)
							? -1
							: 0;
					if (!direction) return;
					event.preventDefault();
					step(direction);
				}}
			>
				{menu && dialog.current && (
					<FileActionMenu
						target={menu}
						portal={dialog.current}
						label={l.imageActions}
						onClose={() => setMenu(null)}
						onError={setMenuError}
						groups={[
							[
								{ label: l.openInFiles, action: onOpen, testId: "file-action-open-in-files" },
								{ label: l.revealFile, action: onReveal, testId: "file-action-reveal-in-tree" },
								{
									label: l.addToSpace,
									action: () => setSpace({ image, trigger: menu.returnFocus ?? menu.trigger }),
									testId: "file-action-add-to-space",
								},
							],
							[
								{
									label: l.finder,
									action: () => api.revealFile(root, image.path),
									testId: "file-action-finder",
								},
								{
									label: l.openDefault,
									action: () => api.openFile(root, image.path),
									testId: "file-action-open-default",
								},
							],
							filePathActions(l, image, absoluteFilePath(root, image.path, singleFile)),
						]}
					/>
				)}
				<header>
					<div className="library-preview-title">
						<strong className="truncate" title={image.path}>
							{image.name}
						</strong>
						<small>
							{index + 1} / {total}
						</small>
					</div>
					<div className="library-preview-actions">
						<button
							ref={more}
							type="button"
							className="icon-button"
							data-testid="library-image-actions"
							aria-label={l.imageActions}
							aria-haspopup="menu"
							aria-expanded={!!menu}
							data-hint={l.imageActions}
							onClick={() => (menu ? setMenu(null) : openMenu())}
							onKeyDown={(event) => {
								if (event.key !== "ArrowDown") return;
								event.preventDefault();
								openMenu();
							}}
						>
							<Ellipsis size={18} />
						</button>
					</div>
					<button
						type="button"
						className="icon-button"
						aria-label={l.previousImage}
						data-hint={l.previousImage}
						aria-keyshortcuts={
							wheelPreferences.axis === "tabs" ? "ArrowLeft PageUp Control+Shift+Tab" : "ArrowLeft PageUp"
						}
						disabled={index <= 0 || query.isFetching}
						onClick={() => step(-1)}
					>
						<ChevronLeft size={18} />
					</button>
					<button
						type="button"
						className="icon-button"
						aria-label={l.nextImage}
						data-hint={l.nextImage}
						aria-keyshortcuts={
							wheelPreferences.axis === "tabs" ? "ArrowRight PageDown Control+Tab" : "ArrowRight PageDown"
						}
						disabled={index >= total - 1 || query.isFetching}
						onClick={() => step(1)}
					>
						<ChevronRight size={18} />
					</button>
					<button
						ref={close}
						type="button"
						className="icon-button"
						aria-label={l.close}
						aria-keyshortcuts="Escape"
						data-hint={l.close}
						onClick={onClose}
					>
						<X size={18} />
					</button>
				</header>
				{menuError && (
					<p className="inline-error" role="alert" data-testid="library-image-action-error">
						{menuError}
					</p>
				)}
				{query.isPending ? (
					<p className="inline-status" role="status">
						{l.loading}
					</p>
				) : query.data?.kind === "image" && query.data.dataUrl && !failed ? (
					<ImageFileDatesContext.Provider value={query.data.imageFileDates}>
						<ImageViewer
							src={query.data.dataUrl}
							fileBytes={image.size}
							location={{ project: root, path: image.path }}
							alt={image.name}
							onError={() => setFailed(true)}
							actions={
								<button
									type="button"
									className="icon-button"
									data-image-fullscreen
									aria-label={fullscreen ? l.leaveFullscreen : l.fullscreen}
									data-hint={fullscreen ? l.leaveFullscreen : l.fullscreen}
									onClick={() => setFullscreen(!fullscreen)}
								>
									{fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
								</button>
							}
						/>
					</ImageFileDatesContext.Provider>
				) : (
					<div className="file-asset-message" role="status">
						<p>{t("asset.imageFailed")}</p>
						{query.error ? <p>{String(query.error)}</p> : query.data?.reason && <p>{query.data.reason}</p>}
						<button type="button" onClick={onOpen}>
							{l.openInFiles}
						</button>
					</div>
				)}
			</dialog>
			{space && (
				<FileSpaceAdd
					project={root}
					entry={space.image}
					fullPath={absoluteFilePath(root, space.image.path, singleFile)}
					trigger={space.trigger}
					onClose={() => setSpace(null)}
				/>
			)}
		</ImageZoom>,
		document.body,
	);
}
