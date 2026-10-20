/** Quick Look-style image browsing keeps the gallery, its filters and scroll position underneath. */
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, FileCode2, FolderSearch, Maximize2, Minimize2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import type { LibraryImage } from "./file-workspace-api";
import { useFileLabels } from "./file-workspace-labels";
import { ImageViewer } from "./image-viewer";

export function ImageLibraryPreview({
	root,
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
	const [fullscreen, setFullscreen] = useState(false);
	const [failed, setFailed] = useState(false);
	const query = useQuery({
		queryKey: ["library-preview", root, image.path, image.modified, image.size],
		queryFn: () => api.preview({ project: root, path: image.path }),
		retry: false,
		gcTime: 0,
		refetchOnWindowFocus: false,
	});
	useEffect(() => {
		setFailed(false);
	}, [image.path, image.modified, image.size]);
	useEffect(() => {
		const element = dialog.current;
		element?.showModal();
		close.current?.focus({ preventScroll: true });
		return () => {
			if (element?.open) element.close();
			if (trigger.isConnected) trigger.focus({ preventScroll: true });
		};
	}, [trigger]);
	return createPortal(
		<dialog
			ref={dialog}
			className={`library-lightbox ${fullscreen ? "fullscreen" : ""}`}
			aria-label={l.imagePreview}
			onCancel={(event) => {
				event.preventDefault();
				onClose();
			}}
			onClose={(event) => {
				if (!event.currentTarget.open) onClose();
			}}
			onKeyDown={(event) => {
				if (event.metaKey || event.ctrlKey || event.altKey) return;
				if ((event.target as HTMLElement).closest("input,textarea,select,[contenteditable]")) return;
				const direction = ["ArrowRight", "PageDown"].includes(event.key)
					? 1
					: ["ArrowLeft", "PageUp"].includes(event.key)
						? -1
						: 0;
				if (!direction) return;
				event.preventDefault();
				if (!query.isFetching) onStep(direction);
			}}
		>
			<header>
				<div className="library-preview-title">
					<strong className="truncate" title={image.path}>
						{image.name}
					</strong>
					<small>
						{index + 1} / {total}
					</small>
				</div>
				<button
					type="button"
					className="icon-button"
					aria-label={l.previousImage}
					title={l.previousImage}
					aria-keyshortcuts="ArrowLeft PageUp"
					disabled={index <= 0 || query.isFetching}
					onClick={() => onStep(-1)}
				>
					<ChevronLeft size={18} />
				</button>
				<button
					type="button"
					className="icon-button"
					aria-label={l.nextImage}
					title={l.nextImage}
					aria-keyshortcuts="ArrowRight PageDown"
					disabled={index >= total - 1 || query.isFetching}
					onClick={() => onStep(1)}
				>
					<ChevronRight size={18} />
				</button>
				<button
					type="button"
					className="icon-button"
					aria-label={l.openInFiles}
					title={l.openInFiles}
					onClick={onOpen}
				>
					<FileCode2 size={16} />
				</button>
				<button
					type="button"
					className="icon-button"
					aria-label={l.revealFile}
					title={l.revealFile}
					onClick={onReveal}
				>
					<FolderSearch size={16} />
				</button>
				<button
					ref={close}
					type="button"
					className="icon-button"
					aria-label={l.close}
					title={l.close}
					onClick={onClose}
				>
					<X size={18} />
				</button>
			</header>
			{query.isPending ? (
				<p className="inline-status" role="status">
					{l.loading}
				</p>
			) : query.data?.kind === "image" && query.data.dataUrl && !failed ? (
				<ImageViewer
					src={query.data.dataUrl}
					alt={image.name}
					onError={() => setFailed(true)}
					actions={
						<button
							type="button"
							className="icon-button"
							aria-label={fullscreen ? l.leaveFullscreen : l.fullscreen}
							title={fullscreen ? l.leaveFullscreen : l.fullscreen}
							onClick={() => setFullscreen(!fullscreen)}
						>
							{fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
						</button>
					}
				/>
			) : (
				<div className="file-asset-message" role="status">
					<p>{t("asset.imageFailed")}</p>
					{query.error ? <p>{String(query.error)}</p> : query.data?.reason && <p>{query.data.reason}</p>}
					<button type="button" onClick={onOpen}>
						{l.openInFiles}
					</button>
				</div>
			)}
		</dialog>,
		document.body,
	);
}
